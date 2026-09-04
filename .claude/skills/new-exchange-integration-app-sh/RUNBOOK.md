# app-sh — new exchange runbook

Canonical source: `new-exchange-integration` (private `skills` repo). This
is a scoped excerpt — see [SKILL.md](SKILL.md) for the narrative version.

## Where this sits

Repo **3 of the public pipeline** (exchange-connector-sh →
websocket-connector-sh → **app-sh** → paper-trading-sh → backtester →
main-dash-sh → content → docker-sh). Depends on `exchange-connector-sh`'s
adapter existing (you're testing bot-engine branches against its real
shape) and benefits from `websocket-connector-sh`'s streams being live for
end-to-end testing, though the schema/cron/engine code can be written in
parallel with the streams work. `paper-trading-sh` depends on this repo's
paper-mapping ladder.

## Checklist

```
[ ] types.ts                    (ExchangeEnum + wsCode? if WS symbol != REST)
[ ] graphql/schema.ts           (enum values + wsCode field — GraphQL contract)
[ ] db/schema.ts                (wsCode Mongo field — only if using wsCode)
[ ] bot/main.ts                 (is<Name> getter + symbol-code/futures branches — LIVE BOT LOGIC)
[ ] exchange/helpers.ts + exchange/paper/utils.ts  (paper→real mapping)
[ ] utils/cron/exchange.ts      (exchange-info sync list + wsCode compare)
[ ] utils/index.ts              (futures/coinm classification lists)
[ ] indicators/service.ts       (indicator wiring)
[ ] confirm authHeaders.code / broker-code plumbing reaches the adapter's order-placement path
[ ] CHANGELOG + version bump
```

## Verify before calling it done

- `bot/main.ts` branches are covered by whatever this repo's test suite
  looks like for other exchanges — this is live trading logic, don't ship
  it undertested.
- The paper→real mapping here and the one in `websocket-connector-sh`'s
  `utils/common.ts` agree exactly (same enum members on both sides).
- GraphQL schema changes are actually consumed correctly by a dashboard
  build against this schema before merging (a schema-only PR that no
  dashboard has tried yet is a common source of "works in isolation, breaks
  downstream").
