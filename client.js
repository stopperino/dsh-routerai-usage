window.__ModuleLoader__.load({
  id: 'dsh-routerai-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'routerai-usage';
    const BRIDGE_PREFIX = '/api/dsh-routerai-usage';
    const POLL_MS = 1500;

    // Visible copy. The plugin serves a Russian service and ships Russian UI only: there is no
    // English dictionary by design, so the widget never falls back to English text.
    const RU_DICT = {
      title: 'RouterAI',
      source: 'routerai.ru',
      balance: 'Баланс',
      total: 'всего',
      session: 'сессия',
      subagents: 'в т.ч. субагенты',
      perProvider: 'По провайдеру',
      perModel: 'По модели',
      noKey: 'нет ключа',
      error: 'ошибка',
      pending: '…',
      unpriced: '—',
      loading: 'загрузка',
      call: 'запрос',
      calls2: 'запроса',
      calls5: 'запросов',
      panelHint: 'Нажмите, чтобы раскрыть расходы',
      // Peak-hour surcharge: a provider is charging more than its cheapest rate right now.
      peakNow: 'Пиковые часы',
      peakMultiplier: 'цена',
      peakUntil: 'до',
      peakOngoing: 'повышенный тариф действует',
      peakLocalTime: 'местное',
    };

    // Host `ContextMeter` visual language, re-implemented under the `dsr-` prefix:
    // panel = radius-lg on --dsw-specific-menu with --dsw-elevation-prominent, 12px padding,
    // 12px/20px text; trigger = radius-sm, tertiary label, 13px, tabular numerals, 1px 8px padding,
    // hover/expanded background --dsw-alias-interactive-bg-hover. Every var() keeps a fallback so a
    // renamed token degrades instead of dropping the declaration.
    const CSS = [
      '.dsr-root{flex:none;display:inline-flex;position:relative}',
      '.dsr-trigger{border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary,currentColor);',
      'font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;',
      // Click-only affordance: the trigger looks (and is) interactive, but the panel toggles on
      // click rather than following the pointer.
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;',
      'background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.dsr-trigger:hover,.dsr-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dsr-value{font-variant-numeric:tabular-nums}',
      '.dsr-brand{align-items:center;gap:5px;display:flex;margin-bottom:6px;font-weight:500}',
      '.dsr-brandMark{display:block;flex:none}',
      // Wordmark: the site sets "routerai" in lowercase, so mirror that casing and weight.
      '.dsr-brandName{font-size:12px;font-weight:600;letter-spacing:-.01em;line-height:1;color:var(--dsw-alias-label-primary,currentColor)}',
      '.dsr-session{align-items:center;gap:5px;display:inline-flex;margin-left:9px;opacity:.9;font-variant-numeric:tabular-nums}',
      '.dsr-sessionGlyph{display:block;flex:none}',
      '.dsr-sessionValue{font-variant-numeric:tabular-nums}',
      '.dsr-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);',
      'background:var(--dsw-specific-menu,Canvas);width:264px;max-width:calc(100vw - 24px);',
      'backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));',
      'color:var(--dsw-alias-label-secondary,currentColor);cursor:default;border:0;padding:12px;font-size:12px;',
      'line-height:20px;position:fixed}',
      '.dsr-figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,currentColor);margin-left:auto;font-weight:500}',
      '.dsr-sub{margin-top:2px;color:var(--dsw-alias-label-tertiary,currentColor);font-variant-numeric:tabular-nums}',
      // Peak-hour warning: same red as the host's error label, but with a fallback so a renamed
      // token degrades to plain red instead of dropping the whole declaration.
      '.dsr-peak{margin-top:6px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);',
      'background:var(--dsw-alias-bg-error,#fdecec);color:var(--dsw-alias-label-error,#c62828);',
      'font-variant-numeric:tabular-nums;line-height:16px}',
      '.dsr-peakTitle{font-weight:600}',
      '.dsr-peakValue{font-variant-numeric:tabular-nums}',
      // The balance figure turns red while a peak surcharge is active.
      '.dsr-peakAmount{color:var(--dsw-alias-label-error,#c62828)}',
      '.dsr-subStrong{margin-top:2px;color:var(--dsw-alias-label-secondary,currentColor);font-variant-numeric:tabular-nums}',
      '.dsr-section{margin:10px 0 0}',
      '.dsr-sectionTitle{color:var(--dsw-alias-label-tertiary,currentColor);margin-bottom:2px}',
      '.dsr-row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}',
      '.dsr-rowName{color:var(--dsw-alias-label-secondary,currentColor);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsr-rowValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,currentColor);margin:0;flex:none}',
      '.dsr-rows{margin:0}',
      '.dsr-empty{color:var(--dsw-alias-label-tertiary,currentColor)}',
    ].join('');

    const FORMAT_CACHE = {};

    function numberFormat(min, max) {
      const key = min + ':' + max;
      if (!Object.prototype.hasOwnProperty.call(FORMAT_CACHE, key)) {
        let format = null;
        try {
          format = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: min, maximumFractionDigits: max });
        } catch (error) {
          format = null;
        }
        FORMAT_CACHE[key] = format;
      }
      return FORMAT_CACHE[key];
    }

    function formatFixed(value, digits) {
      const format = numberFormat(digits, digits);
      if (format !== null) {
        try {
          return format.format(value);
        } catch (error) {
          /* fall through */
        }
      }
      return String(value);
    }

    function formatInteger(value) {
      const format = numberFormat(0, 0);
      if (format !== null) {
        try {
          return format.format(value);
        } catch (error) {
          /* fall through */
        }
      }
      return String(value);
    }

    /**
     * Ruble text, ru-RU. A real charge under 0.01 RUB keeps 4 significant digits so it never renders
     * as `0,00 ₽`; 0.01..1 keeps 4 decimals; above 1 keeps 2.
     */
    function rubText(amount) {
      if (typeof amount !== 'number' || !isFinite(amount)) return null;
      const abs = Math.abs(amount);
      let value = amount;
      let digits;
      if (abs === 0) {
        digits = 2;
      } else if (abs < 0.01) {
        try {
          value = Number(amount.toPrecision(4));
        } catch (error) {
          value = amount;
        }
        digits = 4;
      } else if (abs < 1) {
        digits = 4;
      } else {
        digits = 2;
      }
      try {
        value = Number(value.toFixed(digits));
      } catch (error) {
        /* keep value */
      }
      return formatFixed(value, digits) + '\u00a0₽';
    }

    function finiteNumber(value) {
      return typeof value === 'number' && isFinite(value) ? value : null;
    }

    /** Russian plural for «запрос»: 1 запрос, 2 запроса, 5 запросов. */
    function pluralRequests(t, count) {
      const n = Math.abs(count) % 100;
      const tail = n % 10;
      if (n > 10 && n < 20) return t('calls5');
      if (tail === 1) return t('call');
      if (tail >= 2 && tail <= 4) return t('calls2');
      return t('calls5');
    }

    /** One POST to the Host bridge; rejects only on transport failure. */
    async function bridgePost(op, body, signal) {
      const response = await fetch(BRIDGE_PREFIX + op, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined || body === null ? {} : body),
        credentials: 'same-origin',
        signal: signal === undefined ? undefined : signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (payload !== null && typeof payload === 'object') {
        if (payload.ok === true && payload.value !== null && payload.value !== undefined) {
          return { ok: true, value: payload.value };
        }
        return {
          ok: false,
          code: typeof payload.code === 'string' ? payload.code : 'not-ok',
          message: typeof payload.message === 'string' ? payload.message : '',
        };
      }
      return { ok: false, code: 'bad-response', message: 'HTTP ' + (response ? response.status : '?') };
    }

    /** Balance-only cell text plus its state kind: the user asked for the balance and nothing else. */
    function balanceCell(t, balance, transport) {
      if (balance !== null && typeof balance === 'object') {
        const status = typeof balance.status === 'string' ? balance.status : '';
        if (status === 'ok') {
          const amount = rubText(finiteNumber(balance.amount));
          if (amount !== null) return { text: amount, kind: 'amount' };
          return { text: t('unpriced'), kind: 'unpriced' };
        }
        if (status === 'no-credential') return { text: t('noKey'), kind: 'noKey' };
        if (status === 'error') return { text: t('error'), kind: 'error' };
        return { text: t('pending'), kind: 'pending' };
      }
      if (transport === 'rejected' || transport === 'failed') return { text: t('error'), kind: 'error' };
      return { text: t('pending'), kind: 'pending' };
    }

    function statsOf(snapshot) {
      const stats = snapshot !== null && snapshot !== undefined && snapshot.stats !== null && typeof snapshot.stats === 'object'
        ? snapshot.stats
        : null;
      const scope = snapshot !== null && snapshot !== undefined && snapshot.scope !== null && typeof snapshot.scope === 'object'
        ? snapshot.scope
        : null;
      const total = stats !== null && stats.total !== null && typeof stats.total === 'object' ? stats.total : null;
      const own = stats !== null && stats.own !== null && typeof stats.own === 'object' ? stats.own : null;
      const children = stats !== null && stats.children !== null && typeof stats.children === 'object' ? stats.children : null;
      const listOf = (value) => (Array.isArray(value) ? value.filter((group) => group && typeof group === 'object') : []);
      return {
        total,
        own,
        children,
        scope,
        byProvider: stats !== null ? listOf(stats.byProvider) : [],
        byModel: stats !== null ? listOf(stats.byModel) : [],
      };
    }

    /**
     * Anchored fixed-position placement, approximating the host's `useAnchoredPosition`: open above
     * the anchor when there is no room below, clamped to the viewport.
     */
    function placePanel(anchor, panelWidth, panelHeight) {
      if (!anchor) return null;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const viewportW = window.innerWidth || 1024;
      const viewportH = window.innerHeight || 768;
      let left = rect.left;
      if (left + panelWidth + margin > viewportW) left = Math.max(margin, viewportW - panelWidth - margin);
      if (left < margin) left = margin;
      let top = rect.bottom + margin;
      if (top + panelHeight + margin > viewportH) {
        const above = rect.top - panelHeight - margin;
        top = above >= margin ? above : Math.max(margin, viewportH - panelHeight - margin);
      }
      return { left: Math.round(left) + 'px', top: Math.round(top) + 'px' };
    }

    /**
     * Short model label for the per-model breakdown: RouterAI model ids are `vendor/model`, but the
     * panel is only 264px wide, so the vendor family is dropped and just the model name is shown
     * ("deepseek/deepseek-v4.1-flash" -> "deepseek-v4.1-flash"). The full id stays in the title.
     */
    function shortModelName(key) {
      if (typeof key !== 'string' || key === '') return '(unknown)';
      const slash = key.lastIndexOf('/');
      const tail = slash >= 0 ? key.slice(slash + 1) : key;
      return tail === '' ? key : tail;
    }

    function StatRows(props) {
      const rows = props.rows;
      if (rows.length === 0) return h('div', { className: 'dsr-empty' }, props.t('pending'));
      return h(
        'div',
        null,
        rows.map(function (group, index) {
          const full = typeof group.key === 'string' && group.key ? group.key : '(unknown)';
          const name = props.shorten === true ? shortModelName(full) : full;
          const calls = finiteNumber(group.calls) ?? 0;
          const cost = rubText(finiteNumber(group.amountRub));
          return h(
            'div',
            { className: 'dsr-row', key: full + ':' + index },
            h('dt', { className: 'dsr-rowName', title: full }, name),
            h(
              'dd',
              { className: 'dsr-rowValue' },
              formatInteger(calls) + ' ' + pluralRequests(props.t, calls) + (cost === null ? ' · ' + props.t('unpriced') : ' · ' + cost),
            ),
          );
        }),
      );
    }

    /**
     * Normalise the Host's `peak` block.
     *
     * The Host reports `{ active, multiplier, endsAt, model, servedBy }` for the most expensive
     * surcharge among the models the session used. Anything malformed degrades to "no peak": a bad
     * payload must never paint the balance red.
     */
    function peakOf(snapshot) {
      if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') return null;
      const peak = snapshot.peak;
      if (peak === null || peak === undefined || typeof peak !== 'object') return null;
      if (peak.active !== true) return null;
      const multiplier = finiteNumber(peak.multiplier);
      if (multiplier === null || multiplier <= 1) return null;
      const endsAt = finiteNumber(peak.endsAt);
      return {
        multiplier: multiplier,
        endsAt: endsAt !== null && endsAt > 0 ? endsAt : null,
        model: typeof peak.model === 'string' ? peak.model : null,
        servedBy: typeof peak.servedBy === 'string' ? peak.servedBy : null,
      };
    }

    /** Local wall-clock time of the end of the peak window, e.g. «15:00». */
    function clockText(endsAt) {
      if (endsAt === null) return null;
      try {
        return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(endsAt));
      } catch (error) {
        return null;
      }
    }

    /** «2×» — the site writes the coefficient before the word «цена», not as a prefix sign. */
    function multiplierText(value) {
      if (!isFinite(value)) return null;
      const rounded = Math.round(value * 100) / 100;
      return String(rounded) + '\u00d7';
    }

    function Panel(props) {
      const t = props.t;
      const parts = statsOf(props.snapshot);
      const total = parts.total;
      const own = parts.own;
      const children = parts.children;
      const scope = parts.scope;

      const snapshot = props.snapshot !== null && props.snapshot !== undefined ? props.snapshot : null;
      const balance = snapshot !== null && snapshot.balance !== null && typeof snapshot.balance === 'object' ? snapshot.balance : null;
      const balanceText = rubText(finiteNumber(balance === null ? null : balance.amount));
      const totalCost = total === null ? null : rubText(finiteNumber(total.amountRub));
      const totalCalls = total === null ? 0 : finiteNumber(total.calls) ?? 0;
      const childCost = children === null ? null : rubText(finiteNumber(children.amountRub));
      const childCalls = children === null ? 0 : finiteNumber(children.calls) ?? 0;
      const descendants = scope === null ? 0 : finiteNumber(scope.descendants) ?? 0;
      const peak = peakOf(snapshot);

      const body = [];

      // Peak surcharge goes FIRST: it is the reason the balance is red, so it must be visible
      // without reading the rest of the panel.
      if (peak !== null) {
        const until = clockText(peak.endsAt);
        const factor = multiplierText(peak.multiplier);
        body.push(
          h(
            'div',
            { className: 'dsr-peak', key: 'peak' },
            h('span', { className: 'dsr-peakTitle' }, t('peakNow') + ': '),
            h(
              'span',
              { className: 'dsr-peakValue' },
              factor === null ? t('peakOngoing') : t('peakMultiplier') + ' ' + factor,
            ),
            // The clock is the browser's local time, so say so: the provider publishes its windows
            // in UTC and a bare "до 15:00" invites reading it against the wrong zone.
            until === null
              ? null
              : h('span', { className: 'dsr-peakValue' }, ' \u00b7 ' + t('peakUntil') + ' ' + until + ' (' + t('peakLocalTime') + ')'),
          ),
        );
      }

      // Branding lives ONLY here, in the tooltip: the site's mark + lowercase wordmark on the left,
      // and the total balance on the SAME line, right-aligned. No second "routerai.ru" line.
      body.push(
        h(
          'div',
          { className: 'dsr-brand', key: 'brand' },
          h(Logo, { className: 'dsr-brandMark', size: 14 }),
          h('span', { className: 'dsr-brandName' }, 'routerai'),
          h(
            'span',
            { className: balanceText === null ? 'dsr-figures' : (peak === null ? 'dsr-figures' : 'dsr-figures dsr-peakAmount') },
            balanceText === null ? t('pending') : balanceText,
          ),
        ),
      );

      body.push(
        h(
          'div',
          { className: 'dsr-sub', key: 'totals' },
          totalCost === null
            ? t('loading')
            : t('total') + ' ' + totalCost + ' · ' + formatInteger(totalCalls) + ' ' + pluralRequests(t, totalCalls),
        ),
      );

      // The user's headline requirement: show the subagent share, and only when there is one.
      if (descendants > 0) {
        body.push(
          h(
            'div',
            { className: 'dsr-subStrong', key: 'children' },
            t('subagents') + ': ' + (childCost === null ? t('unpriced') : childCost) + ' · ' +
              formatInteger(childCalls) + ' ' + pluralRequests(t, childCalls),
          ),
        );
      } else if (own !== null && (finiteNumber(own.calls) ?? 0) > 0) {
        body.push(h('div', { className: 'dsr-sub', key: 'children0' }, t('subagents') + ': ' + t('unpriced')));
      }

      body.push(
        h(
          'div',
          { className: 'dsr-section', key: 'prov' },
          h('div', { className: 'dsr-sectionTitle' }, t('perProvider')),
          h('dl', { className: 'dsr-rows' }, h(StatRows, { rows: parts.byProvider, t: t })),
        ),
      );

      body.push(
        h(
          'div',
          { className: 'dsr-section', key: 'model' },
          h('div', { className: 'dsr-sectionTitle' }, t('perModel')),
          h('dl', { className: 'dsr-rows' }, h(StatRows, { rows: parts.byModel, t: t, shorten: true })),
        ),
      );

      return h(
        'div',
        {
          className: 'dsr-panel',
          ref: props.panelRef,
          role: 'dialog',
          'aria-label': t('title'),
          style: props.position === null ? { visibility: 'hidden', left: 0, top: 0 } : props.position,
        },
        body,
      );
    }

    // Official routerai.ru mark (28x28, #2D67F6), taken from the site's own logo asset. Uses its
    // own blue because it is a brand mark, which is the one place literal colour is allowed.
    const LOGO_PATH = 'M27 13.777a4.291 4.291 0 0 0-2.64-3.961l-.398-.165.164-.4a4.29 4.29 0 0 0-5.602-5.6l-.397.163-.165-.397A4.294 4.294 0 0 0 14.332.79L14 .777a4.292 4.292 0 0 0-3.962 2.64l-.165.397-.397-.163a4.292 4.292 0 0 0-5.603 5.6l.165.4-.397.165A4.291 4.291 0 0 0 1 13.776l.013.332a4.292 4.292 0 0 0 2.628 3.63l.397.165-.165.399a4.29 4.29 0 0 0 5.603 5.601l.397-.164.165.397a4.291 4.291 0 0 0 7.924 0l.165-.397.397.164a4.292 4.292 0 0 0 5.602-5.601l-.164-.399.398-.165A4.29 4.29 0 0 0 27 13.777ZM14 2.203c1.186 0 2.21.723 2.643 1.763l.712 1.708 1.713-.704a2.862 2.862 0 0 1 3.737 3.74l-.704 1.71 1.709.713a2.864 2.864 0 0 1 1.762 2.644v.008l-.002.094v.008a2.864 2.864 0 0 1-1.761 2.534l-1.708.711.704 1.712a2.865 2.865 0 0 1-3.737 3.74l-1.713-.706-.712 1.71a2.863 2.863 0 0 1-5.286 0l-.712-1.71-1.713.706a2.866 2.866 0 0 1-3.738-3.74l.704-1.711-1.708-.712a2.863 2.863 0 0 1-1.762-2.644v-.008l.002-.094v-.009a2.863 2.863 0 0 1 1.76-2.533l1.708-.712-.704-1.712a2.865 2.865 0 0 1 3.738-3.74l1.713.705.712-1.708A2.863 2.863 0 0 1 14 2.203Z';

    function Logo(props) {
      return h(
        'svg',
        {
          className: props.className,
          viewBox: '0 0 28 28',
          width: props.size,
          height: props.size,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { fill: '#2D67F6', d: LOGO_PATH }),
      );
    }

    /**
     * Session glyph for the dock row: a ring with a dot inside, drawn as SVG so it depends on no
     * font and no non-ASCII source character (a literal glyph was mangled by an encoding round-trip
     * once already, so nothing here is a text character).
     */
    function SessionGlyph(props) {
      return h(
        'svg',
        {
          className: 'dsr-sessionGlyph',
          viewBox: '0 0 12 12',
          width: props.size,
          height: props.size,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('circle', { cx: 6, cy: 6, r: 4.3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
        h('circle', { cx: 6, cy: 6, r: 1.5, fill: 'currentColor' }),
      );
    }

    function UsageDock(props) {
      const safeProps = props !== null && props !== undefined && typeof props === 'object' ? props : {};
      const sessionId = typeof safeProps.sessionId === 'string' ? safeProps.sessionId : '';
      const t = typeof safeProps.t === 'function' ? safeProps.t : fallbackTranslate;

      const [snapshot, setSnapshot] = React.useState(null);
      const [transport, setTransport] = React.useState('loading');
      const [open, setOpen] = React.useState(false);
      const [position, setPosition] = React.useState(null);

      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);

      // Poll the aggregated snapshot; the first request is immediate.
      // A hidden tab stops polling entirely: the mounted-effect check below is a second signal for a
      // case the Host cannot see (e.g. `document.visibilityState` is already 'hidden'), but the
      // effect re-runs on every mount, so the timer is re-armed whenever the mount point returns.
      React.useEffect(function () {
        if (sessionId === '') return undefined;
        let cancelled = false;
        let timer = null;
        let controller = null;
        const hidden = function () {
          return typeof document !== 'undefined'
            && typeof document.visibilityState === 'string'
            && document.visibilityState === 'hidden';
        };

        const load = function () {
          if (cancelled) return;
          // A background tab never sends anything: no traffic and no upstream cost while unseen.
          if (hidden()) {
            if (controller !== null) {
              try {
                controller.abort();
              } catch (error) {
                /* ignore */
              }
              controller = null;
            }
            return;
          }
          if (controller !== null) {
            try {
              controller.abort();
            } catch (error) {
              /* ignore */
            }
          }
          controller = new AbortController();
          bridgePost('/rows', { sessionId: sessionId, sinceSeq: 0 }, controller.signal).then(
            function (result) {
              if (cancelled) return;
              if (result.ok) {
                setSnapshot(result.value);
                setTransport('ok');
              } else {
                setTransport('rejected');
              }
            },
            function (error) {
              if (cancelled) return;
              if (error !== null && error !== undefined && error.name === 'AbortError') return;
              setTransport('failed');
            },
          );
        };

        load();
        timer = setInterval(load, POLL_MS);

        // Returning to the tab resumes the cadence immediately instead of after the next interval.
        const onVisibility = function () {
          if (!hidden()) load();
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility);
        }

        return function () {
          cancelled = true;
          if (timer !== null) clearInterval(timer);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
          if (controller !== null) {
            try {
              controller.abort();
            } catch (error) {
              /* ignore */
            }
          }
        };
      }, [sessionId]);

      // Outside-pointer dismissal, same contract as the host's useDismissOnOutsidePointer.
      React.useEffect(function () {
        if (!open) return undefined;
        const onPointerDown = function (event) {
          const target = event && event.target;
          if (rootRef.current !== null && rootRef.current.contains(target)) return;
          if (panelRef.current !== null && panelRef.current.contains(target)) return;
          setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [open]);

      // Escape closes, matching the host panel.
      React.useEffect(function () {
        if (!open) return undefined;
        const onKeyDown = function (event) {
          if (event && event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return function () {
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      // Position the fixed panel against the trigger whenever it opens or its content changes.
      React.useEffect(function () {
        if (!open) {
          setPosition(null);
          return undefined;
        }
        const measure = function () {
          let width = 264;
          let height = 220;
          if (panelRef.current !== null) {
            const rect = panelRef.current.getBoundingClientRect();
            if (rect.width > 0) width = rect.width;
            if (rect.height > 0) height = rect.height;
          }
          setPosition(placePanel(triggerRef.current, width, height));
        };
        measure();
        const timer = setTimeout(measure, 0);
        window.addEventListener('resize', measure);
        return function () {
          clearTimeout(timer);
          window.removeEventListener('resize', measure);
        };
      }, [open, snapshot]);

      // Click-only: the panel opens on an activating click and closes on the next one (or on an
      // outside pointer-down / Escape, handled below). Hover does nothing at all.
      //
      // Still on `onClick`, not `onPointerDown`: a press that starts inside and releases outside
      // must not toggle, which is exactly what click semantics give us for free.
      const onTriggerClick = function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setOpen(function (value) {
          return !value;
        });
      };

      // The cell carries the balance first and then the CURRENT session's spend (which already
      // includes every subagent this session spawned), matching the original layout the user asked
      // to keep: "сначала баланс, а потом цена текущей сессии".
      let element;
      try {
        const cell = balanceCell(t, snapshot !== null && typeof snapshot === 'object' ? snapshot.balance : null, transport);
        const parts = statsOf(snapshot);
        const sessionCost = parts.total === null ? null : rubText(finiteNumber(parts.total.amountRub));
        const sessionCalls = parts.total === null ? 0 : finiteNumber(parts.total.calls) ?? 0;
        const peak = peakOf(snapshot);

        const factor = peak === null ? null : multiplierText(peak.multiplier);
        const label = t('balance') + ': ' + cell.text +
          (sessionCost !== null ? ' · ' + t('session') + ' ' + sessionCost : '') +
          (peak === null ? '' : '. ' + t('peakNow') + ': ' + (factor === null ? t('peakOngoing') : t('peakMultiplier') + ' ' + factor));

        // The dock row carries NO branding: balance, then this session's spend behind the session
        // glyph (which replaces the separator dot) - no word, no brand mark.
        // No `title` attribute: it renders a native browser tooltip on hover, which the user asked
        // to remove. `aria-label` keeps the accessible name for screen readers without any visual.
        const triggerHint = label + '. ' + t('panelHint');
        // While a peak surcharge is active the balance figure is red, so the warning is visible
        // without opening the panel.
        const segments = [h('span', { className: peak === null ? 'dsr-value' : 'dsr-value dsr-peakAmount', key: 'bal' }, cell.text)];
        if (sessionCost !== null) {
          segments.push(
            h('span', { className: 'dsr-session', key: 'sess' },
              h(SessionGlyph, { size: 11 }),
              h('span', { className: 'dsr-sessionValue' }, sessionCost),
            ),
          );
        }

        const trigger = h(
          'button',
          {
            type: 'button',
            className: 'dsr-trigger',
            ref: triggerRef,
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': triggerHint,
            // Click-only: no onMouseEnter/onMouseLeave (hovering must not open it) and no
            // onFocus/onBlur (keyboard focus must not pop the panel either).
            onClick: onTriggerClick,
          },
          segments,
        );

        let panel = null;
        if (open) {
          const content = h(Panel, { t: t, snapshot: snapshot, position: position, panelRef: panelRef });
          let portal = null;
          try {
            portal = typeof document !== 'undefined' ? document.body : null;
          } catch (error) {
            portal = null;
          }
          let createPortal = null;
          if (portal !== null) {
            try {
              createPortal = require('react-dom').createPortal;
            } catch (error) {
              createPortal = null;
            }
          }
          panel = typeof createPortal === 'function' ? createPortal(content, portal) : content;
        }

        element = h('div', { className: 'dsr-root', ref: rootRef }, h('style', null, CSS), trigger, panel);
      } catch (error) {
        element = h('div', { className: 'dsr-root' }, h('span', { className: 'dsr-trigger' }, '—'));
      }
      return element;
    }

    /**
     * Translate a key. The plugin serves a Russian service (routerai.ru, rubles), so its copy is
     * always Russian regardless of the Harness UI language: there is deliberately no `en` dictionary
     * and no fallback chain, and a missing key surfaces as the key itself rather than English text.
     */
    function fallbackTranslate(key) {
      if (Object.prototype.hasOwnProperty.call(RU_DICT, key)) return RU_DICT[key];
      return String(key);
    }

    /**
     * The Harness `locale` service is still used, but only to *register* the Russian dictionary so
     * other surfaces (and the Plugin Manager) can resolve this namespace. It is never asked to
     * select a language: binding would follow the UI locale and could hand back English.
     */
    function makeTranslator(ctx) {
      let locale = null;
      try {
        if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') {
          const service = ctx.get('locale');
          if (service !== null && service !== undefined) locale = service;
        }
      } catch (error) {
        locale = null;
      }
      if (locale === null) {
        try {
          if (ctx !== null && ctx !== undefined && ctx.locale) locale = ctx.locale;
        } catch (error) {
          locale = null;
        }
      }
      if (locale === null || typeof locale.register !== 'function') {
        return fallbackTranslate;
      }

      const disposers = [];
      try {
        const disposeRu = locale.register(NS, 'ru', RU_DICT);
        if (typeof disposeRu === 'function') disposers.push(disposeRu);
      } catch (error) {
        /* a namespace already owned by someone else: the inline copy still works */
      }

      if (disposers.length > 0 && typeof ctx.effect === 'function') {
        try {
          ctx.effect(function () {
            return function () {
              for (let index = 0; index < disposers.length; index += 1) {
                try {
                  disposers[index]();
                } catch (error) {
                  /* ignore */
                }
              }
            };
          }, 'routerai-usage: locale dictionary');
        } catch (error) {
          /* the dictionary stays registered for the page lifetime */
        }
      }

      return fallbackTranslate;
    }

    function apply(ctx) {
      // Resolve the translator once per apply and hand it to the entry through a closure wrapper; no
      // module state, so a collapse/reinstall cycle cannot leave a stale translator behind.
      let t = fallbackTranslate;
      try {
        t = makeTranslator(ctx);
      } catch (error) {
        t = fallbackTranslate;
      }
      const stableT = t;
      function BoundUsageDock(props) {
        return h(UsageDock, Object.assign({}, props, { t: stableT }));
      }
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'routerai-usage',
            order: 20,
          },
          BoundUsageDock,
        );
      });
    }

    return {
      inject: ['slots'],
      apply: apply,
    };
  },
});
