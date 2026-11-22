# pi-refuseless-tether — provider details

The reference behind the [README](README.md): exact login, catalog, effort, pricing, credit and retry semantics, and what was and wasn't verified.

A native [Refuseless](https://refuseless.com) provider for [Pi](https://pi.dev): validated API-key login, an authenticated live model catalog, reasoning controls, token pricing and credit visibility.

## Install

```sh
pi install npm:pi-refuseless-tether
```

Requires the native provider API in Pi 1.5.2 (the tested version) or a compatible newer version, and Node.js 22+. No runtime dependencies beyond Pi's host packages.

To try a local checkout without installing it:

```sh
pi -e /absolute/path/to/pi-refuseless
```

## Get a key

Sign up at [refuseless.com](https://refuseless.com), then create an API key in your account.

## Login and select a model

Run `/login`, select **Refuseless API key**, and paste your key into the secret prompt. Leading/trailing whitespace is removed. Empty keys are refused; a free `GET /v1/credits` must succeed before Pi saves the credential. A 401 gives an invalid/expired/revoked-key error. A gateway/WAF can instead return 403; that also refuses login.

Pi owns credential storage in its selected agent directory and implements `/logout`. The package never writes keys itself. Alternatively, supply `REFUSELESS_API_KEY` through your existing secret manager/environment. A stored key takes precedence. Logging out removes the stored key, not an environment variable; unset that variable to stop using its fallback.

Use `/model` to select Refuseless, or:

```sh
pi --model refuseless/deepseek-v4.1-flash-fast --thinking off
pi --list-models refuseless
```

The catalog is fetched with your key from `/v1/models`. It reflects account-specific access and current rates. Pi persists the snapshot in its own model store, so `--offline --list-models refuseless` and `--offline -p` can select cached models. Offline mode disables catalog network activity, **not inference**. A first-ever offline start without a snapshot has no Refuseless models. A failed refresh retains the previous snapshot; a successful empty list clears it. Opening Pi's model picker refreshes through Pi's native catalog path.

On Pi 1.5.2, newly registered providers are restored cache-only before initial model selection. The awaited extension factory therefore primes the catalog once when online, using the selected agent directory's stored API-key credential or environment fallback, and publishes the result through Pi's generation-checked model store. There is no separate catalog cache or periodic timer. Prices can change after a snapshot; refresh the catalog for current rates.

### Names, images and output limits

Names are deterministic readable versions of IDs. **“(refusal-removed weights)” comes only from `abliterated: true`**, never from an ID suffix. Image input is enabled only when `vision: true`. Context windows come from `context_length`; entries missing a usable ID/context, malformed rates/efforts, or non-USD pricing are skipped individually instead of hiding valid models or inventing metadata.

The catalog does **not** expose maximum output lengths. The package uses **131,072 tokens**, capped by context length, as a documented fallback from [Refuseless's official Pi example](https://docs.refuseless.com/sdks.md), not a measured checkpoint capability. Every model retains a `maxTokensSource` annotation. Requests may end sooner because of checkpoint limits, available credits or model behavior.

### Reasoning effort

Effort levels are read per model from the authenticated catalog. To generate a table from a saved catalog response, run `node scripts/effort-table.mjs <catalog.json>` from a source checkout. Shift+Tab cycles only offered levels: unsupported levels map to `null`, so there are no duplicate-behaving `minimal`, `medium` or `xhigh` entries. Pi's native upward-then-downward clamp resolves requests for those levels to the next offered level (currently minimal→low, medium→high, xhigh→max). Unsupported `off` clamps to low. Supported `off` sends **`reasoning_effort: "off"`**, rather than omitting the field and accidentally invoking the server default.

A new CLI session with no explicit thinking selection starts at `reasoning_default`. CLI `--thinking` / model suffixes, scoped levels, per-model/global settings, and existing conversations win. Reloads/restores do not reset effort. Switching from a non-reasoning model uses the new model's default only when no setting chose a level; reasoning-model switches retain Pi's usual carried level. Embedded SDK callers should set an explicit level after startup if their selection's provenance is not visible to extensions; Pi does not expose that provenance in `session_start`.

## Pricing and usage

Prices are USD per million tokens, directly from the authenticated catalog:

```text
cost = uncached_prompt_tokens × input_per_m / 1e6
     + cached_prompt_tokens   × cached_input_per_m / 1e6
     + completion_tokens      × output_per_m / 1e6
```

Completion tokens include reasoning tokens. Cache write cost is zero. Missing pricing yields zeros (unknown cost, **not a promise of free inference**). Discounts are already included in returned rates. Above a `long_context.threshold`, the tier applies to the **whole request, including output**; Pi's `calculateCost` uses the same strict-greater-than threshold and includes cached input when choosing the tier. Zero/missing-price entries and long-context behavior are tested.

## Credits

In interactive Pi or RPC, `/refuseless` shows `available`, `balance`, `reserved`, `key_limit`, `key_spent`, and the active Refuseless model's pricing. The footer shows **Refuseless $X.XX** using _available_ credit, not total balance, while a Refuseless model is selected. It refreshes at session start, model selection, agent start and after each turn. Failed reads mark retained values stale. Pi 1.5.2 has no auth-change event: an idle footer catches up on the next turn or `/refuseless` after login/logout.

Reads are coalesced and spaced at least one second apart to respect the API's 60 credits reads/minute/key limit within this extension instance. Very fast turns reuse the last value. Other Pi processes or clients sharing the key also consume that server limit; there is no cross-process limiter. A 429 never triggers a package polling loop. UI notifications/footer are unavailable in `-p` and JSON modes; RPC UI notifications were tested.

Before a request, known available credit is compared with an estimated worst-case hold: conservative UTF-8-byte text prompt estimate (including tool definitions, excluding image data), plus the requested output ceiling at current uncached rates. A low balance produces a **warning, never a block**, at most once per agent run. This is not an exact tokenizer or an image-token estimator, and the server can estimate differently. Plan/promotional allowances can allow calls even with zero paid credit. Top up or reduce the requested output if a reply is cut short.

## Errors and compatibility

Refuseless HTTP statuses and error codes are surfaced by Pi's OpenAI Chat Completions adapter. `402 insufficient_credits` adds top-up and `/refuseless` guidance; mid-stream credit errors remain errors, not successful partial answers. Free metadata requests give sanitized status/code errors rather than reflecting arbitrary server bodies.

`429 model_busy` / `model_warming` and 5xx errors use Pi's ordinary retry policy. Pi 1.5.2 defaults SDK/provider retries to zero; its outer agent retry does not itself read `retry-after`. A small transport wrapper therefore remembers the server's not-before time after a 429 and waits before the **next host-authorized request** for that model, with cancellation support. It adds no attempts, retry loop, retry count or invented delay; the delay comes only from the actual header. If Pi's SDK retries are enabled, they already wait and the wrapper adds no second wait. Both default-path gating and native SDK retry-after are tested with synthetic 429s; real saturation and credit depletion were not induced.

Requests use the system role for instructions, OpenAI-style reasoning effort, `max_tokens`, and stream usage. The provider disables OpenAI `store` and uses Pi's existing adapter to preserve reasoning content.

## Migrate from models.json

A `refuseless` provider/model entry in `models.json` overrides package models with the same IDs, including stale prices, input capabilities and effort maps. Back up your configuration, remove the old `refuseless` entry (leave unrelated providers alone), install this package, then `/login` or use the environment fallback and reload Pi. Do not copy a literal key into package files or diagnostics.

## Development

```sh
npm install
npm test
npm run typecheck
npm run scan:public
```

Development dependencies are pinned to the versions used for qualification; Pi host packages remain wildcard peer dependencies. Tests cover catalog conversion/persistence, native cost tiers, reasoning clamping/wire payloads, validated login/logout, key-change races, credits, UI hooks, streamed errors, server-directed cancellation and retry-after under both host retry paths.
