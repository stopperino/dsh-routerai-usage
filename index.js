/**
 * dsh-routerai-usage - Host half (CONTRACT.md v1).
 *
 * Two data sources:
 *   1. `GET {baseURL}/credits`      -> account balance in RUB (Bearer ROUTERAI_API_KEY).
 *   2. `GET {baseURL}/generation`   -> the real per-request charge in RUB (`data.total_cost`).
 *
 * The per-session registry is folded from `session/event`; the same fold is reused for the
 * cold-session backfill from `sessionQuery.readSession(sessionId)`, so live and replayed
 * sessions produce identical rows.
 *
 * Bridge ops (POST, same-origin only): {describe, rows, refresh} under `/api/dsh-routerai-usage`.
 *
 * Hard rules honoured here:
 *   - no imports at all (plain Node built-ins + ctx services), no runtime dependencies;
 *   - every remote call is wrapped and time-bounded (AbortSignal.timeout);
 *   - the credential is resolved per call through ctx.credentials and never logged or returned;
 *   - every timer and route is registered under ctx.effect and disposed on unload.
 */

const BRIDGE_PREFIX = '/api/dsh-routerai-usage';

// Node built-ins only; the bundle must stay dependency-free (no @deepseek-ai/* imports).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join as joinPath } from 'node:path';

/** 64 KiB, same cap as the in-profile dsh-free-search bridge. */
const MAX_JSON_BODY_BYTES = 64 * 1024;
const DEFAULT_BASE_URL = 'https://routerai.ru/api/v1';
const DEFAULT_POLL_SECONDS = 30;
/**
 * Balance refresh interval while nobody is displaying the widget.
 *
 * `/credits` used to be polled every `pollSeconds` for the entire lifetime of the Host - 2 880
 * requests a day that are completely invisible to the user and perfectly periodic, which is the
 * worst possible traffic shape for an upstream bot filter. The Client polls `/rows` every 1.5 s
 * while its widget is mounted, so "a `rows` call arrived recently" is a free, accurate presence
 * signal: when it goes quiet, stretch the interval instead of hammering.
 */
const DEFAULT_IDLE_POLL_SECONDS = 300;
/**
 * How long one `/models/{model}/endpoints` schedule (the source of peak-hour tariffs) is reused.
 * Provider schedules change on the order of days, so half an hour keeps the extra traffic to two
 * requests an hour per model and still notices a schedule change well within a session.
 */
const DEFAULT_PEAK_REFRESH_SECONDS = 1800;
/** How long one `rows` call keeps the widget considered attended. */
const PRESENCE_TTL_MS = 60_000;
/** Credential *reference* name (not a record key): resolved per call, never cached. */
const CREDENTIAL_REF = 'ROUTERAI_API_KEY';
/** RouterAI balance/usage is returned in rubles (see CONTRACT.md). */
const CURRENCY = 'RUB';
/** Anchored so `${sessionId}:${turn}:${step}` row ids can never match a generation id. */
const GENERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// media generations (images, video, speech, transcription)
// ---------------------------------------------------------------------------

/**
 * RouterAI serves four billable media endpoints, and none of them reports its charge the way a chat
 * completion does:
 *
 *   POST /v1/images               -> no generation id at all; the charge is `usage.cost` in the body
 *   POST /v1/videos               -> async task; the billable id rides in `generation_id`
 *   POST /v1/audio/speech         -> generation id in the `X-Generation-Id` response header
 *   POST /v1/audio/transcriptions -> same header; charge also in `usage.cost`
 *
 * `GET /v1/generation?id=` can price anything that has a generation id, but an image generation has
 * none and RouterAI exposes no ledger endpoint to enumerate past charges (its OpenAPI document lists
 * 28 paths, none of which is a statement: https://routerai.ru/api/openapi.json). So a media charge
 * can only be read from the response the agent actually received, which the Harness records as the
 * `tool/result` of the shell call that made the request. That call/result pair is what this fold
 * prices - the missing piece that made the widget under-report the balance.
 */
const MEDIA_ENDPOINTS = [
  // Longest first: `/audio/transcriptions` must win over the shorter prefixes.
  { path: '/audio/transcriptions', kind: 'transcription' },
  { path: '/audio/speech', kind: 'speech' },
  { path: '/images', kind: 'image' },
  { path: '/videos', kind: 'video' },
];
/**
 * Tools whose output can be an HTTP response body. Detection is limited to these by NAME, so a doc
 * page that merely quotes `POST /v1/images` - a `web_fetch`, a `read` of a saved markdown file - can
 * never be mistaken for a billed generation.
 */
const SHELL_TOOLS = new Set([
  'bash', 'pwsh', 'shell', 'terminal', 'exec', 'run',
  'bash_persistent', 'pwsh_persistent', 'bash-persistent', 'pwsh-persistent',
]);
/**
 * A media body is mostly base64: for an image the `usage` block sits after megabytes of payload, so
 * both ends of a result are scanned. The cap bounds the work on a very large tool result.
 */
const MEDIA_SCAN_LIMIT = 2 * 1024 * 1024;
/** Tool calls kept while waiting for their result. Interrupted calls never resolve. */
const MAX_PENDING_CALLS = 500;
/**
 * `usage` is the object RouterAI puts the ruble charge in for every media endpoint. Matching the
 * pair - not a bare `"cost"` anywhere - is what keeps an unrelated JSON blob (a price table scraped
 * from the docs, say) from being billed to the session.
 */
const USAGE_COST_RE = /["']?usage["']?\s*[:=]\s*\{[^{}]{0,4000}?["']?cost["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)/;
/** `X-Generation-Id: rai-...` as printed by `curl -i`, or a JSON header dump. */
const GENERATION_HEADER_RE = /x-generation-id["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{1,128})/i;
/** Video tasks carry the billable id beside the task id. */
const GENERATION_FIELD_RE = /["']generation_id["']\s*:\s*["']([A-Za-z0-9_-]{1,128})["']/;
/** The async task envelope's own id, which a later poll addresses. */
const TASK_ID_FIELD_RE = /["']id["']\s*:\s*["']([A-Za-z0-9_-]{1,128})["']/;
/** The model that served the request, echoed in the request body or the response. */
const MODEL_FIELD_RE = /["']model["']\s*:\s*["']([^"']{1,200})["']/;
/**
 * Response shapes that identify a media generation even when the command that produced them never
 * names the endpoint - `node gen.js` around a script the agent wrote earlier. Each marker is a field
 * only that endpoint returns, so the false-positive surface stays small:
 *    images        `b64_json` (the base64 payload array element)
 *    video         `unsigned_urls` / `polling_url` (the async task envelope)
 *    transcription `"seconds"` inside `usage` plus a `text` field
 */
const MEDIA_SHAPE_MARKERS = [
  { re: /["']b64_json["']\s*:/, kind: 'image' },
  { re: /["'](?:unsigned_urls|polling_url)["']\s*:/, kind: 'video' },
];
/**
 * Auxiliary model calls the Harness bills to RouterAI but never records as a priced assistant
 * message: session-title generation and compaction summaries. Both log the request and its usage,
 * but neither logs a generation id, so they can be shown but not priced - the "unpriced" state the
 * panel already has for a chat request whose id is missing. Without this they were invisible.
 */
const AUX_EVENT_KINDS = {
  'session/title-llm-request': 'title',
  'compaction/summary': 'compaction',
};

/**
 * In-memory retention for the derived row table. Charges are recomputed from the Harness session
 * log, so this is disposable cache, not a source of truth. The *durable* cache is separate: see
 * PRICE_CACHE_FILE — only settled charge amounts are kept between runs, to keep upstream calls low.
 *
 * There is deliberately NO age-based expiry: a session total must never shrink just because a row
 * got old. Charges are already durable and the whole table is re-fetched after a restart, so aging
 * rows out would only ever change a number the user is reading. Only the size cap below trims, and
 * it trims from the oldest end, which is the least surprising behaviour for a very long session.
 */
const MAX_ROWS_PER_SESSION = 5000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
/**
 * Minimal durable cache of settled per-request charges, keyed by RouterAI generation id.
 *
 * The user asked to minimise traffic to routerai.ru ("мало ли как воспримет это их защита"). A
 * generation id names one immutable, already-billed request, so its `total_cost` never changes and
 * caching it is safe. Only the number is stored — no tokens, no model, no session data — in the
 * Harness state directory next to other plugin state. Written lazily (at most once every
 * CACHE_FLUSH_MS) and capped at CACHE_MAX_ENTRIES; a missing or corrupt file is simply ignored.
 */
const PRICE_CACHE_FILE = 'dsh-routerai-usage-price-cache.json';
/** Plugin-private directory under the Harness cache root; keeps scratch files out of `storages`. */
const PRICE_CACHE_DIR = 'dsh-routerai-usage';
const CACHE_MAX_ENTRIES = 20000;
const CACHE_FLUSH_MS = 15_000;

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function clampInteger(value, fallback, min, max) {
  // `Number(null)` and `Number('')` are 0, not NaN, so a null/blank knob would silently clamp to
  // `min` instead of falling back to its default. Treat "no value" as "use the default".
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const base = typeof raw.baseURL === 'string' && raw.baseURL.trim() ? raw.baseURL.trim() : DEFAULT_BASE_URL;
  return {
    baseURL: base.replace(/\/+$/, ''),
    pollSeconds: clampInteger(raw.pollSeconds, DEFAULT_POLL_SECONDS, 10, 3600),
    // Never faster than the attended interval: idle is a throttle, not a second knob to exceed it.
    idlePollSeconds: Math.max(
      clampInteger(raw.pollSeconds, DEFAULT_POLL_SECONDS, 10, 3600),
      clampInteger(raw.idlePollSeconds, DEFAULT_IDLE_POLL_SECONDS, 10, 3600),
    ),
    // Peak-hour warnings. `peak: false` disables the whole feature and stops the schedule fetches.
    peak: raw.peak !== false,
    peakRefreshSeconds: clampInteger(raw.peakRefreshSeconds, DEFAULT_PEAK_REFRESH_SECONDS, 60, 86_400),
  };
}

// ---------------------------------------------------------------------------
// pure fold: one SessionEvent -> row mutation (no network, no ctx)
// ---------------------------------------------------------------------------

function emptyRow(sessionId, turn, step, time) {
  return {
    id: `${sessionId}:${turn}:${step}`,
    sessionId,
    turn,
    step,
    time,
    provider: 'routerai',
    model: null,
    servedBy: null,
    status: 'pending',
    costRub: null,
    usage: null,
    latencyMs: null,
    error: null,
    generationId: null,
    lookup: 'idle',
    // `chat` for an assistant message, `image`/`video`/`speech`/`transcription` for a media
    // generation the agent made through a shell call, `title`/`compaction` for the auxiliary model
    // calls the Harness bills on its own. The Client groups by this, so it must be serialized.
    kind: 'chat',
  };
}

function rowKey(sessionId, turn, step) {
  return `${sessionId}:${turn}:${step}`;
}

function isModelEvent(event) {
  const data = event && event.data;
  const source = data && data.message && data.message.source;
  return Boolean(source) && source.kind === 'model';
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readGenerationId(source) {
  const response = source && source.replayState && source.replayState.response;
  const id = response && response.responseId;
  // Token-shaped ids only: a malformed value becomes an explicit `unpriced` row instead of a
  // confusing upstream 404.
  return typeof id === 'string' && GENERATION_ID_RE.test(id) ? id : null;
}

function readUsage(usage) {
  if (!isPlainObject(usage)) return null;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cached = num(usage.cacheReadTokens);
  const reasoning = num(usage.reasoningTokens);
  // `total` is RouterAI's totalTokens: it includes cached tokens and may exceed input+output.
  const total = num(usage.totalTokens) ?? (input === null && output === null ? null : (input ?? 0) + (output ?? 0));
  return { input, output, cached, reasoning, total };
}

// -- media generation detection (pure) --------------------------------------

/**
 * Whether one tool call could have issued a RouterAI media request, and which endpoint it aimed at
 * when the command says so.
 *
 * Two independent gates:
 *   1. the tool is a shell - the only kind whose result is a raw HTTP response body. A `web_fetch` or
 *      a `read` that merely quotes `POST /v1/images` is never a billed generation;
 *   2. the command WRITES, or it POLLS a task it created earlier. A write is `-d`/`--data`/`-F`/
 *      `-X POST`/`-Method Post`/`method: 'POST'`. A poll is a plain GET of `/v1/videos/{id}`.
 *
 * Gate 2 is what keeps "the agent read the docs" from becoming "the agent generated an image": a
 * page that merely quotes a `usage.cost` example carries no write verb and no task poll. A GET is
 * accepted only for the video task path, because that is the one media endpoint whose charge arrives
 * out of band; every other media endpoint reports its cost in the same response that generated it.
 *
 * The endpoint name is a *hint*, not a requirement: a script run as `node gen.js` reveals nothing, and
 * the response-shape check in `applyMediaResult` covers that case.
 */
const WRITE_VERB_RE = /(?:\s-d\s|\s--data(?:-raw|-binary|-urlencode)?\s|\s-F\s|\s--form\s|-X\s*(?:POST|PUT|PATCH)\b|-Method\s+(?:Post|Put|Patch)\b|["']?method["']?\s*[:=]\s*["']?(?:POST|PUT|PATCH)\b)/i;
/** `GET /v1/videos/<taskId>` - the one read that settles a charge. */
const VIDEO_POLL_RE = /\/videos\/[A-Za-z0-9_-]{2,}/;

function mediaIntentOf(name, argumentsText) {
  const toolName = typeof name === 'string' ? name.toLowerCase() : '';
  const base = toolName.includes('.') ? toolName.slice(toolName.lastIndexOf('.') + 1) : toolName;
  if (!SHELL_TOOLS.has(toolName) && !SHELL_TOOLS.has(base)) return null;
  if (typeof argumentsText !== 'string' || argumentsText === '') return null;

  const sendsHttp = /\b(?:curl|wget|Invoke-RestMethod|Invoke-WebRequest|WebRequest|https?:\/\/|fetch\(|axios|requests\.(?:post|get))/i
    .test(argumentsText);
  if (!sendsHttp) return null;

  // The LAST media endpoint mentioned is the one the command aims at (`curl ... /images` after a
  // comment that mentions `/videos` must classify as an image request).
  let hint = null;
  let hintAt = -1;
  for (const endpoint of MEDIA_ENDPOINTS) {
    const at = argumentsText.lastIndexOf(endpoint.path);
    if (at > hintAt) {
      hintAt = at;
      hint = endpoint.kind;
    }
  }

  if (WRITE_VERB_RE.test(argumentsText)) return { hint, poll: false };
  // A poll only makes sense against a task this session created; the row for that task already
  // exists, so the result settles it instead of creating a second one.
  if (VIDEO_POLL_RE.test(argumentsText)) return { hint: 'video', poll: true };
  return null;
}

/**
 * One text blob of a tool result, for scanning. Content is normally `[{type:'text',text}]`; a result
 * that carries an image or file block contributes no text and is skipped by the caller.
 */
function resultText(message) {
  if (!isPlainObject(message) || !Array.isArray(message.content)) return '';
  let text = '';
  for (const block of message.content) {
    if (isPlainObject(block) && typeof block.text === 'string') text += `\n${block.text}`;
  }
  return text;
}

/** Both ends of a possibly huge body, so a `usage` block after megabytes of base64 is still found. */
function mediaScanText(text) {
  if (text.length <= MEDIA_SCAN_LIMIT) return text;
  const half = Math.floor(MEDIA_SCAN_LIMIT / 2);
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

/**
 * Which media generation one tool result reports, or null when it reports none.
 *
 * The decision is made from the RESPONSE first: a field only one endpoint returns wins over the
 * command's hint, because a hint is a guess about intent while a `b64_json` is a fact about output.
 * The hint then covers the case where the shape is generic, and `media` is the honest label when a
 * charge is present but nothing identifies the endpoint.
 */
function mediaKindOf(scanned, hint) {
  for (const marker of MEDIA_SHAPE_MARKERS) {
    if (marker.re.test(scanned)) return { kind: marker.kind, confident: true };
  }
  if (typeof hint === 'string' && hint !== '') return { kind: hint, confident: true };
  // A charged `usage` block with no recognizable payload: still a media generation, but the endpoint
  // is unknown. `media` keeps it in the panel's media section without claiming a specific kind.
  return { kind: 'media', confident: false };
}

/**
 * The ruble charge a media response reports, or null.
 *
 * Reads `usage.cost` from the response body, which is where images, speech and transcription put it,
 * and where a video poll puts it once the task completes. A number is only accepted when it is
 * finite and non-negative: RouterAI has never charged a negative amount, and a `-1` sentinel in some
 * unrelated field must not become a credit.
 */
function readMediaCharge(text) {
  if (typeof text !== 'string' || text === '') return null;
  const match = mediaScanText(text).match(USAGE_COST_RE);
  if (match === null) return null;
  const cost = Number(match[1]);
  if (!Number.isFinite(cost) || cost < 0) return null;
  return cost;
}

/** A generation id the response names in a header or in `generation_id`, or null. */
function readMediaGenerationId(text) {
  if (typeof text !== 'string' || text === '') return null;
  const scanned = mediaScanText(text);
  const header = scanned.match(GENERATION_HEADER_RE);
  if (header !== null) return header[1];
  const field = scanned.match(GENERATION_FIELD_RE);
  return field === null ? null : field[1];
}

/** The model a media request names, so the panel can break the spend down by model. */
function readMediaModel(requestText, resultTxt) {
  const fromRequest = typeof requestText === 'string' ? requestText.match(MODEL_FIELD_RE) : null;
  if (fromRequest !== null) return fromRequest[1];
  const fromResult = typeof resultTxt === 'string' ? resultTxt.match(MODEL_FIELD_RE) : null;
  return fromResult === null ? null : fromResult[1];
}

/**
 * Fold one session event into `state`.
 *
 * `state` is the same structure that `readSession` replay builds, so a cold backfill and a live
 * fold agree by construction. Returns the registry row that changed, or null.
 *
 * @param {{rows: Map<string, object>, current: object|null, maxSeq: number}} state
 */
function applyEvent(state, sessionId, event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.seq === 'number' && Number.isFinite(event.seq) && event.seq > state.maxSeq) {
    state.maxSeq = event.seq;
  }
  const data = isPlainObject(event.data) ? event.data : null;
  if (!data) return null;

  if (event.type === 'request/header') {
    const header = isPlainObject(data.header) ? data.header : null;
    const cfg = header && isPlainObject(header.config) ? header.config : null;
    if (!cfg) return null;
    state.current = {
      provider: typeof cfg.provider === 'string' && cfg.provider ? cfg.provider : null,
      model: typeof cfg.model === 'string' && cfg.model ? cfg.model : null,
      turn: null,
      step: null,
    };
    return null;
  }

  // -- media generations ---------------------------------------------------
  // A `tool/call` that could have issued a RouterAI media request is remembered here and settled
  // when its `tool/result` arrives. Rows are keyed by the call id, not by `turn:step`, because one
  // step can issue several tool calls and each is a separate billable generation.
  if (event.type === 'tool/call') {
    const callId = typeof data.callId === 'string' && data.callId ? data.callId : null;
    if (!callId) return null;
    const intent = mediaIntentOf(data.name, data.arguments);
    if (intent === null) return null;
    state.pendingCalls.set(callId, {
      hint: intent.hint,
      poll: intent.poll === true,
      arguments: typeof data.arguments === 'string' ? data.arguments : '',
      turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : null,
      step: Number.isFinite(Number(data.step)) ? Number(data.step) : null,
      time: Number.isFinite(event.time) ? event.time : Date.now(),
    });
    // Bounded: an interrupted call never produces a result, so the map would otherwise grow for the
    // life of the session. Map preserves insertion order, so the first key is the oldest.
    if (state.pendingCalls.size > MAX_PENDING_CALLS) {
      const oldest = state.pendingCalls.keys().next();
      if (!oldest.done) state.pendingCalls.delete(oldest.value);
    }
    return null;
  }

  if (event.type === 'tool/result') {
    const message = isPlainObject(data.message) ? data.message : null;
    const callId = message && typeof message.toolCallId === 'string' ? message.toolCallId : null;
    if (!callId) return null;
    const call = state.pendingCalls.get(callId);
    if (call === undefined) return null;
    state.pendingCalls.delete(callId);
    return applyMediaResult(state, sessionId, callId, call, message, event);
  }

  // -- auxiliary billed model calls ----------------------------------------
  // Session titles and compaction summaries are real RouterAI charges that are never logged as a
  // priced assistant message, so without this they would silently inflate the balance gap.
  const auxKind = AUX_EVENT_KINDS[event.type];
  if (auxKind !== undefined) {
    const key = `${sessionId}:aux:${event.type}:${event.seq ?? state.maxSeq}`;
    let row = state.rows.get(key);
    if (!row) {
      row = emptyRow(sessionId, null, null, Number.isFinite(event.time) ? event.time : Date.now());
      row.id = key;
      row.kind = auxKind;
      state.rows.set(key, row);
    }
    const route = isPlainObject(data.route) ? data.route : null;
    const source = isPlainObject(data.source) ? data.source : null;
    row.provider = (route && typeof route.provider === 'string' && route.provider)
      || (source && typeof source.provider === 'string' && source.provider)
      || 'routerai';
    row.model = (route && typeof route.model === 'string' && route.model)
      || (source && isPlainObject(source.model) && typeof source.model.model === 'string' ? source.model.model : null)
      || row.model;
    // Neither event records a generation id: the title/compaction API does not surface one. The row
    // is therefore shown as a real but unpriced charge instead of being dropped.
    if (row.status !== 'resolved' && row.lookup !== 'done') {
      row.status = 'unpriced';
      row.costRub = null;
      row.lookup = 'done';
      row.error = null;
    }
    return row;
  }

  if (event.type !== 'assistant/message') return null;
  // A non-model assistant message (and an interrupted one) is not a billable request.
  if (!isModelEvent(event)) return null;
  if (data.interrupted === true) return null;

  const turn = Number.isFinite(Number(data.turn)) ? Number(data.turn) : null;
  const step = Number.isFinite(Number(data.step)) ? Number(data.step) : null;
  if (turn === null || step === null) return null;

  if (!state.current || state.current.turn !== turn || state.current.step !== step) {
    // Steps 2..N of a turn do not re-emit `request/header`; inherit the turn's series config.
    state.current = {
      provider: state.current ? state.current.provider : null,
      model: state.current ? state.current.model : null,
      turn,
      step,
    };
  }

  const key = rowKey(sessionId, turn, step);
  const time = Number.isFinite(event.time) ? event.time : Date.now();
  let row = state.rows.get(key);
  if (!row) {
    row = emptyRow(sessionId, turn, step, time);
    state.rows.set(key, row);
  }

  const source = data.message && data.message.source ? data.message.source : null;
  const provider = (source && typeof source.provider === 'string' && source.provider) || state.current.provider || null;
  const model = (source && typeof source.model === 'string' && source.model) || state.current.model || null;
  const generationId = readGenerationId(source);
  const usage = readUsage(data.usage);

  row.time = time;
  row.provider = provider || 'routerai';
  row.model = model;
  row.usage = usage;
  if (generationId) row.generationId = generationId;

  if (provider !== 'routerai') {
    // Another provider's request - RouterAI cannot price it, and the balance must not absorb it.
    row.status = 'unpriced';
    row.costRub = null;
    row.error = null;
    row.servedBy = null;
    row.lookup = generationId ? 'done' : 'idle';
    return row;
  }
  if (!generationId) {
    row.status = 'unpriced';
    row.costRub = null;
    row.error = null;
    row.lookup = 'idle';
    return row;
  }

  if (row.status === 'resolved' || row.status === 'error') {
    // Backfill replayed a row that the live fold already priced or already failed: keep BOTH the
    // status and its `costRub`. Clearing the cost first would leave `resolved` with a null cost,
    // which is counted by neither `calls` nor `unpriced` and silently understates the total.
    return row;
  }
  if (row.lookup === 'inflight' || row.lookup === 'done') {
    // A backfill replay (or a repeated event) must not re-queue a row this plugin already owns:
    // re-queueing a priced row would fetch and count the same charge twice.
    return row;
  }
  // Only a row that is genuinely still awaiting its charge is reset.
  row.costRub = null;
  row.error = null;
  row.status = 'pending';
  return row;
}

/**
 * Settle one media generation from the tool result the agent received.
 *
 * The rule that decides whether a row exists at all: a media row is created only when the response
 * proves something was generated - a `usage.cost`, a generation id, or a media payload. A rejected
 * request (RouterAI does not charge those), a non-media shell call, or an unrelated page never makes
 * a row, so the panel cannot invent spend that never happened.
 *
 * Once a row exists, its status says what is known:
 *   - `resolved` - the response reported the ruble charge
 *   - `pending`  - a video task is still running; the id lookup prices it when it settles
 *   - `unpriced` - a generation happened but this response never stated its cost
 *
 * Replaying the same events (cold backfill) must be idempotent, so an already-`resolved` row is never
 * re-derived: a video create response carries no charge, and re-applying it after a later poll had
 * priced the row would otherwise erase the amount.
 */
function applyMediaResult(state, sessionId, callId, call, message, event) {
  const text = resultText(message);
  const scanned = mediaScanText(text);
  const cost = readMediaCharge(text);
  const generationId = readMediaGenerationId(text);
  const failed = message.isError === true;
  const media = mediaKindOf(scanned, call.hint);
  const pendingVideo = media.kind === 'video'
    && /\b(?:in_progress|pending|queued|processing)\b/i.test(scanned);

  // A poll addresses a task this session already created, so its result belongs to that row. Matching
  // by the task id keeps a completed poll from opening a second row for the same generation.
  const taskId = typeof text === 'string' ? text.match(TASK_ID_FIELD_RE) : null;
  const existing = call.poll === true
    ? findRowByTaskId(state, taskId === null ? null : taskId[1], sessionId)
    : undefined;
  if (call.poll === true && existing === undefined) return null;

  // Nothing was generated: no charge, no id, no payload. This is the gate that keeps a failed
  // request, a docs page quoting the endpoint, or an unrelated API call out of the bill entirely.
  // A `hint` alone is deliberately NOT enough - the command must have named a media endpoint AND the
  // response must look like that endpoint's envelope.
  const billed = typeof cost === 'number' || generationId !== null;
  if (!billed && !pendingVideo && !(media.confident && hasMediaPayload(scanned))) return null;
  if (failed && !billed) return null;

  const key = `${sessionId}:media:${callId}`;
  const time = Number.isFinite(event.time) ? event.time : call.time;
  let row = existing !== undefined ? existing : state.rows.get(key);
  if (row === undefined) {
    row = emptyRow(sessionId, call.turn, call.step, time);
    row.id = key;
    row.kind = media.kind;
    state.rows.set(key, row);
  }
  if (row.status === 'resolved') return row; // already priced: a replay must not undo it

  // A poll settles the task's own timestamp, not the poll's: the charge belongs to the moment the
  // generation was requested, which is what the panel is reading in chronological order.
  if (existing === undefined) row.time = time;
  row.provider = 'routerai';
  row.model = readMediaModel(call.arguments, text) || row.model;
  if (generationId) row.generationId = generationId;
  // The task id is kept so a later poll can find this row again in a cold replay, where the create
  // and the poll arrive in one pass and `pendingCalls` no longer holds the create.
  if (call.poll !== true && media.kind === 'video' && taskId !== null && row.taskId === undefined) {
    row.taskId = taskId[1];
  }

  if (typeof cost === 'number') {
    row.status = 'resolved';
    row.costRub = cost;
    row.error = null;
    row.lookup = 'done';
    row.lookupCode = null;
    row.lookupStatus = undefined;
    // Priced from its own response, so this row must never be re-fetched by id: an image generation
    // has no id at all, and a video task id is not a generation id.
    return row;
  }

  if (pendingVideo) {
    // The task exists but is not finished: `POST /v1/videos` only creates it. The ordinary id lookup
    // prices it later from `generation_id`; the task id itself is not a generation id and would 404.
    if (row.generationId) {
      row.status = 'pending';
      row.costRub = null;
      row.error = null;
      row.lookup = 'idle';
      return row;
    }
    // Without a generation id there is nothing to ask later, but the task is still pending, so the
    // row must stay visible and settleable by a later poll rather than being written off now.
    row.status = 'pending';
    row.costRub = null;
    row.error = null;
    row.lookup = 'done';
    return row;
  }

  // A completed poll that reports no charge cannot be priced after the fact, so it is settled as
  // unpriced - but only when the row was actually waiting for it.
  return markUnpriced(row, call.poll === true ? 'video poll reported no cost' : 'media response carried no cost');
}

/** The row a video task id already owns, so a poll settles it instead of opening a second one. */
function findRowByTaskId(state, taskId, sessionId) {
  if (typeof taskId !== 'string' || taskId === '') return undefined;
  const ownKey = `${sessionId}:media:${taskId}`;
  const direct = state.rows.get(ownKey);
  if (direct !== undefined) return direct;
  for (const row of state.rows.values()) {
    if (row.taskId === taskId) return row;
    if (row.kind === 'video' && row.id.endsWith(`:${taskId}`)) return row;
  }
  return undefined;
}

/**
 * Whether a body actually carries media payload or an explicit cost block, as opposed to merely
 * mentioning a media endpoint in prose. Used to decide that a charged-looking shell result is a real
 * generation before a row is created for it.
 */
function hasMediaPayload(scanned) {
  return /["'](?:b64_json|unsigned_urls|polling_url|generation_id|created)["']\s*:/.test(scanned)
    || /["']?usage["']?\s*[:=]\s*\{/.test(scanned)
    || /x-generation-id/i.test(scanned);
}

/** One place that turns a row into the "accounted for, amount unknown" state. */
function markUnpriced(row, reason) {
  row.status = 'unpriced';
  row.costRub = null;
  row.error = reason || null;
  row.lookup = 'done';
  return row;
}

/**
 * Row order for every consumer: turn then step, with time as the tie-break.
 *
 * Media rows share their tool call's turn/step and auxiliary rows have neither, so a plain numeric
 * subtraction would sort `null` steps ahead of real ones. Ordering by time in that case keeps the
 * list chronological, which is what the panel reads.
 */
function orderedRows(state) {
  const rank = (row) => (Number.isFinite(row.turn) && Number.isFinite(row.step) ? 0 : 1);
  return [...state.rows.values()].sort((a, b) => (rank(a) - rank(b))
    || (rank(a) === 0 ? (a.turn - b.turn) || (a.step - b.step) : 0)
    || ((a.time || 0) - (b.time || 0))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function roundRub(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

function serializeRow(row) {
  let status = row.status;
  // `lookup: 'idle'` means "a generation id is known and the charge has not been fetched yet" -
  // that is *pending*, not unpriced. Only a row that can never be priced is `unpriced`.
  if (status === 'pending' && !row.generationId) status = 'unpriced';
  return {
    id: row.id,
    sessionId: row.sessionId,
    turn: row.turn,
    step: row.step,
    time: row.time,
    provider: row.provider || 'routerai',
    model: row.model,
    servedBy: row.servedBy,
    // `chat` for a model completion, `image`/`video`/`speech`/`transcription` for a media generation
    // the agent requested through a shell call, `title`/`compaction` for the Harness's own auxiliary
    // model calls. The Client groups by this, so it travels with every row.
    kind: typeof row.kind === 'string' && row.kind ? row.kind : 'chat',
    status,
    costRub: row.costRub === null || row.costRub === undefined ? null : row.costRub,
    usage: row.usage
      ? {
        input: row.usage.input,
        output: row.usage.output,
        cached: row.usage.cached,
        reasoning: row.usage.reasoning,
        total: row.usage.total,
      }
      : null,
    latencyMs: row.latencyMs,
    error: row.error,
    // Diagnostic only: the upstream HTTP status behind an `error` row (429 vs 404 is the difference
    // between "retrying" and "permanently unknown").
    lookupStatus: typeof row.lookupStatus === 'number' ? row.lookupStatus : null,
  };
}

function totalsFor(rows) {
  let amountRub = 0;
  let calls = 0;
  let unpriced = 0;
  for (const row of rows) {
    if (typeof row.costRub === 'number' && Number.isFinite(row.costRub)) {
      amountRub += row.costRub;
      calls += 1;
    } else {
      // Anything without a numeric charge counts as accounted-for-but-unpriced, so `calls` and
      // `unpriced` always add up to the number of rows the Client is shown.
      unpriced += 1;
    }
  }
  return { amountRub: roundRub(amountRub) ?? 0, calls, unpriced };
}

/**
 * Aggregate rows into `{total, own, children, byProvider, byModel, byKind}` (CONTRACT-v2.md).
 *
 * `own`/`children` are split by the owning session id so the Client can tell the user how much of
 * the spend came from subagents; `byKind` separates chat completions from media generations and the
 * Harness's own auxiliary calls, which is what makes "the widget under-counts my balance" legible.
 * Pure: takes serialized rows plus the set of child session ids.
 */
function statsFor(rows, rootSessionId, childSessionIds) {
  const isChild = (row) => childSessionIds.has(row.sessionId);
  const own = totalsFor(rows.filter((row) => !isChild(row)));
  const children = totalsFor(rows.filter((row) => isChild(row)));

  const byKey = (pick) => {
    const groups = new Map();
    for (const row of rows) {
      const key = pick(row) || '(unknown)';
      let group = groups.get(key);
      if (!group) {
        group = { key, calls: 0, amountRub: 0, unpriced: 0, input: 0, output: 0 };
        groups.set(key, group);
      }
      if (typeof row.costRub === 'number' && Number.isFinite(row.costRub)) {
        group.calls += 1;
        group.amountRub += row.costRub;
      } else {
        group.unpriced += 1;
      }
      if (row.usage) {
        if (typeof row.usage.input === 'number') group.input += row.usage.input;
        if (typeof row.usage.output === 'number') group.output += row.usage.output;
      }
    }
    return [...groups.values()]
      .map((group) => ({ ...group, amountRub: roundRub(group.amountRub) ?? 0 }))
      .sort((a, b) => (b.amountRub - a.amountRub) || (b.calls - a.calls) || a.key.localeCompare(b.key));
  };

  // Rounding each subtotal independently can break `own + children === total` by 1e-6, so the total
  // is derived from the rounded parts instead of from a third independent sum.
  const ownRounded = { ...own, amountRub: roundRub(own.amountRub) ?? 0 };
  const childrenRounded = { ...children, amountRub: roundRub(children.amountRub) ?? 0 };
  const total = {
    amountRub: roundRub(ownRounded.amountRub + childrenRounded.amountRub) ?? 0,
    calls: ownRounded.calls + childrenRounded.calls,
    unpriced: ownRounded.unpriced + childrenRounded.unpriced,
  };

  return {
    root: rootSessionId,
    total,
    own: ownRounded,
    children: childrenRounded,
    byProvider: byKey((row) => row.servedBy || row.provider),
    byModel: byKey((row) => row.model),
    // Always sorted by amount so the panel can render it without deciding an order, and always
    // present (empty when there is nothing but chat completions).
    byKind: byKey((row) => (row.kind === 'chat' || !row.kind ? null : row.kind))
      .filter((group) => group.key !== '(unknown)'),
  };
}

// ---------------------------------------------------------------------------
// bridge request guard (same rule as the in-profile dsh-free-search bundle)
// ---------------------------------------------------------------------------

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return null;
  }
}

function isLoopbackAddress(address) {
  const value = String(address ?? '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' || /^127\./.test(value);
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isBridgeRequestAllowed(request) {
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === null) return false;
  // Cross-site initiations are rejected outright (confused-deputy fence).
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  if (isLoopbackHostname(hostUrl.hostname)) return isLoopbackAddress(request.socket && request.socket.remoteAddress);
  // Directly bound non-loopback address: the Host header is that bind address.
  const localAddress = request.socket && request.socket.localAddress;
  if (typeof localAddress === 'string' && localAddress !== '0.0.0.0' && localAddress !== '::') {
    const local = parseAuthority(localAddress.includes(':') ? `[${localAddress}]` : localAddress);
    if (local !== null && local.hostname === hostUrl.hostname) return true;
  }
  return false;
}

function writeJson(res, status, body) {
  let payload;
  try {
    payload = JSON.stringify(body);
  } catch {
    payload = JSON.stringify({ ok: false, code: 'internal', message: 'response was not serializable' });
    status = 500;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk;
      size += buffer.length;
      if (size > MAX_JSON_BODY_BYTES) return undefined;
      chunks.push(buffer);
    }
  } catch {
    return undefined;
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// peak-hour pricing (pure: RouterAI endpoint schedule -> multiplier)
// ---------------------------------------------------------------------------

/**
 * RouterAI publishes each provider's time-of-day tariff bands in
 * `GET /api/v1/models/{author}/{model}/endpoints`, inside `variable_pricings`:
 *
 *   { "type": "time-of-day", "utc_start": 100, "utc_end": 400,
 *     "utc_days": ["monday", ...], "prompt": 3.469e-5, "completion": 1.388e-4 }
 *
 * `utc_start`/`utc_end` are HHMM integers in UTC (100 = 01:00); the band wraps past midnight when
 * `utc_end <= utc_start` (1000 -> 0 means 10:00 until midnight). `utc_days` limits the band to those
 * UTC weekdays and is absent for "every day". A band's `prompt`/`completion` are absolute prices, so
 * the schedule is read as a price function rather than as a "peak" flag: some providers publish an
 * expensive base price plus cheaper bands (BytePlus), others a cheap base plus surcharge bands
 * (DeepSeek). Comparing each band against the week's cheapest price gives one multiplier definition
 * that is correct for both shapes.
 *
 * Everything here is pure so the decoding can be exercised without a network or a live Host.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Minutes since UTC midnight for an HHMM integer, clamped to a valid day. */
function hhmmToMinutes(value) {
  if (!Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  if (n < 0) return null;
  const hours = Math.floor(n / 100);
  const minutes = n % 100;
  if (hours > 24 || minutes > 59) return null;
  return Math.min(hours * 60 + minutes, 24 * 60);
}

/** The price a band charges for one unit, preferring prompt tokens and falling back to output. */
function bandPrice(band) {
  if (!isPlainObject(band)) return null;
  for (const key of ['prompt', 'completion']) {
    const value = band[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { key, value };
  }
  return null;
}

/**
 * Normalise one endpoint's `variable_pricings` into bands that can be evaluated at any instant.
 * Bands without a usable price or window are dropped: an unparseable schedule must degrade to
 * "no peak information", never to a false warning.
 */
function readTariffBands(endpoint) {
  const raw = endpoint && Array.isArray(endpoint.variable_pricings) ? endpoint.variable_pricings : [];
  const bands = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || entry.type !== 'time-of-day') continue;
    const priced = bandPrice(entry);
    if (priced === null) continue;
    const start = hhmmToMinutes(entry.utc_start);
    const end = hhmmToMinutes(entry.utc_end);
    if (start === null || end === null) continue;
    let days = null;
    if (Array.isArray(entry.utc_days) && entry.utc_days.length > 0) {
      days = entry.utc_days
        .filter((day) => typeof day === 'string')
        .map((day) => day.toLowerCase())
        .filter((day) => WEEKDAYS.includes(day));
      if (days.length === 0) continue;
    }
    bands.push({ start, end, days, price: priced.value, priceKey: priced.key });
  }
  return bands;
}

/** True when `minute` falls in [start, end), following the band across midnight when it wraps. */
function bandCoversMinute(band, minute) {
  if (band.start === band.end) return false;
  if (band.end > band.start) return minute >= band.start && minute < band.end;
  return minute >= band.start || minute < band.end;
}

/**
 * Price per token the schedule charges at `at`.
 * @returns {{price: number, band: object|null}} the band's price, or the cheapest published band
 *   when no band covers the instant (schedule gaps exist: DeepSeek is priced off-peak between
 *   04:00 and 06:00 UTC but RouterAI models that as `0-100`, `100-400`, `400-600`, ... so a gap
 *   should not happen; if it does, the cheapest band is the safest floor).
 */
function priceAt(bands, at) {
  if (bands.length === 0) return null;
  const dayIndex = at.getUTCDay();
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  for (const band of bands) {
    if (band.days !== null && !band.days.includes(WEEKDAYS[dayIndex])) continue;
    if (bandCoversMinute(band, minute)) return { price: band.price, band };
  }
  let cheapest = bands[0];
  for (const band of bands) if (band.price < cheapest.price) cheapest = band;
  return { price: cheapest.price, band: null };
}

/** Cheapest price any band charges during a week — the baseline a multiplier is measured against. */
function cheapestBandPrice(bands) {
  let cheapest = null;
  for (const band of bands) {
    // A band restricted to days cannot be cheaper than the weekly floor; ignoring `days` only ever
    // lowers the floor, which errs toward not reporting a peak. Both are safe, but including the
    // band is more accurate when every band is day-restricted.
    if (cheapest === null || band.price < cheapest) cheapest = band.price;
  }
  return cheapest;
}

/**
 * How much more expensive the next `lookaheadMs` are than the week's cheapest rate, and when that
 * premium ends.
 *
 * The multiplier is `priceNow / cheapestWeekPrice`, so a provider whose base price is already
 * expensive and whose bands are discounts (BytePlus) reports no surcharge, while DeepSeek's ×2
 * peak bands report 2. Scanning forward rather than only looking at "now" means the end of the
 * window is known even when the schedule has a gap.
 */
function evaluatePeak(bands, now, lookaheadMs = 36 * 60 * 60 * 1000, stepMs = 5 * 60 * 1000) {
  const floor = cheapestBandPrice(bands);
  const current = priceAt(bands, now);
  if (floor === null || floor <= 0 || current === null) return null;
  const multiplier = current.price / floor;
  // A multiplier of 1 means either no band is active or the active band is the cheapest one.
  if (!(multiplier > 1)) {
    return { active: false, multiplier: 1, endsAt: null, priceKey: current.band ? current.band.priceKey : null };
  }
  let endsAt = null;
  for (let offset = stepMs; offset <= lookaheadMs; offset += stepMs) {
    const probe = priceAt(bands, new Date(now.getTime() + offset));
    if (probe === null) break;
    if (probe.price / floor <= 1) {
      endsAt = now.getTime() + offset;
      break;
    }
  }
  return {
    active: true,
    multiplier: Math.round(multiplier * 100) / 100,
    endsAt,
    priceKey: current.band ? current.band.priceKey : null,
  };
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/** Directory the Harness keeps profile-independent plugin state in. */
function resolveStateDir() {
  // Documented per-plugin cache root is $DSH_HOME/cache/<plugin>. The price cache used to be
  // written straight into $DSH_HOME/storages, which is the typed domain-data root shared with other
  // plugins' units (workspace.json, session caches, ...): a plugin-owned scratch file does not
  // belong there. DSH_HOME wins first, then the profile-local dir, then the platform user-data area.
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim()) return joinPath(home.trim(), 'cache', PRICE_CACHE_DIR);
  const profile = process.env.DSH_PROFILE_DIR;
  if (typeof profile === 'string' && profile.trim()) return joinPath(profile.trim(), '.routerai-usage');
  // Last resort: the platform user-data area, still outside a plugin-owned package.
  try {
    const local = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || process.env.HOME;
    if (typeof local === 'string' && local.trim()) return joinPath(local.trim(), PRICE_CACHE_DIR);
  } catch {
    /* ignore */
  }
  return null;
}

const name = 'routerai-usage';
/**
 * `webServer` is the one hard dependency: the route must be registered after the HTTP carrier
 * exists, and a Cordis effect does not re-run when a service appears later. `timer` is NOT
 * injected (its row reports `absent` in this profile) and neither are `credentials` nor
 * `sessionQuery`: both are reached with ctx.get + an undefined check at call time, so a late or
 * missing service degrades the widget instead of keeping the whole plugin inactive.
 */
const inject = ['webServer'];

function apply(ctx, config) {
  const settings = resolveConfig(config);
  // Cordis hides a service's properties until it is injected, so `ctx.logger` throws here unless the
  // entry declares the dependency. Logging is not worth a hard dependency: feature-detect it.
  let logger;
  try {
    logger = ctx.logger;
  } catch {
    logger = undefined;
  }
  const sessions = new Map(); // sessionId -> { rows: Map, current, maxSeq, backfilled, backfilling }
  const inflight = new Map(); // generationId -> Promise<{costRub, provider, latencyMs, usage} | null>
  let lastSweep = Date.now();
  let balance = { amount: null, updatedAt: null, status: 'loading', error: null };
  /**
   * Last time the Client asked for `rows` (i.e. its widget is mounted and polling).
   * `0` means "never seen", which counts as idle: nobody is watching, so do not poll fast.
   */
  let lastPresenceAt = 0;
  /** Set by the balance poller so an arriving Client can re-arm it immediately (see notePresence). */
  let onBecameAttended = null;
  const notePresence = () => {
    const wasIdle = !isAttended();
    lastPresenceAt = Date.now();
    // First contact after an idle stretch: collapse the remaining idle wait instead of leaving the
    // freshly opened widget staring at a stale balance for up to `idlePollSeconds`.
    if (wasIdle && typeof onBecameAttended === 'function') {
      try {
        onBecameAttended();
      } catch { /* re-arming is best-effort */ }
    }
  };
  const isAttended = () => Date.now() - lastPresenceAt < PRESENCE_TTL_MS;

  const warn = (message) => {
    try {
      logger?.warn?.(`${name}: ${message}`);
    } catch { /* logging must never break the plugin */ }
  };

  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        rows: new Map(),
        // `tool/call` records awaiting their `tool/result`, keyed by call id: a media generation is
        // only known to be billable once its response arrives.
        pendingCalls: new Map(),
        current: null,
        maxSeq: -1,
        backfilled: false,
        backfilling: null,
      };

      sessions.set(sessionId, state);
    }
    return state;
  };

  const summarize = (row) => {
    // Never include credential material; only the public generation id and the remote message.
    const summary = { code: row.lookupCode || 'lookup-failed', generationId: row.generationId, message: row.error };
    if (row.lookupStatus !== undefined) summary.status = row.lookupStatus;
    return JSON.stringify(summary).slice(0, 400);
  };

  const onGenerationFailed = (row) => {
    if (row.lookup !== 'failed') return;
    warn(`generation lookup failed for ${row.id}: ${summarize(row)}`);
  };

  // -- peak-hour schedules ---------------------------------------------------
  // Provider tariff bands come from `/models/{model}/endpoints`, which needs no credential, so this
  // works even before the user configures a key. One entry per model, refreshed at most every
  // `peakRefreshSeconds`; a failed fetch is remembered for the same period so a broken network does
  // not turn the balance poll into an endpoint scrape.
  const schedules = new Map(); // model -> { at:number, bands:object[], error:string|null }
  let scheduleInFlight = null;

  const readSchedule = async (model) => {
    const cached = schedules.get(model);
    const ttl = settings.peakRefreshSeconds * 1000;
    if (cached !== undefined && Date.now() - cached.at < ttl) return cached;
    const url = `${settings.baseURL}/models/${model}/endpoints`;
    let entry;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const endpoints = body && body.data && Array.isArray(body.data.endpoints) ? body.data.endpoints : null;
      if (!response.ok || endpoints === null) {
        entry = { at: Date.now(), providerOrder: [], byProvider: new Map(), error: `endpoints HTTP ${response.status}` };
      } else {
        // Collapse each provider's bands, keyed by endpoint tag. Providers must stay separate: their
        // prices live on different scales (BytePlus 1.7e-5, Alibaba 3.8e-5 per token), so a union of
        // every band would "find" a fictitious surcharge by comparing one provider against another.
        // RouterAI documents `endpoints` as sorted by routing priority, so the first entry that
        // publishes bands is the provider a request would normally reach - the only defensible
        // assumption while `/generation` has not yet named the real one.
        const byProvider = new Map();
        const providerOrder = [];
        for (const endpoint of endpoints) {
          const tag = endpoint && typeof endpoint.tag === 'string' ? endpoint.tag : null;
          const bands = readTariffBands(endpoint);
          if (tag === null || bands.length === 0) continue;
          byProvider.set(tag, bands);
          providerOrder.push(tag);
        }
        entry = { at: Date.now(), byProvider, providerOrder, error: null };
      }
    } catch (error) {
      entry = {
        at: Date.now(),
        byProvider: new Map(),
        providerOrder: [],
        error: String(error?.name === 'TimeoutError' ? 'endpoints timed out' : (error?.message ?? error)).slice(0, 160),
      };
    }
    schedules.set(model, entry);
    return entry;
  };

  /** Peak state for one model, optionally narrowed to the provider that served the request. */
  const peakOf = (model, servedBy) => {
    if (!settings.peak || typeof model !== 'string' || !model) return null;
    const entry = schedules.get(model);
    if (entry === undefined) return { active: false, multiplier: 1, endsAt: null, pending: true, model };
    // Use the provider that actually served the request when `/generation` named it; otherwise the
    // provider RouterAI would route to first. Never merge providers - see readSchedule.
    let resolved = servedBy;
    let bands = servedBy !== null ? entry.byProvider.get(servedBy) : undefined;
    if (bands === undefined) {
      resolved = entry.providerOrder.length > 0 ? entry.providerOrder[0] : null;
      bands = resolved === null ? undefined : entry.byProvider.get(resolved);
    }
    if (bands === undefined || bands.length === 0) {
      return { active: false, multiplier: 1, endsAt: null, model, servedBy: resolved, error: entry.error };
    }
    const evaluated = evaluatePeak(bands, new Date());
    if (evaluated === null) return { active: false, multiplier: 1, endsAt: null, model, servedBy: resolved };
    return { ...evaluated, model, servedBy: resolved };
  };

  /** Highest active multiplier among the (model, servedBy) pairs a session actually used. */
  const peakForPairs = (pairs) => {
    let best = null;
    const seen = new Set();
    for (const pair of pairs) {
      if (!pair || typeof pair.model !== 'string' || !pair.model) continue;
      const servedBy = typeof pair.servedBy === 'string' && pair.servedBy ? pair.servedBy : null;
      const key = `${pair.model}#${servedBy ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const state = peakOf(pair.model, servedBy);
      if (state !== null && state.active === true && (best === null || state.multiplier > best.multiplier)) {
        best = state;
      }
    }
    return best;
  };

  /** Collect the distinct (model, servedBy) pairs behind a set of rows. */
  const pairsOfRows = (rows) => {
    const pairs = [];
    for (const row of rows) pairs.push({ model: row.model, servedBy: row.servedBy });
    return pairs;
  };

  /** Prefetch schedules for the models a session used, so the next /rows can report peak state. */
  const prefetchSchedules = (rows) => {
    if (!settings.peak) return;
    for (const row of rows) {
      if (typeof row.model !== 'string' || !row.model) continue;
      const cached = schedules.get(row.model);
      if (cached !== undefined && Date.now() - cached.at < settings.peakRefreshSeconds * 1000) continue;
      if (scheduleInFlight !== null) continue;
      scheduleInFlight = readSchedule(row.model)
        .catch(() => {})
        .finally(() => { scheduleInFlight = null; });
    }
  };

  // -- pure timer shim -------------------------------------------------------
  // `timer` may be absent in this profile, so never inject it: prefer the Cordis helper and
  // fall back to the global timer. The caller registers the returned stopper under ctx.effect.
  // Reading `ctx.interval` at ALL throws when `timer` is not injected ("cannot get property \"timer\"
  // without inject") - the property traps before `typeof` can answer. So never touch it: read the
  // service through ctx.get, and fall back to the global timer when it is unavailable.
  const startInterval = (fn, ms) => {
    let helper;
    try {
      const timer = ctx.get('timer');
      if (timer && typeof timer.interval === 'function') helper = timer.interval.bind(timer);
    } catch {
      helper = undefined;
    }
    if (helper) {
      // Cordis timer helpers return a disposer; some shapes return an async iterator instead.
      const handle = helper(fn, ms);
      if (typeof handle === 'function') return handle;
      if (handle && typeof handle.return === 'function') {
        const iterator = handle;
        const tick = () => {
          iterator.next().then((step) => {
            if (step && step.done !== true) tick();
          }, () => {});
        };
        tick();
        return () => {
          try {
            iterator.return();
          } catch { /* already closed */ }
        };
      }
    }
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  };

  // -- credential (lazy, per call; never cached, never logged) ---------------
  const getCredential = async () => {
    const credentials = ctx.get('credentials');
    if (!credentials || typeof credentials.resolve !== 'function') return undefined;
    const resolved = await credentials.resolve(CREDENTIAL_REF);
    if (resolved === undefined || resolved === null) return undefined;
    const value = typeof resolved === 'string' ? resolved : resolved.value;
    return typeof value === 'string' && value ? value : undefined;
  };

  // -- upstream calls --------------------------------------------------------
  const upstreamGet = async (pathAndQuery, key) => {
    const response = await fetch(`${settings.baseURL}${pathAndQuery}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { response, body, text };
  };

  const remoteMessage = (result) => {
    const error = result.body && result.body.error;
    if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    if (result.body && typeof result.body.message === 'string' && result.body.message) return result.body.message;
    return `HTTP ${result.response.status}`;
  };

  /** Throttling and transient server faults are worth retrying; a 404 never is. */
  const isRetryableStatus = (status) => status === 429 || status === 408 || status >= 500;

  const fetchBalance = async () => {
    let key;
    try {
      key = await getCredential();
    } catch (error) {
      balance = { amount: null, updatedAt: Date.now(), status: 'error', error: `credential lookup failed: ${String(error?.message ?? error)}`.slice(0, 200) };
      return balance;
    }
    if (!key) {
      balance = { amount: null, updatedAt: Date.now(), status: 'no-credential', error: `credential ${CREDENTIAL_REF} is not configured` };
      return balance;
    }
    try {
      const result = await limitUpstream(() => upstreamGet('/credits', key));
      const credits = result.body && result.body.data ? result.body.data.credits : undefined;
      if (typeof credits === 'number' && Number.isFinite(credits)) {
        balance = { amount: credits, updatedAt: Date.now(), status: 'ok', error: null };
      } else {
        balance = { amount: null, updatedAt: Date.now(), status: 'error', error: `unexpected /credits payload (HTTP ${result.response.status})` };
      }
    } catch (error) {
      balance = { amount: null, updatedAt: Date.now(), status: 'error', error: String(error?.name === 'TimeoutError' ? 'balance request timed out' : (error?.message ?? error)).slice(0, 200) };
    }
    return balance;
  };

  const publicBalance = () => ({
    amount: balance.amount,
    updatedAt: balance.updatedAt,
    status: balance.status,
    error: balance.error,
  });

  // -- durable charge cache --------------------------------------------------
  // Keeps upstream traffic down across runs: only `generationId -> total_cost` pairs are stored,
  // never tokens, models or session content. Best-effort by design - every failure path degrades to
  // "no cache" and re-fetches, so a permissions problem can never break the widget.
  const priceCache = new Map();
  const cacheDir = resolveStateDir();
  const cacheFile = cacheDir === null ? null : joinPath(cacheDir, PRICE_CACHE_FILE);
  let cacheDirty = false;
  let cacheLoaded = false;

  const loadPriceCache = () => {
    if (cacheLoaded || cacheFile === null) return;
    cacheLoaded = true;
    try {
      if (!existsSync(cacheFile)) return;
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
      const entries = parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
        ? parsed.entries
        : null;
      if (entries === null) return;
      for (const [id, cost] of Object.entries(entries)) {
        if (GENERATION_ID_RE.test(id) && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
          priceCache.set(id, cost);
        }
      }
    } catch {
      /* a corrupt or unreadable cache is simply ignored */
    }
  };

  const flushPriceCache = () => {
    if (!cacheDirty || cacheFile === null) return;
    cacheDirty = false;
    try {
      // Bound the file: keep the most recently inserted entries (Map preserves insertion order).
      while (priceCache.size > CACHE_MAX_ENTRIES) {
        const oldest = priceCache.keys().next();
        if (oldest.done) break;
        priceCache.delete(oldest.value);
      }
      const entries = Object.create(null);
      for (const [id, cost] of priceCache) entries[id] = cost;
      if (cacheDir !== null) mkdirSync(cacheDir, { recursive: true });
      const temp = cacheFile + '.tmp';
      writeFileSync(temp, JSON.stringify({ version: 1, entries }), 'utf8');
      renameSync(temp, cacheFile); // atomic replace: a crash never leaves a half-written cache
    } catch {
      /* cache writes are best-effort */
    }
  };

  const rememberPrice = (generationId, cost) => {
    if (typeof cost !== 'number' || !Number.isFinite(cost)) return;
    if (priceCache.get(generationId) === cost) return;
    priceCache.set(generationId, cost);
    cacheDirty = true;
  };

  // -- upstream concurrency limiter -----------------------------------------
  // RouterAI answers a burst of `/generation` lookups with 429
  // ("Too many requests. Please slow down or reduce concurrency."): measured 78 of 126 concurrent
  // requests rejected. A small fixed window keeps every lookup inside the limit while a long
  // session backfills.
  const MAX_UPSTREAM_INFLIGHT = 4;
  /** How many pending charge lookups one batch waits for; batches repeat until the time budget. */
  const MAX_LOOKUPS_PER_CALL = 12;
  /** Wall-clock budget for charge lookups in one `rows`/`refresh` call (the Client polls every 1.5 s). */
  const LOOKUP_TIME_BUDGET_MS = 900;
  /** Backoff base for a throttled/failed charge lookup (grows linearly, capped at 30 s). */
  const RETRY_BASE_MS = 2000;
  let upstreamActive = 0;
  const upstreamQueue = [];

  const pumpUpstream = () => {
    while (upstreamActive < MAX_UPSTREAM_INFLIGHT && upstreamQueue.length > 0) {
      const job = upstreamQueue.shift();
      upstreamActive += 1;
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          upstreamActive -= 1;
          pumpUpstream();
        });
    }
  };

  const limitUpstream = (run) => new Promise((resolve, reject) => {
    upstreamQueue.push({ run, resolve, reject });
    pumpUpstream();
  });

  /**
   * One real charge lookup. Resolves to `{costRub, ...}` on success or `{failure, ...}` when the
   * request could not be answered; the in-flight promise is shared by generation id, so the same
   * row is never fetched twice concurrently (the `rows` op awaits it instead of re-issuing it).
   *
   * Every request here goes through `limitUpstream`: RouterAI answers a burst with
   * `429 rate_limit_exceeded`, and an unlimited fan-out over a long session loses most of its
   * lookups to the limiter.
   */
  const lookupGeneration = (generationId) => {
    const running = inflight.get(generationId);
    if (running) return running;
    // Durable cache first: a generation id names one immutable, already-billed request, so a
    // previously settled charge is authoritative and needs no upstream call at all.
    const cached = priceCache.get(generationId);
    if (cached !== undefined) return Promise.resolve({ costRub: cached, cached: true });
    const task = (async () => {
      const key = await getCredential();
      if (!key) return { failure: 'credential-unavailable' };
      try {
        const result = await limitUpstream(() => upstreamGet(`/generation?id=${encodeURIComponent(generationId)}`, key));
        const data = result.body && result.body.data;
        const cost = data ? data.total_cost : undefined;
        if (typeof cost !== 'number' || !Number.isFinite(cost)) {
          const status = result.response.status;
          return {
            // A throttled or failed request is retryable; a genuinely missing generation is not.
            failure: isRetryableStatus(status) ? 'throttled' : 'unexpected-payload',
            retryable: isRetryableStatus(status),
            error: remoteMessage(result),
            status,
          };
        }
        const usage = data.usage;
        // Remember the settled charge so reopening this session costs zero upstream calls.
        rememberPrice(generationId, cost);
        return {
          costRub: cost,
          servedBy: typeof data.provider === 'string' && data.provider ? data.provider : null,
          model: typeof data.model === 'string' && data.model ? data.model : null,
          latencyMs: typeof data.latency_ms === 'number' && Number.isFinite(data.latency_ms) ? data.latency_ms : null,
          usage: isPlainObject(usage)
            ? {
              input: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
              output: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
              cached: Number.isFinite(usage.input_cached_tokens) ? usage.input_cached_tokens : null,
              reasoning: Number.isFinite(usage.output_reasoning_tokens) ? usage.output_reasoning_tokens : null,
              total: null,
            }
            : null,
        };
      } catch (error) {
        const timeout = error?.name === 'TimeoutError';
        return {
          failure: timeout ? 'timeout' : 'network',
          retryable: true, // a transport failure is always worth one more try
          error: String(error?.message ?? error).slice(0, 200),
        };
      }
    })().finally(() => inflight.delete(generationId));
    inflight.set(generationId, task);
    return task;
  };

  const settleRow = (row, result) => {
    if (row.status === 'resolved') return;
    if (result && typeof result.costRub === 'number') {
      row.status = 'resolved';
      row.costRub = result.costRub;
      row.servedBy = result.servedBy ?? row.servedBy;
      if (result.model) row.model = result.model;
      row.latencyMs = result.latencyMs ?? row.latencyMs;
      const usage = row.usage || { input: null, output: null, cached: null, reasoning: null, total: null };
      if (result.usage) {
        usage.input = result.usage.input ?? usage.input;
        usage.output = result.usage.output ?? usage.output;
        usage.cached = result.usage.cached ?? usage.cached;
        usage.reasoning = result.usage.reasoning ?? usage.reasoning;
      }
      if (usage.total === null) {
        usage.total = (usage.input === null && usage.output === null) ? null : (usage.input ?? 0) + (usage.output ?? 0);
      }
      row.usage = usage;
      row.error = null;
      row.lookup = 'done';
      row.lookupCode = null;
      row.lookupStatus = undefined;
      return;
    }
    row.status = 'error';
    row.costRub = null;
    row.error = result && result.failure === 'credential-unavailable'
      ? `credential ${CREDENTIAL_REF} is not configured`
      : `cost lookup failed: ${result && result.failure ? result.failure : 'unknown'}`;
    // A throttled/transport failure is re-queued after a short backoff; a real 404 is terminal so a
    // permanently unknown generation is not re-fetched forever.
    row.lookup = result && result.retryable ? 'idle' : 'failed';
    if (row.lookup === 'idle') {
      row.attempts = (row.attempts || 0) + 1;
      row.retryAt = Date.now() + Math.min(30_000, RETRY_BASE_MS * row.attempts);
    }
    row.lookupCode = result && result.failure ? result.failure : 'unknown';
    row.lookupStatus = result && typeof result.status === 'number' ? result.status : undefined;
  };

  /** Move every backoff-expired retryable row back to `pending` so the next pass picks it up. */
  const requeueRetryable = (state, force = false) => {
    const now = Date.now();
    for (const row of state.rows.values()) {
      if (row.status !== 'error' || !row.generationId) continue;
      if (!force && row.lookup !== 'idle') continue;
      if (!force && row.retryAt && now < row.retryAt) continue;
      row.status = 'pending';
      row.error = null;
      row.lookup = 'idle';
      row.retryAt = 0;
    }
  };

  /**
   * A row is priceable by generation id only when it is a chat completion whose id came from the
   * assistant message. Media rows are priced from their own response body (an image generation has
   * no id at all) or, for a video task, from the `generation_id` the task envelope named - never by
   * the task id, which 404s upstream.
   */
  const isIdPriceable = (row) => row.provider === 'routerai'
    && typeof row.generationId === 'string' && row.generationId !== ''
    && (row.kind === 'chat' || row.kind === 'video');

  const prefetchRow = (row) => {
    if (!isIdPriceable(row)) return;
    if (row.lookup === 'inflight' || row.lookup === 'done') return;
    row.lookup = 'inflight';
    void lookupGeneration(row.generationId).then(
      (result) => {
        if (row.lookup !== 'inflight') return; // superseded by a later replay of the same row
        settleRow(row, result);
        onGenerationFailed(row);
      },
      (error) => {
        if (row.lookup !== 'inflight') return;
        settleRow(row, { failure: 'internal', error: String(error?.message ?? error) });
        onGenerationFailed(row);
      },
    );
  };

  const prefetchPending = (state) => {
    if (inflight.size >= MAX_UPSTREAM_INFLIGHT) return;
    for (const row of state.rows.values()) {
      if (inflight.size >= MAX_UPSTREAM_INFLIGHT) return;
      if (row.status === 'pending' && row.lookup === 'idle' && isIdPriceable(row)) prefetchRow(row);
    }
  };

  const lookupPending = async (state, budget = MAX_LOOKUPS_PER_CALL) => {
    const jobs = [];
    for (const row of state.rows.values()) {
      if (row.status === 'pending' && isIdPriceable(row)) jobs.push(row);
    }
    // Resolve a bounded batch per call: a long session can hold hundreds of pending rows, and the
    // Client polls every 1.5 s, so the remainder is picked up by the following polls (throttled
    // rows stay `lookup: 'idle'` on purpose). `budget` is shared across the whole session scope.
    const batch = jobs.slice(0, Math.max(0, budget));
    if (batch.length === 0) return 0;
    // Rows a background prefetch already owns must not be settled (or logged) a second time here.
    const prefetched = new Set(batch.filter((row) => row.lookup === 'inflight'));
    const results = await Promise.all(
      batch.map((row) => lookupGeneration(row.generationId).catch(() => ({ failure: 'internal', retryable: true }))),
    );
    results.forEach((result, index) => {
      const row = batch[index];
      if (prefetched.has(row) || row.lookup === 'inflight') return;
      settleRow(row, result);
      onGenerationFailed(row);
    });
    return batch.length;
  };

  // -- sweep (unbounded sessions must not grow the heap) ---------------------
  // Only the size cap trims, and it trims the oldest rows. Deliberately no age expiry: dropping a
  // row by age would silently shrink a total the user is looking at (that was a real defect).
  const sweep = () => {
    const now = Date.now();
    if (now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    for (const [sessionId, state] of sessions) {
      const kept = orderedRows(state);
      if (kept.length > MAX_ROWS_PER_SESSION) {
        for (const row of kept.slice(0, kept.length - MAX_ROWS_PER_SESSION)) {
          // Rows are not all keyed by `turn:step`: media and auxiliary rows carry their own id, so
          // deleting by a recomputed key would leave them in the map forever (a leak) and would drop
          // the wrong row when several share a step.
          state.rows.delete(row.id);
        }
      }
      if (state.rows.size === 0) sessions.delete(sessionId);
    }
  };

  // -- balance poller --------------------------------------------------------
  // The delay is re-chosen after every tick instead of being fixed at registration time, so the
  // `/credits` rate follows whether anyone is actually looking at the widget (see notePresence):
  // `pollSeconds` while the Client is polling, `idlePollSeconds` once it has gone quiet.
  //
  // This MUST be a one-shot timer re-armed from inside the tick. `startInterval` registers a
  // *repeating* interval, so re-arming inside its own callback would add a fresh interval on every
  // tick and the poll rate would grow without bound (observed: balance refreshing every 1 s).
  ctx.effect(() => {
    let stopped = false;
    let cancel = null; // disposer of the single pending timer, if any
    let lastFlush = 0;

    const clearPending = () => {
      const handle = cancel;
      cancel = null;
      if (typeof handle === 'function') {
        try {
          handle();
        } catch { /* already disposed */ }
      }
    };

    function tick() {
      if (stopped) return;
      // A `startInterval` handle is a *repeating* timer, so drop it the moment it fires: exactly one
      // pending timer can exist at a time, on either the Cordis or the global backend.
      clearPending();
      void fetchBalance().catch(() => {});
      try {
        sweep();
      } catch { /* sweeping is best-effort */ }
      // Persist newly settled charges at most every CACHE_FLUSH_MS.
      if (cacheDirty && Date.now() - lastFlush >= CACHE_FLUSH_MS) {
        lastFlush = Date.now();
        flushPriceCache();
      }
      if (stopped) return;
      const seconds = isAttended() ? settings.pollSeconds : settings.idlePollSeconds;
      cancel = startInterval(tick, Math.max(1000, seconds * 1000));
    }

    loadPriceCache();
    // An arriving Client shortens the wait to `pollSeconds` instead of leaving a stale balance up
    // for a full idle period.
    onBecameAttended = () => {
      if (stopped) return;
      clearPending();
      cancel = startInterval(tick, Math.max(1000, settings.pollSeconds * 1000));
    };
    tick();
    return () => {
      stopped = true;
      onBecameAttended = null;
      flushPriceCache(); // final write on unload
      clearPending();
    };
  }, `${name}: balance poller`);

  // -- live fold -------------------------------------------------------------
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session && session.id !== undefined && session.id !== null ? String(session.id) : null;
        if (!sessionId) return;
        const state = stateOf(sessionId);
        const row = applyEvent(state, sessionId, event);
        if (row) prefetchRow(row);
      } catch (error) {
        warn(`session fold failed: ${String(error?.message ?? error)}`);
      }
    });
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  }, `${name}: session/event fold`);

  // -- cold-session backfill (once per session id) ---------------------------
  // `listEvents` returns SessionEventRecord projections ({sessionId, seq, type, time, surface}) with
  // NO `data` field, so it cannot feed the fold. `readSession` returns the complete raw
  // SessionEvent[] (with `data`) from one replay-validated observation - that is the correct source.
  const backfillFrom = async (sessionId, state, sessionQuery) => {
    let events = null;
    if (typeof sessionQuery.readSession === 'function') {
      try {
        const snapshot = await sessionQuery.readSession(sessionId);
        if (snapshot && Array.isArray(snapshot.events)) events = snapshot.events;
      } catch (error) {
        warn(`cold-session read failed for ${sessionId}: ${String(error?.message ?? error)}`);
      }
    }
    if (events === null && typeof sessionQuery.listEvents === 'function') {
      // Last resort: records carry no `data`, but a backend may still return full envelopes.
      try {
        const records = await sessionQuery.listEvents(sessionId);
        if (Array.isArray(records)) {
          events = records.filter((record) => record && record.data !== undefined);
        }
      } catch (error) {
        warn(`cold-session listEvents failed for ${sessionId}: ${String(error?.message ?? error)}`);
      }
    }
    if (events === null) return false;
    for (const event of events) {
      if (event && event.data !== undefined && event.type !== undefined) applyEvent(state, sessionId, event);
    }
    return true;
  };

  const ensureBackfill = (sessionId) => {
    const state = stateOf(sessionId);
    if (state.backfilled || state.backfilling) return;
    const sessionQuery = ctx.get('sessionQuery');
    if (!sessionQuery || (typeof sessionQuery.readSession !== 'function' && typeof sessionQuery.listEvents !== 'function')) {
      state.backfilled = true; // no backfill source: keep folding live events only
      return;
    }
    state.backfilling = (async () => {
      try {
        if (await backfillFrom(sessionId, state, sessionQuery)) state.backfilled = true;
      } finally {
        state.backfilling = null;
      }
    })();
  };

  // -- session scope (root + every descendant it spawned) --------------------
  // The user asked the main agent to show the whole spend, subagents included. Descendants come
  // from the session lineage; both sources are optional services and are allowed to fail.
  const SCOPE_CACHE_MS = 60_000;
  const MAX_SCOPE_SESSIONS = 50;
  const scopeCache = new Map(); // rootSessionId -> { at, sessions, complete }

  const collectDescendants = async (sessionId) => {
    const found = [];
    let complete = true;
    const seen = new Set([sessionId]);

    const push = (id) => {
      if (typeof id !== 'string' || !id || seen.has(id)) return;
      seen.add(id);
      found.push(id);
    };

    const sessionQuery = ctx.get('sessionQuery');
    if (sessionQuery && typeof sessionQuery.traceSession === 'function') {
      try {
        const trace = await sessionQuery.traceSession(sessionId);
        const walk = (nodes) => {
          if (!Array.isArray(nodes)) return;
          for (const node of nodes) {
            const id = node && node.session && node.session.header ? node.session.header.id : null;
            push(id);
            if (node) walk(node.descendants);
          }
        };
        walk(trace && trace.descendants);
        return { sessions: found, complete };
      } catch (error) {
        warn(`scope trace failed for ${sessionId}: ${String(error?.message ?? error)}`);
        complete = false;
      }
    }

    const subagents = ctx.get('subagents');
    if (subagents && typeof subagents.listDescendants === 'function') {
      try {
        const list = await subagents.listDescendants(sessionId);
        if (Array.isArray(list)) {
          for (const entry of list) {
            // Entries are either {sessionId} or a bare id depending on the provider.
            if (typeof entry === 'string') push(entry);
            else if (entry && typeof entry.sessionId === 'string') push(entry.sessionId);
            else if (entry && entry.header && typeof entry.header.id === 'string') push(entry.header.id);
          }
        }
      } catch (error) {
        warn(`scope descendants failed for ${sessionId}: ${String(error?.message ?? error)}`);
        complete = false;
      }
    } else if (complete) {
      complete = false; // no lineage source at all: we cannot claim the scope is whole
    }
    return { sessions: found, complete };
  };

  const resolveScope = async (sessionId, force) => {
    const cached = scopeCache.get(sessionId);
    if (!force && cached && Date.now() - cached.at < SCOPE_CACHE_MS) return cached;
    const { sessions, complete } = await collectDescendants(sessionId);
    const scope = {
      at: Date.now(),
      sessions: sessions.slice(0, MAX_SCOPE_SESSIONS),
      complete: complete && sessions.length <= MAX_SCOPE_SESSIONS,
    };
    scopeCache.set(sessionId, scope);
    if (scopeCache.size > 64) {
      const oldest = [...scopeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) scopeCache.delete(oldest[0]);
    }
    return scope;
  };

  // -- bridge payloads -------------------------------------------------------
  const statePayload = (sessionId, state) => {
    const rows = orderedRows(state);
    return {
      sessionId,
      asOfSeq: state.maxSeq >= 0 ? state.maxSeq : 0,
      balance: publicBalance(),
      rows: rows.map(serializeRow),
      total: totalsFor(rows),
    };
  };

  /** v2 payload: balance + aggregated statistics over the root session AND its subagents. */
  const scopedPayload = async (sessionId, options) => {
    const scope = sessionId
      ? await resolveScope(sessionId, options.forceRetry === true)
      : { sessions: [], complete: false };
    const sessionIds = sessionId ? [sessionId, ...scope.sessions] : [];

    // Backfill every session in scope, then fold its rows.
    for (const id of sessionIds) {
      const state = stateOf(id);
      ensureBackfill(id);
      if (state.backfilling) {
        try {
          await state.backfilling;
        } catch { /* handled inside the backfill */ }
      }
    }

    if (options.refetchBalance) await fetchBalance();

    // Drain retryable/pending rows across the whole scope until the time budget runs out, root
    // first: the headline number converges before subagent detail, and the shared 4-way upstream
    // limiter means a multi-subagent tree still cannot stampede RouterAI.
    const startedAt = Date.now();
    let guard = 0;
    while (Date.now() - startedAt < LOOKUP_TIME_BUDGET_MS && guard < 40) {
      guard += 1;
      let progressed = false;
      for (const id of sessionIds) {
        if (Date.now() - startedAt >= LOOKUP_TIME_BUDGET_MS) break;
        const state = stateOf(id);
        requeueRetryable(state, options.forceRetry === true);
        prefetchPending(state);
        if (await lookupPending(state, MAX_LOOKUPS_PER_CALL) > 0) progressed = true;
      }
      if (!progressed) break;
    }
    const allRows = [];
    for (const id of sessionIds) allRows.push(...orderedRows(stateOf(id)).map(serializeRow));
    allRows.sort((a, b) => (a.time || 0) - (b.time || 0) || a.id.localeCompare(b.id));

    const childIds = new Set(scope.sessions);
    const stats = statsFor(allRows, sessionId, childIds);
    prefetchSchedules(allRows);
    return {
      sessionId,
      scope: {
        root: sessionId,
        sessions: sessionIds,
        descendants: scope.sessions.length,
        complete: sessionId ? scope.complete : false,
      },
      stats: {
        total: stats.total,
        own: stats.own,
        children: stats.children,
        byProvider: stats.byProvider,
        byModel: stats.byModel,
        // Non-chat spend only, sorted by amount: media generations and the Harness's own auxiliary
        // model calls. Empty for a session that made nothing but chat completions, which is what lets
        // the Client hide the section entirely in the ordinary case.
        byKind: stats.byKind,
      },
      balance: publicBalance(),
      // Peak-hour surcharge for the models this session actually used. `null` when the feature is
      // off or no schedule is known yet; the Client only paints red on `active === true`.
      peak: peakForPairs(pairsOfRows(allRows)),
      rows: allRows,
    };
  };

  const handlers = {
    async describe() {
      return {
        ok: true,
        value: {
          provider: 'routerai',
          currency: CURRENCY,
          configured: balance.status !== 'no-credential',
          pollSeconds: settings.pollSeconds,
          idlePollSeconds: settings.idlePollSeconds,
          attended: isAttended(),
          balance: publicBalance(),
          // Peak-hour feature state: which model schedules are loaded and what they say right now.
          // Diagnostics only; the Client reads `peak` from /rows, where the session's models are known.
          peak: {
            enabled: settings.peak,
            refreshSeconds: settings.peakRefreshSeconds,
            models: [...schedules.entries()].map(([model, entry]) => ({
              model,
              providers: [...entry.byProvider.keys()],
              primary: entry.providerOrder[0] ?? null,
              bands: entry.providerOrder.reduce((sum, tag) => sum + entry.byProvider.get(tag).length, 0),
              error: entry.error,
              now: peakOf(model, null),
            })),
          },
          // Diagnostics for the durable charge cache (path + size only; never its contents).
          cache: {
            file: cacheFile,
            entries: priceCache.size,
            dirty: cacheDirty,
            // Force a write and report the outcome, so a silent permission failure is visible.
            flush: (() => {
              try {
                if (cacheFile === null) return 'no-path';
                mkdirSync(cacheDir, { recursive: true });
                const entries = Object.create(null);
                for (const [id, cost] of priceCache) entries[id] = cost;
                const temp = cacheFile + '.tmp';
                writeFileSync(temp, JSON.stringify({ version: 1, entries }), 'utf8');
                renameSync(temp, cacheFile);
                cacheDirty = false;
                return 'ok';
              } catch (error) {
                return 'fail:' + String(error && error.code ? error.code : error).slice(0, 80);
              }
            })(),
          },
        },
      };
    },

    async rows(request) {
      const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : null;
      if (!sessionId) {
        return { ok: false, code: 'session-required', message: 'rows requires a sessionId' };
      }
      // The Client polls this op every 1.5 s while its widget is mounted: free presence signal that
      // keeps the balance poller on the fast interval without any extra request of its own.
      notePresence();
      return { ok: true, value: await scopedPayload(sessionId, { refetchBalance: false }) };
    },

    async refresh(request) {
      const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : null;
      await fetchBalance(); // force a balance refetch even for a session-less refresh
      if (!sessionId) {
        return { ok: true, value: { sessionId: null, scope: null, stats: null, balance: publicBalance(), rows: [] } };
      }
      scopeCache.delete(sessionId); // a forced refresh re-resolves subagent lineage
      return { ok: true, value: await scopedPayload(sessionId, { refetchBalance: false, forceRetry: true }) };
    },
  };

  const guard = (req, res) => {
    if (!isBridgeRequestAllowed(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'requests must come from the local host' });
      return false;
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method ?? ''}` });
      return false;
    }
    return true;
  };

  const makeRoute = (op, handler) => ({
    kind: 'exact',
    path: `${BRIDGE_PREFIX}/${op}`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const body = await readJsonBody(req);
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: 'malformed-body', message: 'malformed JSON body' });
        return;
      }
      let result;
      try {
        result = await handler(body);
      } catch (error) {
        // The plugin must never throw out of a route: a broken widget beats a broken Host.
        warn(`${op} failed: ${String(error?.message ?? error)}`);
        result = { ok: false, code: 'internal', message: 'routerai-usage failed to build a response' };
      }
      writeJson(res, result.ok ? 200 : 400, result);
    },
  });

  ctx.effect(() => {
    const webServer = ctx.get('webServer');
    if (!webServer || typeof webServer.register !== 'function') {
      warn('webServer is unavailable - the bridge route is not registered');
      return () => {};
    }
    const disposers = [];
    try {
      for (const op of ['describe', 'rows', 'refresh']) {
        disposers.push(webServer.register(makeRoute(op, handlers[op])));
      }
    } catch (error) {
      warn(`bridge route registration failed: ${String(error?.message ?? error)}`);
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch { /* ignore */ }
      }
    }
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch { /* ignore */ }
      }
    };
  }, `${name}: bridge routes`);
}

export { apply, inject, name };
