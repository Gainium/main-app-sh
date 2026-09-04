---
name: new-indicator-integration-app-sh
description: This repo's slice of adding a brand-new indicator to Gainium — types/db/graphql wiring, and the public v2 REST API + AI-agent contract that's easy to forget. Instantiation goes through the indicators factory, not a hand-written switch. Use when scoping or implementing a new-indicator PR in app-sh.
---

# New indicator integration — app-sh's part

Canonical source: `new-indicator-integration` in Gainium's internal
`skills` repo (private — this file is a scoped copy synced from there; edit
the source, not this copy, if it needs updating).

## Global objective

Gainium's indicator math is written once in `@gainium/indicators` and
consumed four times. This repo is the bot engine — what actually runs a
bot's indicator conditions against live candles — plus the public API
surface third-party integrations and the in-app AI agent use to build bots
that reference indicators.

## This repo's part

1. **Bump the deps** — `@gainium/indicators` (and `@gainium/backtester`
   once that repo's version is published) in this repo's `package.json`,
   `yarn install`.
2. **Types** — `types.ts`: `IndicatorEnum` entry; `IndicatorHistory` union
   member (import the result type from `@gainium/indicators`);
   `IndicatorConfig` union member (**skip for a filter** — it isn't
   factory-instantiated); `SettingsIndicators` optional per-indicator
   fields + supporting enums.
3. **DB schema** — `src/db/schema.ts`: new fields on the bot
   indicator-settings sub-schema. A field missing here gets silently
   stripped by Mongoose on save — a real failure mode, not just a type
   error.
4. **GraphQL** — `src/graphql/schema.ts`: enum value on `IndicatorsEnum`,
   and the fields on **both** the `indicatorSettings` input and
   `indicatorSettingsType` output. Both dashboards consume this schema
   directly.
5. **Public REST API v2 + AI agent contract** — `src/server/v2/` ⚠️ **easy
   to forget, do it anyway.** This is the `api.gainium.io` `/api/v2/*`
   surface consumed by `gainium-mcp`, `n8n-nodes-gainium`, and
   `chrome-extension`, and the contract the AI bot-builder reads:
   - `validators/bots/config.ts` — accept/validate the new fields on bot
     create/update (skip this and the API rejects the indicator entirely).
   - `botDefaults.ts` — default config for the new type.
   - `openapi-v2.yaml` — the public OpenAPI spec.
   - `definitions/generated.ts` — **generated**, regenerate via
     `src/utils/generate-definitions.ts`, don't hand-edit.
   - `AI_API_GUIDE.md` + `SCHEMAS.md` — the LLM-facing docs the in-app AI
     agent reads; add the new indicator + its params so agent-created bots
     can actually use it.
6. **Instantiation is via the factory, not a switch.**
   `src/indicators/{service,worker}.ts` call `createIndicator(config)` /
   `feedCandle(...)` / `getWarmupCandles(...)` from `@gainium/indicators`.
   Write **no per-indicator branch** here for a normal indicator —
   registering it in the `indicators` package's factory is what makes it
   work.
7. **Bot signal reaction** — `src/bot/dcaHelper.ts`:
   - Normal indicators flow through the existing subscription →
     `checkIndicatorConditions()` path — usually nothing to add.
   - **A time/calendar filter needs bespoke logic**: a start/stop timer
     pair polling the filter function every ~60s and pushing synthetic
     history entries, plus excluding it from the normal Redis candle
     subscription. Copy this only for time filters.
8. **Test harness** — `src/indicators/test.ts` + `yarn indicators:test`:
   add a config block for the new type, eyeball the streamed results.

Commit here first, then `app` (outer repo) bumps the `core` pointer to
this commit.

## Sister repos

All public, same repo family as this one:

- **indicators** — the math + factory this repo's instantiation calls into
  directly; no per-indicator branch needed here for a normal indicator
  because of it.
- **backtester** — the parallel engine that does **not** use the same
  factory; needs its own separately-written wiring, kept in sync by hand.
- **main-dash-sh** — the dashboard core; consumes the GraphQL schema this
  repo defines directly.
- **content** — the help doc a bot-settings UI (built from the dashboard's
  catalog) links to; not this repo's concern directly.

Gainium's main-app outer app (bumps this repo as `core/`, ships as part of
the self-hosted bundle too) is where the `core` pointer bump lands after
this repo's PR merges — that's the only thing left for a normal indicator
on the main-app side.
