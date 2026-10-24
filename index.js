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
/** Credential *reference* name (not a record key): resolved per call, never cached. */
const CREDENTIAL_REF = 'ROUTERAI_API_KEY';
/** RouterAI balance/usage is returned in rubles (see CONTRACT.md). */
const CURRENCY = 'RUB';
/** Anchored so `${sessionId}:${turn}:${step}` row ids can never match a generation id. */
const GENERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
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
const CACHE_MAX_ENTRIES = 20000;
const CACHE_FLUSH_MS = 15_000;

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function clampInteger(value, fallback, min, max) {
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

/** Order: ascending turn, then step (CONTRACT.md `rows` is a complete ordered list). */
function orderedRows(state) {
  return [...state.rows.values()].sort((a, b) => (a.turn - b.turn) || (a.step - b.step));
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
 * Aggregate rows into `{total, own, children, byProvider, byModel}` (CONTRACT-v2.md).
 *
 * `own`/`children` are split by the owning session id so the Client can tell the user how much of
 * the spend came from subagents. Pure: takes serialized rows plus the set of child session ids.
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
// plugin
// ---------------------------------------------------------------------------

/** Directory the Harness keeps profile-independent plugin state in. */
function resolveStateDir() {
  // DSH_HOME is the documented state root; DSH_PROFILE_DIR is always exported for a
  // profile-launched Harness and is the reliable fallback.
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim()) return joinPath(home.trim(), 'storages');
  const profile = process.env.DSH_PROFILE_DIR;
  if (typeof profile === 'string' && profile.trim()) return joinPath(profile.trim(), '.routerai-usage');
  // Last resort: the platform user-data area, still outside a plugin-owned package.
  try {
    const local = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || process.env.HOME;
    if (typeof local === 'string' && local.trim()) return joinPath(local.trim(), 'dsh-routerai-usage');
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

  const warn = (message) => {
    try {
      logger?.warn?.(`${name}: ${message}`);
    } catch { /* logging must never break the plugin */ }
  };

  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { rows: new Map(), current: null, maxSeq: -1, backfilled: false, backfilling: null };
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

  const prefetchRow = (row) => {
    if (!row || !row.generationId || row.provider !== 'routerai') return;
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
      if (row.status === 'pending' && row.lookup === 'idle' && row.generationId) prefetchRow(row);
    }
  };

  const lookupPending = async (state, budget = MAX_LOOKUPS_PER_CALL) => {
    const jobs = [];
    for (const row of state.rows.values()) {
      if (row.status === 'pending') jobs.push(row);
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
          state.rows.delete(rowKey(sessionId, row.turn, row.step));
        }
      }
      if (state.rows.size === 0) sessions.delete(sessionId);
    }
  };

  // -- balance poller --------------------------------------------------------
  ctx.effect(() => {
    let stopped = false;
    let lastFlush = 0;
    const tick = () => {
      if (stopped) return;
      void fetchBalance().catch(() => {});
      try {
        sweep();
      } catch { /* sweeping is best-effort */ }
      // Persist newly settled charges at most every CACHE_FLUSH_MS.
      if (cacheDirty && Date.now() - lastFlush >= CACHE_FLUSH_MS) {
        lastFlush = Date.now();
        flushPriceCache();
      }
    };
    loadPriceCache();
    const stop = startInterval(tick, Math.max(1000, settings.pollSeconds * 1000));
    tick();
    return () => {
      stopped = true;
      flushPriceCache(); // final write on unload
      try {
        stop();
      } catch { /* already disposed */ }
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
  const SCOPE_CACHE_MS = 30_000;
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
      },
      balance: publicBalance(),
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
          balance: publicBalance(),
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
export default { name, inject, apply };
