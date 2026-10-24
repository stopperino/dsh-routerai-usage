# dsh-routerai-usage

Balance and per-request cost for [RouterAI](https://routerai.ru) inside the DeepSeek Harness Web UI.

Shows the account balance plus what the current session has actually spent — including every
subagent the session spawned — under the composer, with a hover panel breaking the spend down by
provider and by model.

```
505,14 ₽   ◎ 147,04 ₽
```

Hover the figure to see the breakdown:

```
◈ routerai                                    505,14 ₽
всего 147,04 ₽ · 848 запросов
в т.ч. субагенты: 33,35 ₽ · 222 запроса
По провайдеру
  byteplus                       822 запроса · 141,27 ₽
По модели
  deepseek-v4.1-flash            848 запросов · 147,04 ₽
```

## Why the cost is exact

RouterAI bills through a routed provider, which does **not** follow the public list price. For
`deepseek/deepseek-v4.1-flash` the real charge was measured at a constant **2.793×** the list-price
estimate. A plugin that multiplies tokens by list prices is therefore wrong by a factor of ~3, so
this one asks RouterAI for the settled amount instead:

```
GET https://routerai.ru/api/v1/generation?id=<generation-id>   →   data.total_cost   (rubles)
```

The generation id comes from the Harness session log itself
(`assistant/message` → `message.source.replayState.response.responseId`), so no request has to be
intercepted or replayed.

## Traffic

Every settled charge is cached by generation id. A generation id names one immutable, already-billed
request, so its cost never changes and the cache can never go stale. Reopening a session that is
already cached costs **no upstream request at all** — measured: 848 rows resolved in ~12 ms, versus
~4 s and hundreds of requests when cold.

The cache stores only `generationId → rubles`. No tokens, no models, no prompts, no session
content. It is written atomically and is ignored if unreadable.

## Install

```bash
# from this directory
dsh plugin install /absolute/path/to/dsh-routerai-usage
```

or add it to a profile and enable the bundle `dsh-routerai-usage`.

## Configuration

The row accepts these options in `cordis.patch.yml`:

```yaml
- id: routerai-usage
  name: dsh-routerai-usage
  config:
    pollSeconds: 30                          # balance refresh interval
    baseURL: https://routerai.ru/api/v1      # API root
```

## Credentials

The RouterAI API key is read through the Harness credential service under the reference name
`ROUTERAI_API_KEY` — the same reference the `routerai` LLM provider uses. The plugin never writes it
anywhere, never logs it, and never returns it to the browser. If it is missing, the widget shows
«нет ключа» and the rest of the Harness is unaffected.

## What leaves your machine

Exactly two kinds of request, both to the RouterAI API you configure:

| Request | Purpose |
|---|---|
| `GET /credits` | account balance |
| `GET /generation?id=…` | the settled cost of one already-billed request |

Nothing is sent to the plugin author or any third party, and there is no telemetry.

## Compatibility

Built against DeepSeek Harness `0.2.1-rc.3`. The client half registers into
`conversation.composer.dock` and uses only `--dsw-alias-*` theme tokens (each with a fallback), so a
renamed token degrades the look instead of breaking rendering.

## License

MIT — see [LICENSE](LICENSE).
