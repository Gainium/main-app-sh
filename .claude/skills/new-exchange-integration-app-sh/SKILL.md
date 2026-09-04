---
name: new-exchange-integration-app-sh
description: This repo's slice of adding a brand-new exchange to Gainium — bot engine wiring, GraphQL/DB schema, exchange-info cron, and paper-mapping. Easy to under-scope as "just a submodule bump" — it isn't. Use when scoping or implementing a new-exchange PR in app-sh (main-app-sh).
---

# New exchange integration — app-sh's part

Canonical source: `new-exchange-integration` in Gainium's internal `skills`
repo (private — this file is a scoped copy synced from there; edit the
source, not this copy, if it needs updating).

## Global objective

Gainium supports trading on multiple exchanges through a common internal
`Exchange` interface — one adapter per exchange (in `exchange-connector-sh`)
so the rest of the platform never has to know which exchange it's talking
to. This repo is the core of the bot engine: it's what actually runs bots
against that adapter, exposes the exchange over GraphQL, and keeps exchange
metadata in sync.

## This repo's part

This repo is easy to under-count as "the app just bumps a submodule
pointer" — it isn't. Real logic lives here:

- **`types.ts`** — `ExchangeEnum` members (this repo is one of several
  places the enum is independently declared), plus an optional `wsCode?` on
  `ExchangeInfo` if the exchange's WS symbol differs from its REST symbol
  (check `exchange-connector-sh`'s adapter for whether it introduced one).
- **`src/graphql/schema.ts`** — the new enum values in the GraphQL schema,
  plus the `wsCode: String` field if applicable. This is the contract the
  dashboards consume — miss it and they can't send/receive the new ids.
- **`src/db/schema.ts`** — Mongo schema: the `wsCode` field on the
  exchange-info doc, only if `wsCode` is in play.
- **`src/bot/main.ts`** — the **bot engine**. Any exchange whose
  symbol/precision/position handling deviates from the default (Binance-
  shaped) needs a branch here — an `is<Name>` getter used in symbol-code
  resolution and futures-position logic is the usual shape. **This is the
  highest-risk edit in this repo** — it's live bot behavior; treat with the
  same care as any other change to code trading real money.
- **`src/exchange/helpers.ts`** + **`src/exchange/paper/utils.ts`** — the
  paper→real enum mapping ladder. Keep it in sync with the equivalent map
  in `websocket-connector-sh`'s `utils/common.ts`.
- **`src/utils/cron/exchange.ts`** — the cron that periodically syncs
  exchange-info (pairs/symbols/precision) into Mongo. Add the new variants
  to its exchange list; if using `wsCode`, it now compares `wsCode`
  alongside symbol code to detect changed pairs. This cron is also what
  pulls Gainium's broker/affiliate codes on a schedule — the new exchange
  needs to be in the enum before a code can be created for it.
- **`src/utils/index.ts`** — the futures/coinm classification lists. Several
  helpers branch on these; add every new variant this exchange supports.
- **`src/indicators/service.ts`** — indicator service wiring; expect
  indicator-tuning follow-ups per exchange after launch.
- **Order placement** — the exchange's broker/affiliate code is attached to
  outgoing orders as `authHeaders.code` on the request this repo builds for
  the adapter. If this exchange has a broker/affiliate program, that flow
  needs the exchange's code available (created and published on the
  Gainium side) before it does anything — see the platform's admin/ops docs
  for how that gets published; not something this repo's code alone
  controls.

## Sister repos

All public, same repo family as this one:

- **exchange-connector-sh** — the adapter this repo's bot engine talks to.
  Confirm its `Exchange` interface shape before writing the `bot/main.ts`
  branches above.
- **websocket-connector-sh** — the streams; this repo's cron and the
  paper-mapping ladder must stay in sync with its `ExchangeEnum` and
  `mapPaperToReal`.
- **paper-trading-sh** — the paper-trading mirror, downstream of the
  mapping this repo defines.
- **main-dash-sh** — the dashboard core; consumes this repo's GraphQL
  schema directly.
- **backtester** — the shared backtest lib; this repo bumps to whatever
  version adds the new exchange's `ExchangeEnum`.
- **content** — the "connect via API keys" guide the dashboard links to.
- **docker-sh** — the self-hosted release bundle this repo ships inside of.

Gainium's cloud SaaS wires a few more pieces on top of this stack
(paid-plan gating, an internal monitoring/admin layer, marketing pages) —
not part of the self-hosted deployment, not this repo's concern.
