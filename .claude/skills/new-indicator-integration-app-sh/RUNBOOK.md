# app-sh — new indicator runbook

Canonical source: `new-indicator-integration` (private `skills` repo). This
is a scoped excerpt — see [SKILL.md](SKILL.md) and the global
`new-indicator-integration` skill's `RUNBOOK.md` for the full order.

## Where this sits

**Step 3a.** Depends on `indicators` (step 1) and `backtester` (step 2)
being published — bump both deps first. Unlocks `app` (step 3b, bumps the
`core` pointer to this commit).

## Checklist

```
[ ] bump @gainium/indicators + @gainium/backtester in package.json, yarn install
[ ] types.ts                    (IndicatorEnum, IndicatorHistory, IndicatorConfig — skip config for a filter, SettingsIndicators fields)
[ ] src/db/schema.ts            (new fields on indicator-settings sub-schema)
[ ] src/graphql/schema.ts       (enum + input + output type fields)
[ ] src/server/v2/validators/bots/config.ts   ← MANDATORY, easy to forget
[ ] src/server/v2/botDefaults.ts
[ ] src/server/v2/openapi-v2.yaml
[ ] src/server/v2/definitions/generated.ts    (regenerate, don't hand-edit)
[ ] AI_API_GUIDE.md + SCHEMAS.md
[ ] src/bot/dcaHelper.ts        (only for a filter: start/stop timer + exclude from candle subscription)
[ ] yarn indicators:test
[ ] CHANGELOG + version bump
[ ] commit here, then have `app` bump its core pointer to this commit
```

## Verify before calling it done

- `yarn indicators:test` prints sane results for the new type — this
  exercises the factory path end to end, not just a compile check.
- A bot created directly via `/api/v2/*` (or through the in-app AI agent)
  with the new indicator's config actually validates and saves — this is
  the check that catches a skipped `server/v2/` layer, which nothing else
  in this checklist forces you to notice.
- GraphQL input and output both round-trip the new fields: save a bot's
  indicator settings, reload, confirm nothing was dropped.
- DB schema accepts the new fields — check Mongoose didn't silently strip
  anything on save (an absent field in the saved doc, no error thrown).
