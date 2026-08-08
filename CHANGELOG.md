# Changelog

## [1.51.2] - 2026-08-08

### Fixed

- Kraken USDⓈ-M Futures bots no longer latch into "Not enough balance" on an account that has funds. Kraken's flex account pools every collateral currency into one cross-margin pool, so the per-asset `free`/`locked` split in the cached `balances` doc cannot represent anything the venue enforces — and its two writers derived one anyway, in opposite directions, so the stored figure meant whichever write landed last. The not-enough-balance latch read that figure and broke both ways: on the wallet-quantity convention it cleared the latch and sent an order the venue then refused for insufficient funds; on the other it suppressed every order from then on, with no way back, because the cached number could never rise above the required amount. The latch now confirms against the venue's own `availableMargin` before clearing, and the error message reports that same figure instead of a wallet total the venue will not let the bot spend. The venue is consulted only for a bot that is already in the failing regime — never on the healthy order path — and every non-pooled venue keeps the existing cached-balance behaviour unchanged.

## [1.51.1] - 2026-08-07

### Fixed

- A stop loss that "move SL" had already pushed into profit no longer closes a deal at a loss. Once the move fires, the deal's stop sits on the profit side of the average entry and can only be reached on the way back from profit — but the check only compared the price to the stop level, so as soon as the market ran past that level the wrong way (safety orders pulling the average through it), the very next tick closed the deal at market. Two BTCUSDT deals on one short bot were closed 3.8% down this way. The stop now only triggers while the deal is still on the profit side of its entry; ordinary loss-side stops are unaffected.

## [1.51.0] - 2026-08-07

### Added

- An application embedding this package can now own how a stored credential is written, not only how it is read. With nothing registered, credentials are written exactly as before.

## [1.50.3] - 2026-08-06

### Fixed

- Orders that never received an exchange order id are no longer looked up on the exchange. On Coinbase, Kraken and KuCoin full futures an order can only be fetched by the id the venue assigns it, and until that id arrives the order carries a placeholder — which was being sent as if it were a real id. Every check of such an order cost two futile exchange calls and an error line; one grid bot re-checking 17 of them on each stream reconnect produced 39 exchange errors in a minute. The checks now answer immediately, with the same verdict the exchange was giving.

## [1.50.2] - 2026-08-06

### Fixed

- Recognise two more ways an exchange says a position is already closed, so those deals finish instead of being retried on every restart. Rejections are now matched on letters and digits alone, so a venue wording the same condition as a code rather than a sentence is still understood.

## [1.50.1] - 2026-08-06

### Fixed

- Order quarantine could count a freshly-placed order against itself. Some exchanges answer "unknown order id" for an order they were handed moments ago — that is the exchange describing its own propagation lag, not a missing order. A not-found now only counts once the order has gone untouched for `BOT_ORDER_QUARANTINE_MIN_AGE_MS` (default 24h); an order with no usable timestamp is never counted at all.
- Quarantine strikes are now genuinely consecutive, as documented. A successful lookup clears them, including on the common path where a resting order comes back unchanged and is not written back — previously strikes accumulated for the life of an order, so three unrelated blips months apart could quarantine a live one.

### Added

- Hyperliquid's `unknownOid` is now recognised as a definitive not-found, so its stale orders stop being re-probed on every restart. Safe only in combination with the age floor above, because Hyperliquid uses that same answer for both a long-gone order and a just-placed one.

## [1.50.0] - 2026-08-06

### Added

- Orders the exchange repeatedly reports as non-existent are now put in a polling quarantine instead of being re-checked forever. An order that has been gone for months used to cost a failed lookup on every single restart — on venues that sleep-and-retry before admitting an order is missing, that is tens of seconds each. After `BOT_ORDER_QUARANTINE_STRIKES` (default 3) separate checks each get a definitive "no such order" from the exchange, the bot stops asking. Set `0` to disable.
- Quarantine only ever stops the bot *asking* about an order — it never stops the bot *hearing* about one. A quarantined order stays subscribed to the live order stream, stays in the bot's order list, and is still cancelled when the bot stops. If the exchange mentions it again for any reason, the quarantine is dropped immediately. Restarting the bot re-checks everything, so there is always a way back.

### Fixed

- A failed order lookup no longer discards the exchange's explanation. "This order does not exist", "the request timed out" and "you are rate limited" were all collapsed into the same message, because the branch that read the reason was unreachable — which is why nothing could tell a genuinely missing order from a temporarily unreachable exchange. Only the first of those now counts towards quarantine.

## [1.49.4] - 2026-08-06

### Fixed

- A single bot can no longer stretch a service restart by minutes. The restart-time order check asks the exchange about each open order one at a time, so a bot holding orders the venue no longer recognises paid the full failed-lookup cost for every one of them while the rest of the fleet waited. That check now has a per-bot time budget (`BOT_RESTART_PROBE_BUDGET_MS`, default 60s, `0` disables): once it is spent the bot stops probing and the orders are left to the user stream, the reconcile sweep and the fill-failsafe, which already own that job. Normal running behaviour is unchanged — the budget only arms during a service restart.

## [1.49.3] - 2026-08-06

### Fixed

- Cancelling a Combo deal no longer discards the profit it had already made. A Combo deal banks profit as each minigrid round-trip completes, but cancelling one credited nothing to the bot's total or to the profit history — the amount stayed visible on the deal and was counted nowhere else. Cancelling a deal that never traded is unchanged.

## [1.49.2] - 2026-08-06

### Fixed

- A deal that started closing and did not finish stayed frozen after a restart: the "closing now" markers were restored from the cache as if the close were still running, so the bot refused to place orders for that deal and the close was never retried. They are now cleared on load, matching what the database load path already did.

## [1.49.1] - 2026-08-06

### Fixed

- Hedge bots now look their sibling leg up through an index instead of walking the whole bot collection, on every start, restart and close.

## [1.49.0] - 2026-08-06

### Changed

- Stored exchange and API credentials are now recovered through a single asynchronous module rather than at each call site, so an installation can keep them in a format only the host application is able to unwrap.

## [1.48.2] - 2026-08-06

### Fixed

- Reading a host-managed stored value through the synchronous path now fails loudly instead of returning an empty string. It previously fell through to AES, which does not signal failure on that input — the caller received `''` and used it as the credential, producing an authentication failure at the exchange with no exception anywhere.

## [1.48.4] - 2026-08-06

### Fixed

- An order held back by one of the local safeguards no longer leaves a cancelled-order record behind. Each attempt is issued under its own order id, so every held-back retry was filing a fresh record for an order that was never placed anywhere — on production these accounted for roughly a third of all stored orders. Orders that genuinely reached the exchange are recorded exactly as before.

## [1.48.3] - 2026-08-06

### Fixed

- The marker recording which scheme a bot's not-enough-balance counters were written under was not declared on the stored bot, so it was silently dropped every time the bot saved. The one-time clean-up it guards therefore ran again on every restart, clearing the counters and making the safeguard re-arm from scratch — which costs a handful of pointless exchange calls per stuck order each time a worker restarts. Confirmed against production, where the marker read as absent on a bot whose counters had plainly been migrated.

## [1.48.2] - 2026-08-06

### Fixed

- A hedge bot whose paired bot had been deleted crashed while restarting, silently: it never came back, never reported in, and failed the same way on every subsequent restart.

## [1.48.1] - 2026-08-06

### Fixed

- The count of bots that failed to come back after a restart was measured at the wrong moment and from the wrong place, so it reported every bot as missing even when all of them returned. It is now measured once the restart has had time to settle, and counts what the bot workers actually reported.

## [1.48.0] - 2026-08-06

### Changed

- A repeating bot error now updates one message and counts the repeats, instead of writing a new message every time it happens. The error list shows how many times a condition fired and when it first did, rather than the same error over and over.
- How often a given error is allowed to write a new message is now set per error type from the admin Bot Errors page, and takes effect within five minutes without restarting anything.
- Errors that are suppressed from users were being recorded on every single occurrence — they are now recorded once an hour by default, as they always should have been.
- Notifications and alerts for a repeating error are sent when it first happens, not on every repeat.

### Fixed

- Bot messages that a user has dismissed are now cleaned up after 30 days instead of being kept forever.
- Two internal error paths recorded messages under names that the classification system did not know about, so they could not be categorised or configured. They now go through the normal path.

## [1.47.0] - 2026-08-06

### Fixed

- A bot service that could not finish bringing every bot back after a restart would never begin accepting commands again, for as long as it kept running. Start, stop and edit requests for that bot type then sat unanswered until they timed out. The service now starts accepting commands once the bots are back, and also when the restart has clearly stopped making progress — in which case it says so loudly rather than going quiet.

### Added

- Restart telemetry: how long the bot lookup took, how long each bot took to come back, the slowest bots of the restart, and which bots never reported back — so a slow restart can be explained instead of guessed at.
- The wait for a reply from a bot service is now configurable rather than fixed at five minutes.

## [1.46.0] - 2026-08-05

### Changed

- The two separate cooldowns added for rejections that cannot succeed on retry — a permanent jurisdiction restriction, and an order the account cannot fund — now share one mechanism. Both hold the order back for a spell that widens each time the exchange rejects again, and both reset the moment the order goes through. Previously only one of them backed off, and the other kept its state in memory, so it was lost whenever a bot moved between workers or restarted; the shared version keeps it where every worker can see it.
- A jurisdiction restriction that the account holder resolves is now picked up within about five minutes instead of up to an hour, while one that is never resolved settles at the same hourly re-check as before.

## [1.45.1] - 2026-08-05

### Fixed

- Bots that could not fund an order kept asking the exchange to place it, over and over, instead of backing off. The safeguard meant to stop this counted failures per order price, but most orders are market orders carrying the live price, so consecutive retries were each filed under a new price and the count never built up to the point where the safeguard engaged. Failures are now counted per asset and direction — which is what a balance shortfall actually applies to — so the safeguard arms as intended. Once it does, the bot re-checks with the exchange on a widening interval rather than continuously, so a shortfall that clears is picked up quickly while one that persists stops generating traffic.
- The failure count is now capped. It previously grew without limit, and since a recovered balance only walks it back one step at a time, a long-running shortfall could leave a bot unable to clear the count and resume on its own.
- Counters recorded under the previous scheme are discarded the first time a bot records a new one, so stale entries no longer accumulate on the bot indefinitely.

## [1.45.0] - 2026-08-05

### Fixed

- A bot whose exchange account is barred from trading a pair for compliance reasons (for example Kraken refusing USDT pairs to residents of certain countries) kept re-sending the same order to the exchange every few minutes — one account produced 82 rejected attempts in four hours. That block is permanent until the account holder resolves it, so the order is now held back for up to an hour after each rejection instead of being retried. Nothing else changes: the bot reports the same error and the same status as before, and orders that close a position are never held back.

## [1.44.2] - 2026-08-05

### Fixed

- Hedge bots stayed silent after their first warning or error of a given kind. Recovering from an error clears a bot's active messages so the next occurrence can be shown again, but for hedge bots that clean-up looked under the individual leg while the messages are filed under the parent, so it never found them and the bot never spoke up again. Completes the fix in 1.43.4, which stopped the opposite problem — the same message repeating without end. Existing stuck messages clear themselves the next time the bot recovers from an error.

## [1.44.1] - 2026-08-05

### Fixed

- Exchange requests no longer pay a scheduling delay when no credential resolver is registered. The resolution step was awaited unconditionally, and awaiting a function that returns immediately still yields to the event loop, so every request paid for a step that had nothing to do — and any timing measured around it reported event-loop lag rather than real work.

## [1.44.0] - 2026-08-05

### Added

- Optional hook letting the host application supply its own way of reading a stored credential, for value formats this package does not define. Nothing is registered by default, so every existing installation is unaffected.
- Exchange request telemetry now records how long resolving that request's credentials took, so the cost is attributable instead of showing up as unexplained drift in the total.

### Fixed

- Reading a stored value whose format this package does not recognise now fails loudly instead of returning an empty string. It previously fell through to AES under the fallback key, which does not signal failure — the caller received `''` and used it as the credential, surfacing as an authentication failure at the exchange with no exception anywhere.

## [1.43.4] - 2026-08-05

### Fixed

- Hedge bots no longer repeat the same warning or error indefinitely. Every message a hedge bot's legs raise is filed under the parent bot, but the check that decides "this one is already showing, don't post it again" looked under the leg instead, so it never found the existing message and posted every occurrence. A single repeating condition could therefore bury a user in identical notifications. Non-hedge bots were unaffected.

## [1.43.3] - 2026-08-05

### Fixed

- Broker-code indexes no longer fail to rebuild when several services start at the same time. Each process dropped the collection's indexes before rebuilding them, so a process starting a moment later wiped an index another one was still building and that build aborted. The drop was a leftover from a one-off migration that has since completed; the index sync that follows it already reconciles any change on its own, so indexes are now left alone unless they actually differ.

## [1.43.2] - 2026-08-05

### Changed

- Connecting Hyperliquid without an approved builder fee now explains which approval is missing and how to grant it, instead of asking the user to "follow the instructions" without naming them.

## [1.43.1] - 2026-08-05

### Added

- Once a self-hosted installation has an encryption key of its own, the credentials already stored under the previous key are re-encrypted automatically. The api notices on startup that values are still under the old key and moves them in the background; it serves traffic throughout, does nothing once there is nothing left to move, and only ever runs in the api process. The manual command is unchanged and still available — set `ENCRYPT_KEY_AUTO_BACKFILL=false` to use it instead.

## [1.43.0] - 2026-08-05

### Added

- Bots on pooled-collateral futures accounts can now open deals funded by collateral held in another currency. Kraken Futures pools every collateral currency into one cross-margin account, so a wallet funded in EUR shows no USD balance at all — and since order sizing reads the pair's quote asset, such an account was rejected with "Not enough balance to start new deal ... available: 0 USD" even though the venue would have margined the position off the EUR without complaint. When, and only when, the ordinary quote-asset check has already failed, the balance check now asks the connector for the account's pooled USD margin and sizes off that instead. The common path is unchanged and costs no extra request; a venue reporting no pooled margin — every non-pooled exchange, the paper simulator, and any failed call — keeps the previous behaviour exactly, and the pooled figure is trusted only when USD really is the quote asset. Applies to DCA and combo bots.

## [1.42.0] - 2026-08-04

### Added

- Self-hosted installations can now use their own encryption key for the exchange API credentials their users store. Setting `ENCRYPT_KEY` makes new credentials encrypt under it; a new `cli:rotate-encrypt-key` command re-encrypts what is already stored, is safe to run while bots trade, and resumes if interrupted. Values written under the previous key stay readable throughout, so an installation can upgrade first and migrate later.
- The application now says so at startup when no encryption key of its own is configured, and tells the operator how to set one.
- The API can report whether an encryption key is configured, so the dashboard can recommend setting one. It answers yes or no and nothing else.

## [1.41.7] - 2026-08-05

### Fixed

- DCA bots could fail to build their deal orders instead of skipping the attempt. Two cases: when the exchange price lookup failed the price arrived as 0, which made the base quantity infinite — the bot logged a "Big number error" and still produced a take-profit order with an unusable quantity. And a bot scaling its safety orders by ATR/ADR with no "start DCA" indicator configured crashed outright while calculating the second safety order. Both now stop cleanly: a missing price is reported as "Latest price is 0" and no orders are generated, and the ATR/ADR case simply produces no safety orders as it already intended.

## [1.41.6] - 2026-08-04

### Fixed

- Using "reduce funds" more than once on the same DCA deal could close the whole deal instead of shrinking it. Each completed reduction is already recorded on the deal, and the take-profit sizing was subtracting it a second time from the filled sell orders it also counted — so the remaining position it calculated shrank twice as fast as the real one and eventually went negative. Once that number fell below the amount being withdrawn, the bot decided the withdrawal was larger than the position and closed the deal at market. On a reported deal of 813 base with 437 already withdrawn, the remaining position was computed as -61 instead of 376. Completed reductions are now counted once, so repeated reductions size correctly and the deal stays open. Deals that never used reduce funds are unaffected.

## [1.41.5] - 2026-08-04

### Added

- Exchange request timing can now record which connector instance served the request

## [1.41.4] - 2026-08-03

### Fixed

- Disconnecting an exchange connection could hang the request for minutes, and when it did, the account's fee, balance and per-exchange snapshot records were left behind with no way to clear them. Telling the running bots to close waited for each worker to acknowledge, using a one-shot listener that fired on whatever the worker said next — and a worker runs up to a hundred bots, all reporting on the same channel, so an unrelated bot's event consumed the acknowledgement and the wait never ended; a bot whose worker had already been restarted never returned either. The wait now matches the reply it is actually waiting for, gives up after a bounded time across the whole disconnect instead of stalling on one bot, and the close is still delivered either way. The sweep that finds those bots is also now scoped to the account being disconnected, so it uses an index instead of reading every bot on the platform (measured on 150,000 bots: 150,000 records examined and 264ms became 50 examined and 2ms, same bots matched). Finally, a bot service that fails to answer no longer aborts the rest of the disconnect: the connection's fees, balances and snapshots are cleaned up regardless, and the failure is logged.

## [1.41.3] - 2026-08-03

### Fixed

- The admin Bot Errors page read every bot message in the database on each load. It is the only fleet-wide reader of that collection — it filters by a date range and sorts newest-first without narrowing to a single user or bot — and no index covered the message timestamp, so the query had no usable plan and fell back to scanning all 2.58M records before joining usernames onto the handful it actually returned. The scan had climbed to roughly 2.5 minutes per load and was the second-heaviest query on the database, slow enough that a wide date range could also exhaust the sort memory limit and leave the page empty. Adding a timestamp index lets the query seek straight to the requested window and read the rows already in sort order: measured on a 2,580,000-record collection in the reported shape, 2,580,000 records examined and 3.4s became 79 examined and 12ms, with an identical result set. The one index serves both the default view and the "include hidden" view, and the results the page shows are unchanged.

## [1.41.2] - 2026-08-03

### Fixed

- Zero-priced markets in an exchange's ticker table silently forced a balance to $0.00, which left 1.41.1's fiat rates unreachable on the venue that motivated them. Exchanges list inactive markets at price 0 — Kraken Futures publishes `EUR-USD` at 0 — and `findUSDRate` takes the first pair matching the base/quote it wants, so that dead entry shadowed every later source: the fiat rate, the BTC cross, and the tokenized-stock fallback all became unreachable, and the holding valued at zero. Both valuation paths now drop non-positive and non-finite prices when building the rate table, so a dead market is treated as absent rather than as an authoritative price of nothing.

## [1.41.1] - 2026-08-03

### Fixed

- Fiat held as collateral (EUR, GBP, CHF, JPY, CAD, AUD) valued at $0.00 in the portfolio. Balances are priced in USD from the exchange's own ticker table, but a multi-collateral venue such as Kraken Futures publishes only its perpetual contracts (`PF_*`) there — no fiat pair exists to price against, so the lookup scored the holding zero. An account funded entirely in fiat therefore reported a total portfolio value of $0.00 and empty allocation charts, which reads as a broken exchange connection even though the balance itself was fetched correctly. The twice-daily rate job now also caches fiat→USD rates from Kraken's public ticker (the same source already used for USDT→USD) and both valuation paths — the portfolio snapshot cron and the on-request pricing helper — expose them under the `all` exchange, so fiat is valued like any other asset. Rates are stored pre-normalized to "1 unit = X USD", so pairs Kraken quotes with USD as the base (USD/JPY, USD/CHF, USD/CAD) are inverted once at write time rather than at every read; a pair that fails to fetch keeps its previous rate instead of dropping to zero until the next run.

## [1.41.0] - 2026-08-03

### Changed

- User passwords are now stored as bcrypt hashes instead of the reversible AES helper in `utils/crypto`. Previously a password could be decrypted back to plaintext with the shared key, so anyone who obtained a copy of the database obtained every password; a bcrypt hash cannot be reversed. The change is dual-read and needs no flag day: existing accounts still sign in normally and are silently rehashed on their next successful login, while sign-up, password change and the `cli:reset-password` utility write bcrypt from the start. An installation converts itself as its users log in — no downtime, no forced reset. New helper at `utils/password.ts`; adds a `bcryptjs` dependency (pure JavaScript, so it needs no native build step in the container image).

### Fixed

- `changePassword`'s "your new password is the same as your current one" check compared by decrypting the stored value, which cannot work once a password is a one-way hash. It now compares correctly, and does so for both stored formats.

## [1.40.5] - 2026-08-02

### Fixed

- `deleteExchange` awaited seven independent cleanup legs one at a time and filtered three of them so they could not use an index. The `linkedTo` clear, `stopBotByExchange`, `unassignBotByExchange`'s three `updateMany`s and the fee/balance/snapshot `deleteMany`s each waited for the one before it; `feeDb`/`balanceDb`/the bot collections were filtered on `exchangeUUID` alone, but those collections are indexed `{userId, exchangeUUID, …}`, so every disconnect COLLSCANned `fees`, `balances`, `dcaBots`, `comboBots` and `bots` in full — cost scaling with the platform, not the account. The independent legs now run under `Promise.all` (the shape `resetAccount` already uses) and every sweep carries `userId`, which is index-seekable and matches the same rows. Serial depth 7 → 2; `unassignBotByExchange` takes an optional `userId`.

## [1.40.4] - 2026-08-02

### Fixed

- `npm run lint` failed on a clean checkout, so husky's pre-commit hook rejected every commit. `getLatestOrders`' order filter was hoisted into a `const` so the page read and the count could share it, which dropped its contextual type and widened `status: 'FILLED'` to `string`; that broke `readData`'s `isArray` overload resolution and cascaded into 5 `tsc` errors. Annotated the literal with `OrderStatusType`.

## [1.40.3] - 2026-08-02

### Fixed

- `probeConnectionState`'s `PROBE_TIMEOUT_MS` was aliased to `VERIFY_TIMEOUT_MS`, so the accounts page's live re-probe of an ALREADY-STORED connection got `addExchange`'s full 30s budget. Every one of its timeouts resolves to the stored reading, so a wedged venue held `updateStatus` (which fans the probes out with `Promise.all`) for 30s to return a value it already had. Decoupled to its own 6s cap, and the timeout warn now names the connection's `provider` and `uuid` so the wedged venue is identifiable.

## [1.40.2] - 2026-08-02

### Fixed

- Every orphan sweep in `premanenetlyDeleteBots` converted `botId` with `$toObjectId`, which throws on the `'system'` sentinel platform notices use, so the aggregation failed and — because each step returns on its first error — aborted every remaining cleanup after it. The sweeps now start from a `$convert`/`onError: null` guard that both keeps the aggregation alive and keeps sentinel rows out of the orphan set.

## [1.40.1] - 2026-08-01

### Fixed

- `updateStatus` ran each connection's `verify` and `getHedge` serially and persisted a transport failure as a verdict, so one unreachable venue both stalled the accounts page and wrote `status:false`/`hedge:false` over healthy stored connections. Added `probeConnectionState` (concurrent pair, 30s cap, falls back to the stored reading) and an `unreachable` flag on `VerifyResponse` marking "no answer" as distinct from "bad keys".

## [1.40.0] - 2026-08-01

### Added

- `rotationFlag` on a user's exchange connections, marking a credential an operator has asked the user to replace, and `rotationRequired` on the exchange GraphQL type so the dashboard can show it. The flag clears from `editExchange`'s existing `credentialsChanged` signal, so a rename or a re-verify never counts as a rotation. Unused unless an operator sets it.

## [1.39.3] - 2026-08-01

### Fixed

- The API-key rejection message named the wrong capability. `withdrawalRejectionReason()` infers what to say from the `permissions` it is given, and the self-hosted add/edit-exchange resolvers never passed them — so every rejection read "permission to transfer funds between accounts" and offered a Bybit-specific instruction, even when the key was rejected for withdrawal on Kraken or Hyperliquid. Both resolvers now pass the observed permissions, and the message itself no longer infers one capability from the absence of the other: with no permissions it says only that the key can move funds, and the Bybit hint is offered on Bybit alone. The rejection log lines now record which capability was found.

## [1.39.2] - 2026-07-31

### Security

- Reject new API keys that can move funds between accounts, not just keys that can withdraw. Bybit's Account/Subaccount Transfer can move balances between a user's own accounts with no withdrawal scope; Gainium calls no transfer endpoint on any exchange, so the permission is never needed. Existing connections are still only flagged, never rejected.
- Rejection message now names the capability found and, for transfer, the exact exchange control to untick.

## [1.39.1] - 2026-07-31

### Fixed

- Indicators service `serviceLog` listener no longer throws on messages without a `.restart` field. `serviceLog` is a shared bus, and `redisServiceLogListener` cast the payload to `{restart: string}` and called `.startsWith()` on it unchecked, so every `priceConnectorAlive` beacon (websocket-connector ≥ 1.13.7, once per beacon interval — deliberately omits `.restart`), `userStreamFlap` and `userStreamAuthReject` produced a "Failed to parse message … TypeError" error line. Now type-guarded before the string call, mirroring the other consumers (`src/indicators/service.ts:processServiceLog`, `src/bot/main.ts`). Behaviour for `botService*` restarts is unchanged; only the throw becomes a no-op. Backport of the cloud-side fix shipped in main-app 2.57.2, which never reached this repo. Noise only — no functionality was lost, but ~1 440 error lines/day/process buried real errors. (issue #222)

## [1.39.0] - 2026-07-31

### Added

- Withdrawal-permission policy for exchange API keys (`src/exchange/keyPermissionPolicy.ts`). Gainium only ever needs read + trade, and withdrawal is never required by any feature; until now nothing verified that a stored key was actually limited that way. A key that can withdraw is now refused when it is newly supplied (add, or edit-with-new-credentials), and merely recorded on every other path — re-verification never rejects, so existing users' live bots are unaffected.
- `ExchangeInUser.keyPermissions` persists the last observed withdrawal / internal-transfer / IP-allowlist state (plus its timestamp) and is exposed on the `exchangeResponseData` GraphQL type. Declared in the Mongoose user schema — without that, every write would be silently dropped.
- `fetchKeyPermissions()` calls the connector's read-only `GET /keyPermissions` so a periodic audit can refresh the flags without running a verification that could alter a connection's status.


## [1.38.1] - 2026-07-31

### Fixed

- `verifyNormal` and `bybitAccountType` now carry a 30s axios timeout. Both go out with `sendtoall=true`, and the balancer fans those over its connector hosts serially at 5 minutes each, so with no timeout on our side one wedged connector could park an interactive `addExchange` for minutes. A verify timeout now returns a curated "the exchange did not respond in time" reason rather than falling through to the caller's generic "API keys not valid" text.

## [1.38.0] - 2026-07-30

### Added

- OKX Europe X-Perp futures (Phase 2 of the OKX-EU work): `getAccountFuturesExchangeInfo()` exchange-client counterpart, `updateOkxEuPerpPairs()` keyless cron refresh of the X-Perp universe into `pairs` as `source: 'my'` (real + paper ids), and `updateOkxEuSpotApproxPairs()` — a keyless EUR/USDC spot approximation that seeds EU spot until a real my.okx.com account connects (tracked via the new `approx` pair flag, never overwrites real data). EU futures adds now create only the Linear leg (the EU venue has no inverse product). Contributed by community member discord2020 (forum topic 4925).

### Fixed

- X-Perp pair symbols (`BASE-QUOTE_UM_XPERP`) no longer get torn apart by legacy `BASE_QUOTE` split parsing in deal-start pair validation, bot pair checks, the v2 create-bot validators, and server-side backtest pair resolution (fix by discord2020).
- `updateOkxEuPairs()` now takes plaintext keys and encrypts internally — passing already-encrypted keys corrupted the passphrase on decrypt (fix by discord2020).

## [1.37.12] - 2026-07-30

### Fixed

- **The notifications feed still took up to 18 seconds for accounts with a very large message history, even after the index added in 1.37.9.** That index removed the in-memory sort but left `paperContext` and `isDeleted` as filters Mongo could only apply after loading each document, so the feed still read every message the account had ever received — and then read them all a second time to produce the total. On a seeded 801,949-message account the live feed examined all 801,949 documents to return 2 rows (11.0s), and the paper feed returned 793,679 rows / 308MB of JSON in 22.7s to fill a panel that shows 20. Both filters are now written as exact value lists rather than "not equal" / "does not exist" tests, which lets a new index cover them while still supplying the newest-first order: the live feed drops to 2 documents examined and about 10ms, the paper feed to ~250ms.
- The feed's default load, which the dashboard sends with no paging parameters at all (including the navbar mount that only wants unread counts), was **unbounded** — it fetched and serialised the account's entire message history. It is now capped well above what the panel can display, so smaller accounts are byte-for-byte unchanged.
- The accompanying total is capped the same way instead of counting every matching message, which was on its own about a third of the delay. Accounts above the cap now report the cap rather than an exact figure; the current dashboard does not display this value, and the legacy notifications page uses it only to size its pager.

## [1.37.11] - 2026-07-30

### Fixed

- **Live indicators stopped receiving realtime candles after every price-connector restart and only recovered when the indicators process itself restarted.** Candle subscriptions live only in the connector's memory, so it broadcasts `{restart:'priceConnector'}` on `serviceLog` to make consumers re-request them — but that publish never actually went out (fixed connector-side in websocket-connector-sh 1.13.7), and even when it does, Redis pub/sub gives no delivery guarantee. A consumer that misses it stays subscribed to a channel nobody publishes to, invisibly: `checkCandle` keeps back-filling each close from the archive, so indicator values still look plausible while realtime intra-candle updates are gone. `processServiceLog` now also tracks the connector's boot id from its repeating `priceConnectorAlive` beacon and re-requests when the id changes, so a lost broadcast self-heals within a beacon interval. A first-seen beacon only adopts the id — the subscription was just armed, and `candlesRequests` is a durable queue, so a request sent while the connector was down is delivered on its return. The boot id also rides on the broadcast itself so the broadcast and the beacon that follows it don't both re-request.

## [1.37.10] - 2026-07-29

### Fixed

- **The "latest orders" list took seconds to load for accounts with a long trading history.** `getLatestOrders` asks for the 10 newest filled orders — `{userId, status:'FILLED', paperContext}` sorted newest-first — but the only usable index was `userId` alone, so Mongo read every order the account had ever filled (up to 4.2M on prod) and sorted them in memory to hand back 10 rows. On a seeded 1.38M-document collection that is a 3.6s blocking sort examining 1,140,000 documents; on prod it produced 8 slow-query warnings in 4 hours, worst 9.6s. A `{userId, updateTime:-1}` index restricted to `status:'FILLED'` lets the sort come straight from the index: 12 documents examined and ~15ms. The index is deliberately partial — `updateTime` moves while an order is still working, but an order is frozen once it fills, so entries are written once and never shuffle, and the busy `NEW`/`PARTIALLY_FILLED` writes never touch the index at all (measured no write cost versus having no index at all). `paperContext` is intentionally not part of the key — the live-context filter is `{$ne: true}`, a range rather than an equality, which would stop `updateTime` from supplying the sort order.
- The same list also counted **every** filled order on the account just to show a total that is capped at 100 — on its own a 3-8s query, and the larger half of the delay. `countData` now takes an optional ceiling, and the count runs alongside the page fetch rather than after it.

## [1.37.9] - 2026-07-29

### Fixed

- **The notifications feed took seconds to load for accounts with a lot of bot messages.** `getMessageBot` filters bot messages by `{userId, showUser}` and always sorts newest-first, but the only usable index was `userId` alone — so Mongo fetched every message the account had ever received and sorted them in memory. On a 914k-document collection with a 45.7k-message account that is a 643ms blocking sort for the default feed, and 531ms to return a single 20-row page (all 45.7k documents are read to produce 20 rows). A `{userId, showUser, created:-1}` index lets the sort come straight from the index: the default feed drops to 153ms and a 20-row page to ~1ms / 25 documents examined. `paperContext` is intentionally not part of the key — the live-context filter is `{$ne: true}`, a range rather than an equality, which would stop `created` from supplying the sort order.
- Searching the notifications feed with "unread only" active also returned already-deleted messages: the search filter overwrote the `$or` holding the unread clause instead of being combined with it. Both clauses are now `$and`-ed together.

## [1.37.8] - 2026-07-28

### Fixed

- **Hyperliquid indicators on live bots silently received no candle data.** For HL exchanges the indicator service subscribed to Redis — and asked websocket-connector — by the pair's *wire code* (`BTC@hyperliquidLinear@1hCandle`), a dialect the connector stopped speaking in Jul 2026 when it normalized candle channels to display pairs: the `candlesRequests` payload failed symbol translation and was dropped, and nothing publishes on wire-code channels (on prod, 11 of 14 live HL candle channels had subscribers and no publisher). Paper HL bots were unaffected — the pairs-map lookup misses on the paper exchange key, so they always fell back to the display pair, which works. Indicators now always subscribe and request by display pair; `symbolCode` is kept for delisted-pair matching and state dumps only.

## [1.37.7] - 2026-07-28

### Changed

- On-demand balance refresh now fetches a user's exchanges through a bounded worker pool instead of one at a time. Sequentially, a 15-exchange live account paid the sum of every venue round trip (~590ms each, ~9.8s total); the pool collapses that to roughly the slowest venue per wave. Concurrency is `BALANCE_FETCH_CONCURRENCY` (default 8, set to 1 to restore the old sequential behaviour). The all-users snapshot cron deliberately stays sequential per user — it already runs every user in parallel, so fanning out there would multiply peak load on exchange-balancer.
- A venue that throws mid-refresh no longer aborts the remaining exchanges; the failure is logged per exchange and the rest still update.

## [1.37.6] - 2026-07-28

### Fixed

- Portfolio "refresh balances" / paper top-up no longer takes 30-40s. The snapshot's per-exchange zero-out loop iterated every balance doc the user owns (all exchanges, both contexts) and issued a sequential no-op `updateOne` for each nonzero doc belonging to a *different* exchange — ~11k wasted round trips for a 35-exchange account. The loop now only considers the current exchange's docs, and the reported-asset lookup is a Set instead of a per-doc array scan.

### Added

- `updateBalance` GraphQL query accepts an optional `uuid` to re-fetch only one exchange's balances from the venue (snapshot totals still recompute from stored balances). Used by the dashboard's per-exchange refresh and the paper top-up dialog.
- Compound index `{userId, exchangeUUID, asset}` on `balances` — every balance write filters on exactly these keys and previously scanned all of a user's docs via the bare `userId` index.

## [1.37.5] - 2026-07-26

### Fixed

- The check-candle failure streak is now tracked per `symbol@interval@exchange` instead of per indicator Service, so one delisted pair costs a fixed 3 error lines + 1 mute line no matter how many Services ride it. `getId` keys a Service by type+config+exchange+symbol+interval, so a single pair carries one Service per distinct indicator setting subscribed on it — and each kept its own counter, multiplying the "log the first few" allowance by the instance count. `AERGOUSDT@binanceUsdm` (~86 stale bot docs, ~160 Services) was 97.5% of the indicator worker's error log, hiding every other error including real regressions on live symbols. A new Service for an already-muted pair now inherits the mute and the backoff instead of re-arming both. Completes 1.37.4, which stopped the streak re-arming over time but not the fan-out across Services.

## [1.37.4] - 2026-07-26

### Fixed

- The delisted-symbol check-candle mute now actually holds. `updateCandle` cleared `consecutiveCandleFailures` unconditionally, and both "serve last candle" fallbacks call it with a fabricated flat candle (`lastCandle.close`, volume 0) — no new data arrived, but the streak reset anyway. For a delisted symbol those alternate with real failures, so the mute *and* the 15min backoff re-armed forever: `AERGOUSDT@binanceUsdm` re-logged "suppressing further errors" 1,930 times in 50h and accounted for 100% of the indicator worker's error output. Synthetic fills no longer clear the streak. Same bug class as the 1.36.2 ESUSDT fix, which only half-closed it.

### Added

- `InternalIndicatorsFactory.closeDeletedPairs()` tears down the indicator Services of a delisted pair. The `deletePairs` signal on `updateexchangeInfo` was consumed only by bot workers, so Services outlived their pair: they probed a dead symbol forever and — worse — kept publishing fabricated flat indicator values (volume 0 → VO -100, frozen ADX) to live subscribers as if they were real output. Wired up in main-app's indicators process.

## [1.37.3] - 2026-07-25

### Fixed

- A transient `getExchangeInfo` miss no longer poisons the funding registry for the life of the bot. On Kraken and Hyperliquid `toFundingSymbol` fell back to the raw pair when the exchange code couldn't be resolved, and the subscription heartbeat then re-wrote that member every 60s so it never aged out of the cron's stale window — the hourly funding poll rejected it on every run, forever (4 Hyperliquid + 1 Kraken symbol on prod, ~5 guaranteed failures/hour). The lookup now retries forced before giving up, and an unresolved code skips the funding subscription instead of registering a symbol the exchange can't answer. Same transient-miss hazard as 1.37.2, different consumer.

### Changed

- The funding cron's provider-error log now carries the symbol and the reason. `[Funding] Provider X response error NOTOK` named neither, so a single poisoned symbol failing identically every hour was indistinguishable from provider-wide degradation, and log triage re-raised it every run with no way to converge.

## [1.37.2] - 2026-07-20

### Fixed

- A DCA/Combo bot no longer auto-removes a pair from `settings.pair` (or force-closes/stops on it) while that pair still has an open deal. A transient `getExchangeInfo` miss (or a genuine delist) used to strip the pair and orphan the live position — desyncing settings from reality and breaking the deal's fee/price display. Open-deal pairs are now always kept; a delisted pair with an open deal simply has no live price (inherent), rather than being cancelled or dropped.

## [1.37.1] - 2026-07-20

### Changed

- `restoreDeal` now reactivates a canceled deal **in place**, inside its own bot, instead of spawning a new terminal bot. It flips the canceled deal back to `open` as a bare position (no DCA/TP/SL, close markers cleared) and reloads the bot so its worker re-adopts the existing position. A deal that lived in a bot is restored in that bot; a terminal deal is restored in the terminal.

## [1.37.0] - 2026-07-20

### Added

- `restoreDeal` mutation: re-activates a canceled DCA or terminal deal by re-adopting its existing (still on-exchange) position as a fresh bare terminal deal — no DCA, take profit or stop loss. Reuses the proven terminal-import path (`terminalDealType: import`) that `moveDealToTerminal` uses, minus the source-cancel step (the deal is already canceled). Rejects non-canceled deals.

## [1.36.2] - 2026-07-18

### Fixed

- Indicator `checkCandle` no longer floods the log with per-candle `<symbol>@<tf>@<exchange> error: parameter … does not exist` for delisted / no-archive-data symbols (e.g. ESUSDT@bitget). It now logs the first few consecutive failures then falls silent, and backs the retry cadence off to ~15m; any successful candle (live stream or archive) re-arms logging and normal cadence. Tunable via `INDICATOR_CHECK_FAIL_LOG_LIMIT` / `INDICATOR_CHECK_FAIL_BACKOFF_AFTER` / `INDICATOR_CHECK_FAIL_BACKOFF_MS`.

## [1.36.1] - 2026-07-17

### Fixed

- Fill-failsafe resting-order lookup no longer scans the whole `orders` collection: added a partial index on the resting LIMIT statuses. The query ran every 30s at ~6.5s, examining 18.5M documents to return ~101, and accounted for 66% of all slow-query time on production Mongo.

## [1.36.0] - 2026-07-17

### Added

- Active-sessions API: `activeSessions` query lists a user's live login sessions (device, approx location, IP, login method, sign-in time), plus `revokeSession` and `logoutOtherSessions` mutations to sign out one or all other sessions. Admin-impersonation and demo sessions are filtered out of the list, and `logoutOtherSessions` preserves them. Each `tokens[]` entry now records `ip` + `userAgent` at login; device labels reuse a shared `describeUserAgent` helper and location reuses the per-IP cache already on the user doc.

## [1.35.5] - 2026-07-16

### Fixed

- Bot permanent-delete no longer orphans deal/transaction ledgers. `premanenetlyDeleteBots` now purges `dcadeals`, `transactions` and `combotransactions` by `botId` in the per-bot cascade (alongside orders/events/messages), bounded to the bots being GC'd — previously these were left only to the weekly orphan-sweep, which never removed them (see next), so prod accumulated ~52–64% orphaned docs (~13.8M) from hard-deleted bots.
- Combo orphan-sweeps (`combotransactions`/`comboMinigrid`/`comboProfit`) were no-ops: each `$lookup ... as: 'combobot'` but `$match`ed a non-existent `bot` field (`{$size:0}`), matching nothing. Corrected the match field to `combobot` so the sweeps actually flag orphans.

## [1.35.4] - 2026-07-16

### Added

- `getPortfolioByUser` gains `includeAssets` (default true). When false, the CH read returns just `{updateTime,totalUsd}` from the `total_usd` column (no `raw` parse) — a much smaller payload for the common all-coins/all-exchanges chart line. The dashboard omits assets for the unfiltered line and requests them only when a coin/exchange filter is active.
- Per-user cache on the snapshot CH read (`snapshotReadSeries`/`snapshotReadPerExchange`), Redis-backed, TTL `SNAPSHOT_CH_CACHE_TTL` (default 300s; 0 disables). The series is daily-immutable so a short TTL is safe; cache/RPC failures fall through to a direct read then Mongo.

## [1.35.3] - 2026-07-16

### Changed

- Un-archiving a bot now resets its `updated` timestamp, giving it a fresh stopped-age window. Auto-archive keys off `updated` (the last-activity proxy), so without this a bot that had been long-stopped would be re-archived on the next hourly cron immediately after un-archiving. `setArchiveStatus` sets `updated` only on un-archive (no-op on archive), across all bot types.

## [1.35.2] - 2026-07-16

### Added

- `botMessage` gains an optional `count` field for digest-style notices (the message text carries the wording; count is bookkeeping so a daily aggregate can be incremented).

## [1.35.1] - 2026-07-15

### Fixed

- Snapshot ClickHouse read now returns the FULL snapshot doc (incl. `assets[]`) from the lossless `raw` column instead of only `updateTime`+`totalUsd`. The portfolio widget needs `assets` for per-coin/per-exchange filtering; the trimmed shape crashed it (`Cannot read properties of null (reading 'map')`).

## [1.35.0] - 2026-07-15

### Added

- Portfolio-snapshot cloud ClickHouse mirror (dual-write). `userSnapshots` now also ships each snapshot + per-exchange point to a buffered, fire-and-forget `SnapshotClient` (no-op unless `SNAPSHOT_CH_ENABLED`); Mongo stays source-of-truth on both editions. New `snapshotTypes`/`snapshotClient`/`snapshotRead`/`snapshotBackfill` under `src/archive`. `getPortfolioByUser` + `getSnapshotPerExchange` read the series from the CH mirror when enabled (12-month retention) and fall back to Mongo on any failure; `getPortfolioByUser` gains optional `from`/`to` to reach beyond the default 30-day window. Account reset/GDPR purges the mirror (scoped by paperContext).

### Changed

- Snapshots Mongo TTL is now env-driven (`SNAPSHOT_MONGO_TTL_DAYS`, default 365d) instead of hardcoded 90d — cloud sets a thin 7-day hot buffer once the CH mirror serves history; self-hosted keeps the full 12 months in Mongo.

## [1.34.6] - 2026-07-15

### Added

- Weekly clean job now trims `botprofitcharts` older than 12 months. The collection stores a numeric epoch-ms `time` (no Date field), so a TTL index is impossible and it was never pruned anywhere — it grew unbounded for every bot (open, stopped, and archived alike, since archiving does not move it to cold storage). The delete drains in 5,000-doc batches so the first run on a never-pruned collection can't become one lock-holding `deleteMany`.

## [1.34.5] - 2026-07-15

### Fixed

- Archiving a bot with a very large order history (tens of thousands of orders) no longer silently fails to move that history to cold storage. The cold-store copy sent each page of up to 20,000 orders as a single RabbitMQ message (~14 MB for a big bot), which could close the RPC channel ("no response") and leave the bot's history in Mongo. The default page size is now 3,000 (≈2 MB/message); override with `COLD_STORE_PAGE`.

## [1.34.4] - 2026-07-15

### Fixed

- Hedge archive hardening (defense-in-depth over v1.34.3). The `changeStatus` fallback that writes `closed` for a hedge bot not found in the orchestrator's in-memory list (`Bot.changeStatus`, hedgeCombo/hedgeDca branches) now filters on `status: { $ne: archive }`, so a stray close signal for an archived hedge bot can never silently un-archive it. Complements the worker-side `MetaBot.updateBotData` guard.

## [1.34.3] - 2026-07-15

### Fixed

- Hedge bots can now be archived reliably. The hedge parent engine (`MetaBot.updateBotData`) no longer demotes a user-set `archive` status back to a runtime status: archiving a just-stopped hedge bot raced with the post-stop child-bot stop signals (`stopFromChildBot`/`setStatus` persisting `closed`/`open`), which landed after the archive write and silently un-archived the bot (it reverted to `closed` and reappeared in the active list). Any non-archive status write from the worker is now guarded with `status: { $ne: archive }` so it can't overwrite `archive`. (Worker-path change — takes effect after a hedge bot-worker restart.)

## [1.34.2] - 2026-07-15

### Changed

- Bot collections (grid/DCA/combo/hedge) gained compound indexes `{userId, status, created}` and `{userId, created}` so the bot-list queries serve their default `created` sort from an index instead of an in-memory sort over all of a user's bots. Indexes build automatically on next connect via the existing `syncIndexes` boot path.
- The bot-list functions skip the redundant per-request `countDocuments` when the caller isn't paginating and the result fits under the limit (`total` = result length); paginated calls and limit-hitting results still get a real count (now via a count-only query instead of a second full fetch).

## [1.34.1] - 2026-07-14

### Fixed

- Cold-store un-archive (rehydrate) no longer re-validates restored docs against the Mongoose schema. `MongoCrud.bulkUpsertById` now passes `skipValidation: true` — a rehydrate is a FAITHFUL RESTORE of docs that were already valid when archived, not new data; re-validating would reject a legitimately-restored order/transaction if the schema had tightened (a required field added) after it was archived, breaking un-archive (and the retroactive backfill of older archived bots). Casting (`_id` string→ObjectId, ISO→Date) still runs. Caught by the full archive↔un-archive E2E against real Mongo+ClickHouse.

## [1.34.0] - 2026-07-14

### Added

- Cold store PART 2 — archive is now **reversible**. New `ColdStoreRehydrator` (`archive/coldStoreRehydrator.ts`) is the inverse of the archiver: on un-archive of a cold bot it pages the bot's rows back from ClickHouse, upserts them into Mongo by original `_id` (new idempotent `MongoCrud.bulkUpsertById`), verifies the Mongo copy, clears `coldArchived`, then GCs the CH copies — fail-safe ordering (flag cleared before the CH delete, so a crash only ever leaves harmless CH orphans). `Bot.setArchiveStatus` no longer rejects un-archiving a cold bot; it rehydrates synchronously first (rejects only if the restore fails).
- `ColdStoreArchiver.backfillArchivedBots()` — one-time, resumable/idempotent retroactive backfill over every already-archived grid/dca/combo bot not yet in CH (id-paged; failed bots retried next run).
- `ColdStoreReconciler` (`archive/coldStoreReconciler.ts`) — periodic CH↔Mongo orphan sweep: GCs CH rows whose Mongo bot is gone or no longer `coldArchived`, and logs Mongo bots flagged `coldArchived` with no CH rows. Wired into the daily clean cron (flag-gated).
- Cold RPC surface: `coldDeleteByUser` (whole-account CH purge, GDPR) and `coldListBots` (distinct (userId,botId) for the sweep), mirrored byte-identically in `market-archive/src/types.ts` (Danger List §6).

### Changed

- Every real-data delete path now purges CH too. `resetUser` (the shared chokepoint for the automatic inactive hard-reset, the settings-driven live/whole reset, and account deletion) `coldDelete`s the user's just-deleted botIds on live/whole resets — mirroring the Mongo delete (idempotent, non-fatal, no-op for paper/non-cold bots).

## [1.33.1] - 2026-07-14

### Fixed

- Transient "Exchange info not found" ("Cannot find exchange for bot") no longer silently stops/closes live bots. `getExchangeInfo` can momentarily return undefined for a valid, listed pair during a resume herd (worker restart → many concurrent `pairs` reads, cold cache), and the `pairsNotFound` paths treated that as "pair gone" → dropped it from settings and stopped the bot. New `MainBot.confirmPairMissing()` re-verifies with forced reads + an active re-fill + backoff before a pair is declared missing; only genuinely-absent pairs are dropped. Wired into DCA `checkSettingsPairs`, the DCA deal-load loop, and the combo minigrid load. Fast per-tick skip paths (placeOrders/fee) are unchanged so they stay cheap.

## [1.33.0] - 2026-07-13

### Changed

- Bot-error BEHAVIOUR is now data-driven. `handleErrors` no longer hardcodes per-subType branches for visibility / error-state / message; it consults the admin-managed `boterrorsubtypes` collection (via `errorRulesCache`) for `{showUser, errorsBot, userMessage}`. `errorsBot:false` keeps the bot running (warning, no error state), `showUser:false` suppresses the user message + bot event, `userMessage` rewrites the shown text. FAIL-SAFE: an unclassified subType keeps today's defaults (shown, errors bot, raw message); a static fallback mirrors the migrated hardcoded behaviours until the DB cache loads, so a restart never briefly flips a benign error into a hard error. The leverage-misconfig `Futures position` case stays a visible hard error (excluded from the suppression path); the `Indicators error:` prefix-strip stays a code transform.
- `errorRulesCache` now also loads the `boterrorsubtypes` behaviour table and counts rule HITS at the write path (once per real error occurrence, batched + flushed on the TTL) so the admin page shows a meaningful fire count instead of always 0.

## [1.32.7] - 2026-07-12

### Changed

- Indicator candle warmup now requests Bitget (spot + futures) in 1000-candle chunks instead of the default 200. Bitget's recent `/market/candles` serves up to 1000/call and the connector now pages spot at 1000, so a warmup that falls through to the exchange (archive miss) makes ~5x fewer exchange-balancer round-trips. Reads that hit the market-archive are unaffected (already served from ClickHouse).

## [1.32.6] - 2026-07-12

### Fixed

- `withUsd` valuation now also applies to the **public** `/api/v2/user/balances` (v2/api.ts) — the prior 1.32.5 change only touched the legacy v1 `/api/user/balances` handler, which api.gainium.io does not serve.

## [1.32.5] - 2026-07-12

### Added

- `/api/user/balances` optional `?withUsd=true` — adds `price` + `usdValue` per balance, valued via the same authoritative path the snapshot cron uses (cached `getAllPrices` rate table + tokenized-stock fallback off the `pairs` collection). Default response unchanged. New exported `priceBalancesUsd` in `utils/user`.

## [1.32.4] - 2026-07-12

### Fixed

- Kraken spot order reconcile (`_handleUnknownOrder`) now resolves by the stored exchange txid instead of the Gainium client id, matching the central `getOrder` wrapper. Kraken has no native client-id lookup, so the connector resolves spot orders by `userref = parseInt(clientId.slice(0,8),16)`, which collapses every combo/grid/dca id to one shared userref (all `CMB-*` → 12) — a status/cancel poll by client id could then "not find" a live order or return a *different* order's fill data (ledger drift). `byId` now includes `ExchangeEnum.kraken` (spot only) so the reconcile path swaps the client id for the txid and routes through the connector's exact `isKrakenSpotTxid` lookup.

## [1.32.3] - 2026-07-12

### Changed

- Benign transient bot errors are no longer shown to users or flipped into an error status — they're kept in `botmessages` (`showUser:false`) for our tracking only. Applies to Hyperliquid `unknownOid` (order status couldn't be read back; self-resolves) and the reduce/close-only rejections where the position is already gone/zero (`futuresPosition` subtype, excluding the still-user-facing "Leverage cannot exceed"). `unknownOid` is now classified as the `Order processing` subtype.

### Fixed

- Combo bots now self-clear a transient `error` status on a clean price tick, mirroring DCA (`restoreFromRangeOrError` on success). Previously the combo engine only restored from `range`, never `error`, so a benign error left the bot stuck wearing the error badge until a full reload even though it kept operating.

## [1.32.2] - 2026-07-11

### Added

- Expose `coldArchived` on the `fullBot`/`fullDCABot`/`fullComboBot` (+ hedge) GraphQL types so the dashboard can render archived cold-store bots as read-only (hide un-archive). Additive nullable field; resolvers return it straight off the bot doc.

## [1.32.1] - 2026-07-11

### Fixed

- Grid bot creation (`createBot`) now resolves `symbol.baseAsset`/`symbol.quoteAsset` from the authoritative `pairs` collection instead of trusting client-supplied strings. Dash-delimited Coinbase symbols (e.g. `SOL-EUR`) were being stored as `baseAsset:"SOLEUR"`/`quoteAsset:""`, causing intermittent "orders validation failed: quoteAsset is required" warnings and dropped grid orders. Falls back to the supplied values when the pair isn't found (mirrors `prepareDCABot`/`prepareComboBot`).

## [1.32.0] - 2026-07-11

### Added

- Cold store (phase 3): archived bots' order/transaction history moves to ClickHouse. On archive, `Bot.setArchiveStatus` fires a per-bot copy-verify-delete pipeline (`ColdStoreArchiver`) that batches rows to market-archive over new `coldStore*` RPC queues, verifies parity, then deletes from Mongo. Drill-down reads (`getBotOrders`/`getDealOrders`/`getComboDealOrders`/`getBotTransactions`) route archived (cold) bots to CH with Mongo fallback; bot-delete GC batches a CH `DELETE WHERE botId IN(…)`. Gated on `COLD_STORE_ENABLED` (default off; self-hosted stays wholly in Mongo). New `coldArchived` bot flag makes newly-archived bots READ-ONLY / one-way (clone to reuse); existing archived bots are grandfathered. Grid/dca/combo only (hedge deferred). Canonical wire contract in `src/archive/coldTypes.ts` (mirrored in market-archive).

## [1.31.0] - 2026-07-10

### Added

- Bot-error subType classification now consults the DB-backed `boterrorrules` collection first (seeded/owned by admin-app; extendable by admins and the Claus autonomous reclassifier). Rules relabel newly-stored errors with no deploy — a 5-min self-priming, non-blocking cache (`errorRulesCache`) refreshes in the background, falling through to the static `errorDict` until first load. Reduces `Uncategorized` and lets a mislabel be corrected from the admin side. NB: takes effect only after a bot-worker restart (ships the rules-aware code); rule *additions* thereafter need no restart.

## [1.30.3] - 2026-07-10

### Fixed

- Kraken Futures rate-limit `apiLimitExceeded` is now categorized (`Exchange rate limit`) instead of falling through to `Uncategorized`. `handleErrors` treats it as a transient, non-erroring warning ("Exchange temporarily rate-limited our requests… retried automatically") so the bot no longer hard-errors/stops the deal on a rate-limit that the connector already retries.

## [1.30.2] - 2026-07-04

### Changed

- Bot events (30d), rates (30d) and snapshots (90d) now expire via TTL indexes (declared in `registerIndexes()`, matching the indexes created on prod) instead of weekly bulk `deleteMany` age-scans in `cleanJob`. Expiry runs continuously in the background rather than as a weekly spike. The conditional cleanup steps (paper/balances/fees/orphaned-bot data) and the bot-*warning* 14d delete (a subset the 30d TTL can't express) are unchanged.

## [1.30.1] - 2026-07-07

### Fixed

- Portfolio snapshot now values tokenized-stock holdings (Kraken xStocks, Bybit spot xstocks, Hyperliquid spot RWA) instead of dropping them at $0. The snapshot builder priced every balance off the bulk `getAllPrices` rate table, which carries no xStock; unpriceable holdings were skipped entirely, so they vanished from the portfolio. Now a holding whose (exchange, pair-base) matches a `stock`/`etf` pair is priced via that exchange's live `latestPrice` ticker (cached per pair per run). `normalizeStockTicker` also strips Kraken's tokenized-ledger `.T` suffix (`PGx.T` → `PG`), and a new `balanceAssetToPairBase` maps a ledger code to its tradeable pair base (`PGx.T` → `PGx`).

## [1.30.0] - 2026-07-07

### Added

- In-memory RPC-latency counters in `Rabbit` (`getRpcLatencyStats()`): `sendWithCallback` tallies per-queue `{count,sumMs,maxMs,breaches,timeouts}` on completion (breach when round-trip > `RPC_LATENCY_BREACH_MS`, default 10000) and on hard-timeout rejection. Module-level (all instances aggregate), additive, never-throw; consumed by main-app's RPC-latency monitor. No existing method signature changed.

## [1.29.1] - 2026-07-06

### Changed

- Pairs dedup in indicator service

## [1.29.0] - 2026-07-06

### Added

- Pairs now carry an optional `baseAsset.displayName` (human-readable asset name, e.g. "Apple Inc." / "Bitcoin") — added to the `pairs` schema/type and exposed on the `baseAssetPair`/`baseAssetInPair` GraphQL types. Additive & optional: absent until the main-app `saveAssetNames` cron resolves it; consumers fall back to the ticker (`name`). Exchanges don't return names, so they're resolved from a reference source (coins collection for crypto, curated ticker→name map for stocks), mirroring the icon pipeline.

## [1.28.3] - 2026-07-06

### Fixed

- Tokenized-stock (xStocks) icons: `normalizeStockTicker` now strips the `x`/`X` wrapper from dotted tickers (`BRK.Bx` → `BRK.B`) so the `/icons/stock/:ticker` route resolves the real brand logo instead of a monogram. Kept in lock-step with the main-dash-sh frontend copy.


## [1.28.2] - 2026-07-06

### Fixed

- Kraken spot deal fills silently dropped (forum #4890). Kraken spot has no `cl_ord_id`, so user-stream execution reports carry the Kraken txid as their clientOrderId — the stream matcher (keyed by our `D-…`/`GRID-…` client id) never matched, so resting-limit fills never registered. `convertExecutionReportToOrder` now falls back to matching by exchange `orderId` (txid) for Kraken spot when the client-id lookups miss. Also `mergeCommonOrderWithOrder` now preserves the local order's `clientOrderId` instead of the exchange-echoed one (no-op for other exchanges; prevents rekey/DB corruption on the Kraken reconcile path, which resolves by txid). Pairs with exchange-connector core 1.14.3.

## [1.28.1] - 2026-07-06

### Added

- streamWatchdog: actions carry a reason tag (stale vs catchRate) and main() accepts an onAction ops-visibility hook (fire-and-forget) so escalations can surface in the admin watchdog notifications feed

## [1.28.0] - 2026-07-05

### Added
- Missed-fill failsafe escalation (spec §3.4) in the stream watchdog: a second, independent signal source alongside staleness. On each tick it groups recent `reconcilesweepcatches` by `exchangeUUID` over `FF_ESCALATE_WINDOW_MS` (default 24h, excludes paper) and, for chronic offenders, triggers a stream self-heal once (`FF_ESCALATE_SELFHEAL_N`, default 3) then INFORM USERS once (`FF_ESCALATE_INFORM_N`, default 3 more after the self-heal). Escalation state rides in the existing `watchdogState` hash via two new optional fields (`ffSelfHealAt`, `ffInformAt`); the decision is a pure function (`catchRateTick`) and never touches the staleness `failureCount`/backoff or emits a reconcile.

### Changed
- INFORM USERS bot error now links a troubleshooting article (`STREAM_TROUBLESHOOTING_URL`, default `https://docs.gainium.io/troubleshooting/exchange-connection-updates`) covering outdated API key formats and missing exchange IP whitelists.

### Removed
- Hyperliquid blunt order poller (`startHyperliquidOrderPoll` / `pollHyperliquidOrdersFn` / `maybeEmitHyperliquidPolledOrder` and the `HYPERLIQUID_POLL_ORDERS` gate) — superseded by the price-gated fill-failsafe detector.

## [1.27.0] - 2026-07-04

### Added
- Pairs now carry an `isCanonical` flag (Hyperliquid spot only: HL-canonical or Unit-bridged = true; permissionless HIP-1 = false; absent elsewhere = canonical), persisted and exposed on `getAllPairs`, for the dashboard "Canonical only" pair-picker toggle. Paper twins mirror their real twin's flag (and `assetCategory`) since paper-trading proxies exchange-info without either signal.

## [1.26.1] - 2026-07-04

### Fixed
- Never store a negative `locked` in the `balances` collection. `locked` (funds reserved by open orders/positions) is written verbatim from authoritative sources that can go negative — Binance futures `ACCOUNT_UPDATE` (`walletBalance - crossWalletBalance`, negative on positive unrealized PnL) and the connector's Hyperliquid futures balance (`accountValue - withdrawable`) — which made "available" balance display wrong/negative on heavy-churn accounts. Clamp `locked` to `≥ 0` at every write boundary in the balance-update path (`utils/user.ts`).

## [1.26.0] - 2026-07-04

### Added
- OKX Europe (`okxSource=my`) authoritative spot pairs. Pairs now carry an optional `source` field (`my` = OKX Europe / eea.okx.com USDC/EUR spot universe; unset = global feed + all other exchanges), exposed on `getAllPairs`. New `updateOkxEuPairs()` fetches an EU account's account-scoped instruments (via the connector's `/exchange/account`) and reconciles them into the shared `pairs` collection tagged `source: my` — the set is account-agnostic, so the first EU account to connect refreshes it for every EU user. The exchange client gains `getAccountSpotExchangeInfo()` (private call; non-OKX exchanges get a not-supported default).

## [1.25.2] - 2026-07-03

### Changed
- Deals list REST (`GET /api/v2/deals/:dealType`): cache the exact total count in Redis (60s TTL, keyed on the query filter) instead of running a full `countDocuments` on every page load. The `meta.count`/`meta.total` response stays exact within the TTL; the page rows are still fetched live. Cache is best-effort — any Redis error falls back to a live count. Removes the per-request count aggregation that dominated the Mongo slow log for large accounts.

## [1.25.1] - 2026-07-03

### Added
- Register five query indexes in `registerIndexes()` to match indexes already created on prod: `dcaBot {uuid}`, `botMessage {botId, isDeleted}`, `dcaDeal {userId, createTime}` (partial on `status: 'open'`), and `transaction`/`comboTransaction {botId, userId}`. Eliminates COLLSCANs on the webhook bot-lookup and bot-error message soft-delete, removes the in-memory sort on the deals list, and lets the bot engine load a single bot's transactions instead of scanning the whole user's. All indexed fields are static/write-once (no write-path regression). No-op on prod (indexes already present); first-boot build on self-hosted/local.

## [1.25.0] - 2026-07-03

### Added
- User Stream Watchdog. 

## [1.24.3] - 2026-07-03

### Fixed
- Archiving a running bot now fails with a clear "Only stopped bots can be archived. Stop the bot first." error instead of silently reporting success and reappearing after a re-login/browser reopen. `setArchiveStatus` filtered the update on `status: closed`, so archiving a running bot (e.g. a hedge-combo bot) matched 0 docs yet still returned OK — the dashboard showed a false success and hid the bot locally until the next full reload. The legacy rule (only stopped bots are archivable) is preserved; the failure is now explicit and nothing is mutated on a rejected archive. Applies to all bot types (DCA/Grid/Combo/Hedge Combo/Hedge DCA).

## [1.24.2] - 2026-07-02

### Changed
- (Superseded by 1.24.3 — not deployed) Dropped the `status: closed` guard so archiving worked on bots in any active state. Replaced by an explicit error, to keep the legacy "stop before archiving" rule.

## [1.24.1] - 2026-07-02

### Fixed
- Combo bot stop: `ComboBot.afterBotStop()` now delegates to `super.afterBotStop()`, so stopping a combo bot also clears the price timer and reconcile-sweep interval (previously left running — combo arms both via the inherited DCA `start()`).

## [1.24.0] - 2026-07-02

### Added
- Binance Futures Quantitative Rules (-4400) cooldown guard: violations are tracked per account+symbol in Redis (`QuantRulesGuard`), mirroring Binance's tiers (L1 symbol 5min, L2 symbol 2h after 10 violations/24h, L3 whole-account 2h at 10+ restricted symbols). During a cooldown, non-reduceOnly Binance-futures orders are delayed (pre-send gate + bounded deferred retry) instead of hammering the exchange; the -4400 rejection no longer errors the bot — it emits a once-per-window warning. Deferred retries are cancelled on bot stop and dropped when the deal closed meanwhile. New `quantrulesevents` collection (90d TTL; read by admin-app) and `getQuantRulesStatus` GraphQL query for the dashboard banner. Additive `subType` field on the `bot message` socket payload.

## [1.23.2] - 2026-07-01

### Fixed
- Stock/ETF icons: `normalizeStockTicker` now strips a Hyperliquid HIP-3 builder-dex prefix (`xyz:AAPL` → `AAPL`) so tokenized-stock perps resolve their clean ticker for logo lookup.

## [1.23.1] - 2026-06-30

### Fixed
- Stock/ETF icons: venue-gate `normalizeStockTicker` so Bitget reality (`RAAPL`), Bybit-spot xstock (`AAPLX`) and Kraken xStock (`AAPLX` on `krakenUsdm`) bases resolve to their clean ticker for logo lookup. Upper-case wrapper strips (`R`-prefix / `X`-suffix) are gated to the venue that mints them — and to its `paper` twin — so clean tickers that start with `R` (`RBLX`) or end in `X` (`NFLX` on `bybitLinear`) are no longer mangled; lower-case wrappers (`rTSLA`/`AAPLx`/`AAPLon`) still strip on any venue.

## [1.23.0] - 2026-06-30

### Added
- Normalized `assetCategory` (crypto/stock/etf/commodity/metal/forex/index, default crypto) on the `pairs` collection + `getAllPairs` GraphQL, classified authoritatively from the connector's `assetClass` (no heuristics). `classifyAssetClass` trusts the exchange signal; the pairs cron persists it and paper exchanges inherit their real twin's class.

## [1.22.4] - 2026-06-29

### Fixed
- Pin the reconcile-sweep collection name explicitly to `reconcilesweepcatches`. Mongoose lowercases derived model collection names (e.g. `dcaBots` → `dcabots`), so the previously-configured `reconcileSweepCatches` model would have written live catches to a lowercased collection that the admin-app reader/backfill didn't match — the admin page would have shown backfilled history but never live data. Now both sides use the same explicit lowercase name.

## [1.22.3] - 2026-06-29

### Added
- Persist reconciliation-sweep catches to the `reconcileSweepCatches` collection (`MainBot.recordReconcileSweepCatch`, fire-and-forget at the grid/DCA catch sites) — `botId/botType/userId/exchange/exchangeUUID/paperContext/pair/missedFills`, 90-day TTL. Powers the admin "User Stream Health" page; a rising per-account catch rate = that account's user stream is silently dead. No-op when `RECONCILE_SWEEP_ENABLED` is off.

## [1.22.2] - 2026-06-28

### Changed
- Reconciliation sweep (1.22.0) moved from `BotOperations` (worker bot-service) to the per-instance `MainBot` base class (`startReconcileSweep`/`stopReconcileSweep`, armed in `runAfterLoading()` + grid/DCA start, cleared on stop). The cloud build runs bots in-process via the `src/bot/` overlay, so the worker path never executed there; the per-instance timer runs wherever the bot instance runs, so the sweep now works in **both cloud and self-hosted**. Adds greppable logs: `reconcile-sweep armed (every Xms)` per bot on load, and `reconcile-sweep caught N missed fill(s)` when the sweep (not a reconnect) reconciled a stream-dropped fill.

## [1.22.1] - 2026-06-28

### Fixed
- Merging deals on a hedge bot (DCA or Combo) now tags the resulting merged deal with its hedge wrapper id (`parentBotId`). Previously the merged deal was created without it, so the `hedge*DealList` queries — which select hedge-leg deals via `parentBotId: { $exists: true }` — dropped it, and the merged deal never appeared in the hedge bot's Deals view in the new dashboard (it only surfaced in the legacy UI).

## [1.22.0] - 2026-06-28

### Added
- Opt-in Tier-2 reconciliation sweep (`RECONCILE_SWEEP_ENABLED`, interval `RECONCILE_SWEEP_INTERVAL_MS`): a per-worker timer periodically re-runs each running grid/DCA bot's existing reconnect reconcile, so order fills missed by a silently-dead user stream are caught within one interval instead of stalling the bot until a manual restart (community thread 4863). Off by default; jittered + overlap-guarded; routed through the per-bot mutex.

### Fixed
- `checkOrdersAfterReconnect` (grid + DCA) and `checkOrders` (grid) now reset `blockCheck` via `try/catch/finally`. A throw mid-check previously left `blockCheck` stuck `true`, silently freezing all subsequent order checks for that bot — turning a transient reconnect-reconcile error into a permanent stall.

## [1.21.0] - 2026-06-25

### Added
- Paper `SPOT & Futures` accounts can be funded independently per market (SPOT / USDⓈ-M / COIN-M) via an optional `topUps` array on `addExchange`; omitting it preserves the previous single-top-up behavior

## [1.20.0] - 2026-06-22

### Added
- Get funding rate history

## [1.19.1] - 2026-06-13

### Fixed
- REST-API multi-TP/SL validation rejected every real UUID (compared uuid values against the key allowlist)

## [1.19.0] - 2026-06-12

### Added
- Snapshots per exchange

## [1.18.10] - 2026-06-12

### Changed
- Reset user process

## [1.18.9] - 2026-06-11

### Fixed
- DIV indicator logic

## [1.18.8] - 2026-06-10

### Changed

- Backtester performance fix. 

## [1.18.7] - 2026-06-10

### Changed

- Enable gzip/deflate compression on all API responses (`compression`
  middleware). The large `getAllPairs` payload (~3.4MB) and other big JSON
  responses now transfer ~15x smaller, cutting response time from several
  seconds to sub-second.

## [1.18.6] - 2026-06-09

### Fixed

- A manual add/reduce-funds failure on a deal is now always reported to the
  user, even when a same-type message (e.g. "Not enough balance") is already
  active for the bot. Previously the error de-duplication gate could swallow
  the user-initiated failure, leaving the terminal with no feedback.

## [1.18.5] - 2026-06-09

### Changed

- Error dictionary

## [1.18.4] - 2026-06-08

### Fixed

- Exchange disabled by host configuration for paper exchanges

## [1.18.3] - 2026-06-02

### Added

- Hyperliquid builder fees

## [1.18.2] - 2026-06-02

### Added

- Expose `paperContext` on `dcaDeal`/`comboDeal` GraphQL types and stamp it on
  returned deals (list + per-bot, incl. hedge) so clients can tell a deal's
  trading context without inferring it. Additive/backward-compatible.

## [1.18.1] - 2026-05-31

### Added

- `getBotEvents`: optional `category` input (`recent`/`deals`/`alerts`) and a
  `counts` response field for server-side categorization. `recent` is the full
  feed (no filter); `alerts` = error/warning type; `deals` = deal-tied events
  that aren't alerts. Counts are computed only when `category` is supplied, so
  callers that don't request them are unaffected (no extra count queries).

## [1.18.0] - 2026-05-28

### Added

- Self-hosted admin-config sync (gated by `ADMIN_CONFIG_ENABLED`). Reads
  `gainium:admin:enabled_exchanges` from Redis, subscribes to
  `gainium:admin:config` pubsub, and runs a 10s periodic refresh as a
  safety net. When the flag is off (cloud / unflagged) every code path
  is a hard no-op — no extra Redis traffic, no timers, no log lines.

## [1.17.10] - 2026-05-28

### Changed

- Enforce profitCurrency and orderFixedIn on server side for grid bot.

## [1.17.9] - 2026-05-26

### Changed

- Not enough balance dictionary

## [1.17.8] - 2026-05-21

### Fixed

- Indicator duplicated candles

## [1.17.7] - 2026-05-21

### Fixed

- Broker codes

## [1.17.6] - 2026-05-20

### Added

- Adapters for parent features

## [1.17.5] - 2026-05-14

### Added

- Indicator state ednpoint

## [1.17.4] - 2026-05-14

### Fixed

- Scalar headers interceptor

## [1.17.3] - 2026-05-13

### Fixed

- Avg lossing/winning/global deals duration

## [1.17.2] - 2026-05-11

### Fixed

- Hyperliquid symbol precision

## [1.17.1] - 2026-05-07

### Changed

- Control polling by ENV variable

## [1.17.0] - 2026-05-06

### Added

- Polling for HL orders

## [1.16.2] - 2026-04-30

### Fixed

- Wrong start index for closed only stream

## [1.16.1] - 2026-04-29

### Changed

- Indicator service closed only exchange

## [1.16.0] - 2026-04-27

### Changed

- Indicator service to use indicators utils
- Internal properties update in SSB

## [1.15.8] - 2026-04-22

### Fixed

- Combo Base minigrid wrong step

## [1.15.7] - 2026-04-20

### Fixed

- Move SL value got overwritten

## [1.15.6] - 2026-04-13

### Fixed

- Long Wick types

## [1.15.5] - 2026-04-13

### Added

- Timer to release mutex

## [1.15.4] - 2026-04-08

### Fixed

- Kucoin intervals

## [1.15.3] - 2026-04-07

### Fixed

- Short combo minigrids size on high deviation

## [1.15.2] - 2026-04-07

### Added

- Mongo DB connection string support

## [1.15.1] - 2026-04-06

### Changed

- Long Wick logic

## [1.15.0] - 2026-04-03

### Added

- Long Wick
- Session

## [1.14.24] - 2026-03-31

### Fixed

- Combo bot grid order size. 

## [1.14.23] - 2026-03-26

### Fixed

- Change user name. 

## [1.14.22] - 2026-03-23

### Fixed

- Restore original state of deals from Redis. 

## [1.14.21] - 2026-03-23

### Fixed

- Typo in sell remainder double check. 

## [1.14.20] - 2026-03-23

### Changed

- Set stats time after bot data converted. 

## [1.14.19] - 2026-03-20

### Changed

- Debug log to bot monitor

## [1.14.18] - 2026-03-20

### Changed

- Fee db index

## [1.14.17] - 2026-03-20

### Changed

- Use max fee in tp order

## [1.14.16] - 2026-03-19

### Changed

- Close deal by TP as Market order

## [1.14.15] - 2026-03-19

### Fixed

- Sell remainder false fired on deal start.

## [1.14.14] - 2026-03-17

### Changed

- Bot messages index.

## [1.14.13] - 2026-03-17

### Changed

- Runtime cache for all pairs.

## [1.14.12] - 2026-03-16

### Fixed

- API v2:
  - Pagination wrong
  - Paper context check in info endpoints

## [1.14.11] - 2026-03-13

### Changed

- Return hyperliquid indicators.

## [1.14.10] - 2026-03-13

### Changed

- Reduce bitget user stream connections.

## [1.14.9] - 2026-03-12

### Added

- API v2 keys options: paper context and bot id.

## [1.14.8] - 2026-03-11

### Fixed

- API v2 bugs.

## [1.14.7] - 2026-03-10

### Added

- Validation backtest endpoint.
- Discovery endpoints.

## [1.14.6] - 2026-03-09

### Changed

- Drop Kraken Coinm.

## [1.14.5] - 2026-03-09

### Changed

- Hedge bots list for big account.

## [1.14.4] - 2026-03-06

### Changed

- Kraken futures candles count.

## [1.14.3] - 2026-03-06

### Fixed

- Separate over and under limit not worked with dynamic price filter.

## [1.14.2] - 2026-03-05

### Fixed

- Kraken balance snapshot.

## [1.14.1] - 2026-03-04

### Fixed

- Move SL trigger not respect fee.
- Connect child indicators with load1d flag.

## [1.14.0] - 2026-03-04

### Added

- Kraken.

## [1.13.1] - 2026-02-27

### Fixed

- Terminal property in API handlers.

## [1.13.0] - 2026-02-26

### Added

- SSB API endpoints.
- Sync mode for SSB backtest.

## [1.12.0] - 2026-02-24

### Changed

- Refactored API v2 endpoints.
- Split endpoint per bot type and deal type. Separate endpoints for terminal
- Refactored .MD docs, extract schemas to a separate file
- Moved paper context to a header

## [1.11.2] - 2026-02-20

### Added

- API v2 added createComboBot, createTerminalDeal, createGridBot requests, CRUD operations on global variables.

## [1.11.1] - 2026-02-18

### Added

- API v2 added createDCABot request, get global variables request

## [1.11.0] - 2026-02-18

### Added

- API v2

## [1.10.12] - 2026-02-18

### Changed

- Increased max number of bots to return in related bots query

## [1.10.11] - 2026-02-17

### Changed

- Added paperContext and bot status to related bots query

## [1.10.10] - 2026-02-16

### Fixed

- OKX position size and order size

## [1.10.9] - 2026-02-09

### Fixed

- Short required change calculation

## [1.10.8] - 2026-02-06

### Fixed

- DCA by market errors not shown.

## [1.10.7] - 2026-02-06

### Changed

- Added OKX host app.okx.com

## [1.10.6] - 2026-02-06

### Changed

- Add listen flag for candles provider

## [1.10.5] - 2026-02-05

### Fixed

- Prevent duplicates in DCA by market orders

## [1.10.4] - 2026-02-02

### Changed

- Enhanced log DCA by Market

## [1.10.3] - 2026-01-29

### Changed

- Connect to user streams for active users

## [1.10.2] - 2026-01-26

### Fixed

- Hyperliquid reposition partially filled order

## [1.10.1] - 2026-01-26

### Fixed

- Missed orders in search by status

## [1.10.0] - 2026-01-23

### Added

- DCA By Market

## [1.9.1] - 2026-01-16

### Fixed

- TP section settings mixed up

## [1.9.0] - 2026-01-15

### Added

- Separate max deal limits when using dynamic price filter over and under

## [1.8.4] - 2026-01-14

### Changed

- Bot id in bot live stats.

## [1.8.3] - 2026-01-14

### Changed

- GQL schema.

## [1.8.2] - 2026-01-13

### Changed

- GQL schema.

## [1.8.1] - 2026-01-12

### Fixed

- Multi TP by Market caught duplicate order error, Multi SL not fired.

## [1.8.0] - 2026-01-07

### Added

- Bot live stats.

## [1.7.4] - 2026-01-06

### Changed

- Broker codes with zone.

## [1.7.3] - 2026-01-02

### Changed

- Exchange error dictionary.

## [1.7.2] - 2025-12-30

### Fixed

- Missed indicator events if the same indicator is used in different sections.

## [1.7.1] - 2025-12-29

### Fixed

- Overwritten deal orders when updating deal.

## [1.7.0] - 2025-12-25

### Added

- Password reset.

## [1.6.14] - 2025-12-25

### Changed

- Packages update.

## [1.6.13] - 2025-12-24

### Fixed

- Check TP level wrong price.

## [1.6.12] - 2025-12-23

### Fixed

- AVP issue with group and section indicator logic

## [1.6.11] - 2025-12-22

### Fixed

- Skip balance check in move deal to terminal.

## [1.6.10] - 2025-12-18

### Fixed

- Timezone offset.

## [1.6.9] - 2025-12-16

### Changed

- Combo breakeven calculation.

## [1.6.8] - 2025-12-16

### Changed

- Improve random pair filtering.

## [1.6.7] - 2025-12-08

### Fixed

- Profit by user/bot start date.

## [1.6.6] - 2025-11-28

### Fixed

- API signature not valid with empty body.

## [1.6.5] - 2025-11-26

### Fixed

- Hedge bot not found when stopped.

## [1.6.4] - 2025-11-24

### Changed

- Demo user.

## [1.6.3] - 2025-11-17

### Changed

- Decorators apply logic in bot helpers.

## [1.6.2] - 2025-11-14

### Fixed

- Market TP order triggered at wrong price when having multiple deals.

## [1.6.1] - 2025-11-11

### Changed

- Request candles for indicators through main thread.

## [1.6.0] - 2025-11-10

### Added

- Skip balance check option for Grid bots.

## [1.5.5] - 2025-11-10

### Changed

- Soft reset live account.

## [1.5.4] - 2025-11-10

### Added

- Hyperliquid sub-account support.

## [1.5.3] - 2025-11-10

### Fixed

- Use fixed base price in RR with fixed SL.

## [1.5.2] - 2025-11-07

### Fixed

- Hedge Combo bot TP/SL base on value ignored.

## [1.5.1] - 2025-11-06

### Changed

- Hyperliquid max candles. Hide hyperliquid in indicators.

## [1.5.0] - 2025-11-05

### Added

- Fixed Stop Loss in Risk Reward

## [1.4.23] – 2025-11-05

### Fixed

- Max deal levels.

## [1.4.22] – 2025-11-04

### Fixed

- Clone combo bot unsupported fields.

## [1.4.21] – 2025-11-03

### Fixed

- Handle worker terminate.

## [1.4.20] – 2025-11-03

### Fixed

- Reset account with hedge bots.

## [1.4.19] – 2025-10-29

### Fixed

- Deals filter in reset user method.

## [1.4.18] – 2025-10-29

### Added

- Close old start deals.

## [1.4.17] – 2025-10-29

### Fixed

- Prevent duplicate transaction error.

## [1.4.16] – 2025-10-27

### Fixed

- Hyperliquid price precision.

## [1.4.15] – 2025-10-27

### Fixed

- Share Grid backtest input.

## [1.4.14] – 2025-10-22

### Fixed

- Market TP wrong trigger when having SL and multicoin.

### Added

- New bot schema fields.

## [1.4.13] – 2025-10-20

### Changed

- Hyperliquid USD rates

## [1.4.12] – 2025-10-20

### Fixed

- Reset trailing mode

## [1.4.11] – 2025-10-20

### Added

- Step parameter to update bot/deal API

## [1.4.10] – 2025-10-20

### Fixed

- Move deal to terminal of multicoin bot.

## [1.4.9] – 2025-10-17

### Fixed

- NOB order id

## [1.4.8] – 2025-10-17

### Changed

- Mongo delete method

## [1.4.7] – 2025-10-16

### Changed

- Backtester update

## [1.4.6] – 2025-10-15

### Changed

- NOB logic for bot

## [1.4.5] – 2025-10-15

### Changed

- Debug log for indicators

## [1.4.4] – 2025-10-14

### Fixed

- Clone combo bot input body
- Server url in swagger

## [1.4.3] – 2025-10-13

### Changed

- Reduced unknown order retry count

## [1.4.2] – 2025-10-10

### Fixed

- Multi SL issue

## [1.4.1] – 2025-10-09

### Fixed

- GQL input schema

## [1.4.0] – 2025-10-09

### Added

- Order Blocks & Fair Value Gaps (FVG only)

## [1.3.8] – 2025-10-07

### Changed

- Remove delisted pairs from the bot

## [1.3.7] – 2025-10-07

### Changed

- Added mutex to check candle in indicator service

## [1.3.6] – 2025-10-06

### Fixed

- Hyperliquid spot order price precision

## [1.3.5] – 2025-10-01

### Fixed

- Reset not enough balance status

## [1.3.4] – 2025-09-30

### Added

- Market TP order

## [1.3.3] – 2025-09-30

### Fixed

- Market structure price actions

## [1.3.2] – 2025-09-29

### Change

- Bot errors map updated

## [1.3.1] – 2025-09-26

### Change

- Rearranged set leverage and set margin methods to fit hyperliquid logic

## [1.3.0] – 2025-09-26

### Added

- Hyperliquid integration

## [1.2.8] – 2025-09-26

### Added

- ENCRYPT_KEY

## [1.2.7] – 2025-09-18

### Fixed

- Bot not stopped when reset account

## [1.2.6] – 2025-09-18

### Fixed

- TP called multiple times with OR condition and multiple timeframes

## [1.2.5] – 2025-09-15

### Changed

- TP order size calculation for long profit in base

## [1.2.4] – 2025-09-12

### Fixed

- Bot stop stuck
- Bitget Linear base order calculation

## [1.2.3] – 2025-09-09

### Changed

- Lock the bot while loading

## [1.2.2] – 2025-09-08

### Changed

- Indicators logs

## [1.2.1] – 2025-09-05

### Changed

- Indicators (QFL fix)

## [1.2.0] – 2025-09-04

### Changed

- Hedge backtest

## [1.1.3] – 2025-08-25

### Changed

- Increase parallel listeners in bot
- Calcualte deal profit if deal canceled, but TP order is filled

### Fixed

- Bot not able to be closed if catch error deal not found

## [1.1.2] – 2025-08-20

### Changed

- Reset stats when corresponding global variable changed
- Optmization of get hedge bot deals stats
- Minimum dynamic price deviation

## [1.1.1] – 2025-08-08

### Changed

- Changed log level for some logs

## [1.1.0] – 2025-08-07

### Changed

- Updated log level logic

## [1.0.15] – 2025-08-05

### Changed

- Retry reasons in exchange connector
- Read hedge status from db while in service restart

## [1.0.14] – 2025-08-04

### Changed

- Not bypass dynamic price condition if not able to load latest price

## [1.0.13] – 2025-07-28

### Fixed

- Use static filter in multi coin bot

## [1.0.12] – 2025-07-24

### Fixed

- Retry 500 error

### Changed

- Bumped dependencies versions

## [1.0.11] – 2025-07-21

### Fixed

- Retry request timeout exchange requests

## [1.0.10] – 2025-07-18

### Changed

- Backtester update

## [1.0.9] – 2025-07-17

### Added

- Increased core compatibilities

### Fixed

- Fixed bot dashboard stats for bigAccount, prevent showing terminal bots in DCA bots stats

## [1.0.8] – 2025-07-16

### Added

- Added support for changing Bybit host configuration (com, eu, nl, tr, kz, ge)
- Enhanced exchange factory to support Bybit host parameter
- Added BybitHost enum for different regional hosts

### Changed

- Updated exchange types and interfaces to include bybitHost parameter
- Modified bot exchange update functionality to support Bybit host selection

### Fixed

- Undefined broker code
- Indicator connect timeout

## [1.0.7] – 2025-07-15

### Added

- Added license key validation to user registration form
- Enhanced license key checking functionality with registration support
- Snapshot assets aggregation by exchange UUID

### Changed

- Updated user registration GraphQL schema to include required license key field
- Modified license key validation to support both registration and existing user checks

### Fixed

- Return getGlobalVariablesByIds request

## [1.0.6] – 2025-07-14

### Fixed

- Fixed TP order size calculation in coinm futures for limit-based orders placed after base order is filled

## [1.0.5] – 2025-07-08

### Changed

- Updated indicator service connection and publish channel logic
- Enhanced hedge bot to use callback after successful start

## [1.0.4] – 2025-07-02

### Changed

- Updated all dependencies to their latest versions
- Updated private dependencies (@gainium/indicators, @gainium/backtester)
- Updated package-lock.json with latest dependency versions

### Fixed

- Fixed database reference in deal monitor

## [1.0.3] – 2025-06-30

### Changed

- Switched to npm package manager
- Removed yarn.lock file (no longer needed with npm)

## [1.0.2] – 2025-06-30

### Added

- Initial public release of Gainium Main Backend.
- Main API Server (GraphQL, auth, user & trading endpoints).
- Bot Services (DCA, Grid, Combo, Hedge).
- Stream Service (real-time WebSocket).
- Indicators Service (technical indicators & subscriptions).
- Backtest Service (server-side strategy back-testing).
- Cron Service (scheduled maintenance & data updates).

### Changed

- Bumped package version from 1.0.1 → 1.0.2.
