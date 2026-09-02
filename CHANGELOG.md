# Changelog

## [1.56.15] - 2026-09-02

### Fixed

- **A reconcile order lookup no longer costs 18 connector round trips when the connector is failing.** `reconcileLookup` spends its 3-attempt budget on `MainBot.getOrder`, but `Exchange.apiCall` already retries a connector 5xx/timeout SIX times at 500ms before giving up — so each "attempt" was really six round trips over ~3s and the real ceiling was 3 x 6. Bug #599, 2026-09-02 01:21-01:23Z: one Kraken combo bot reconciling five resting orders against a connector answering HTTP 500 made 96 requests in ~100s (5 order ids x exactly 18, plus 6 for the `primeReconcileBatch` prefetch) and paged the operator as "86 transport failures ... likely wedged" — 6 logical questions rendered as 86 failures, into a connector that was already struggling. The retry budget now also stops on a failure the transport ladder has ALREADY been spent on, matched by the new `isTransportRetryExhausted` on the `Exchange connector | ` prefix that only `apiCall` throws, and only after those six attempts. Deliberately narrower than `isAmbiguousOrderFailure`: a transient reason carried in a NOTOK body on an HTTP 200 (`Response timeout`, a rate-limit) never sees the transport ladder, so it keeps the full 3 attempts. Measured against a fake 500-ing connector: 18 round trips -> 6, with success, definitive not-found, non-transport transient, and mid-ladder recovery all unchanged.

## [1.56.14] - 2026-09-01

### Fixed

- **A Coinbase Ed25519 API key now fails verification with instructions instead of a dead end.** The CDP portal creates Ed25519 keys BY DEFAULT, and our Coinbase SDK signs its JWTs with ES256 only, so such a key can never authenticate — with "Cloud Trading Keys" selected the user saw the raw jsonwebtoken refusal ("secretOrPrivateKey must be an asymmetric key when using ES256"), and under the default "Legacy Keys" an opaque 401. Worse, the cloud-type case fell into the key-type-mismatch rule, whose "switch to Legacy Keys" advice is the one change that cannot help. A new first-position Coinbase rule in `interpretVerifyFailure` recognises the key by its shape (raw 64-byte base64 secret, no PEM armour — checked before the key-type rules, under either Key Type) or by the ES256 signing error, and says what actually works: recreate the key at portal.cdp.coinbase.com with the ECDSA signature algorithm, and connect with the full `organizations/…/apiKeys/…` key name and the EC PEM secret. The venue's own message is still appended underneath, per this module's guidance-then-evidence rule.

### Fixed

- **A Hyperliquid order the venue had already accepted is no longer written off as CANCELED.** HL answers a status lookup for a brand-new order with `unknownOid` while it is still propagating, and the connector surfaces that as the placement's failure reason — but `unknownOid` can only escape `openOrder` AFTER the venue accepted the order, because the connector's pre-flight duplicate check uses the same token to mean "not a duplicate, go ahead". Classified as a refusal it reached the generic cleanup path and `deleteOrder`, which also unregisters the id from `SharedStream`, so the venue's later fill reached no bot at all. Forum #5097, 2026-08-26: BUY 1.18 HYPE accepted at 05:41:09.682, reported `open` on our OWN user stream at 05:41:09.994, written off at 05:41:20.743, filled at 06:13:32 into a position the bot could no longer see — the deal closed 1.18 HYPE short of the account.

  Three changes, in order of how early they stop it. `sendOrderToExchange` now keeps any order it is still tracking whose `orderId` is no longer the `-1` placeholder, whatever the failure text said: only the venue can set that id, so it outranks any classification of the error string. `unknownOid` joins `AMBIGUOUS_ORDER_FAILURE_MARKERS`, so the #5025 guard asks the venue before writing off rather than not at all. And `_handleUnknownOrder` takes a `justPlaced` mode that suspends the two shortcuts written for a stale reconcile — the `orderId === '-1'` fast-fail, which reads "no exchange id" as proof the order never landed when for a just-placed order it only means the response was lost, and the exhaustion write-off, which now leaves the local record to the reconcile/quarantine path (age floor + strikes) instead of deleting it.

  A definitive venue negative still writes off in both modes, and the placement resend loop cannot duplicate on this: `unknownOid` is ambiguous on the lookup too, so that loop returns the original failure and never re-sends.

## [1.56.12] - 2026-08-31

### Changed

- **The reconcile pass asks the venue about all of a bot's orders in one call, where the venue supports it.** `checkOrdersAfterReconnect` is a strictly serial `for (…) await getOrderForReconcile(o)`, which on Kraken — 20 REST tokens decaying 0.5/s per API key — arrives as a burst that drains the budget and then parks every remaining call for ~2.1s, the user's own `openOrder` included. Measured on prod 2026-08-31: 50.5% of ALL Kraken order placements queued, 72% of `openOrder`, from an average load of just 2.5 calls/min (~8% of budget) delivered in bursts of up to 119 calls in 51s. `primeReconcileBatch` prefetches the pass in one `getOrdersBatch` call (exchange-connector core 1.20.13, up to 50 Kraken orders per call) and `getOrder` serves from it.

  Strictly an optimisation, and the fallback is total: it resolves nothing the per-order path would not, and an exchange with no batch lookup, a transport with no such route (paper-trading mirrors the connector's endpoints and does not carry this one), a partial answer, an empty answer or a thrown error all leave the loop doing exactly what it does today. A venue that declines is memoed process-wide so it is asked once, not once per pass.

  The prefetch is hooked at the transport call inside `getOrder`, not around it, so the client-id → exchange-id translation and the `noExchangeOrderId` guard before it, and the `executedQty` conversion, KuCoin price reconstruction and CANCELED-with-fills promotion after it, all still run exactly as on the uncached path — a batched order is the same order. Entries are single-use and the map is dropped when the pass ends, so a prefetched row can never answer a question asked outside the pass that fetched it. That id translation is now a single `venueOrderId` method shared by both, because a prefetch keyed differently from what `getOrder` asks for would silently never hit.

## [1.56.11] - 2026-08-31

### Fixed

- Revert the 1.56.9 `buyRemainder` change: reduce-only orders are excluded from
  remainder recovery again. Measured on prod over 18.3h, all 15 reduce-only
  remainder orders it placed were rejected with `executedQty: 0`
  (`ReduceOnly Order is rejected.` / `wouldNotReducePosition`) — the remainder is
  derived from the order, not the open position, so the venue refuses it. Nothing
  was recovered and the only effect was ~20 futile orders a day. The gate now
  documents why, so it is not lifted a third time.

## [1.56.10] - 2026-08-30

### Fixed

- Concurrent `getAllPrices` misses now share one exchange-connector round trip
  instead of one each. The Redis `allPrice` cache only ever coalesced callers
  arriving after a table was written; callers that missed together each made
  their own call, and price-driven callers in a bot process always miss
  together — every grid bot runs its own `priceTimerFn` keyed by bot id, so N
  bots on one exchange fired N calls in the same tick. On Binance USDⓈ-M that
  is N x weight-10 `futures_getAllPrices` against a process-wide weight budget
  shared by every Binance user on that connector node, parking their
  `openOrder`/`cancelOrder` behind the flood. The flood was self-sustaining: a
  parked call answers `Response timeout` (NOTOK) and a NOTOK table is never
  cached, so the cache could not re-warm and every later tick fanned out again.
  Measured with 26 bots on one exchange: 26 connector calls -> 1 on a cold
  cache, and 78 -> 3 across three ticks while the connector was congested.

## [1.56.9] - 2026-08-30

### Fixed

- Reduce-only take-profits that underfill now get their remainder re-placed.
  `buyRemainder` returned early on any `reduceOnly` order, so every futures
  venue skipped remainder recovery entirely: measured over 8.4 days, 67 of 69
  underfilled reduce-only TPs stranded (97.1%) against 54 of 670 non-reduce-only
  ones (8.1%). The unsold residue sat on the venue untracked, with no TP and no
  SL, consuming margin until base orders were rejected `Not enough balance`. The
  narrow `kucoinFutures || okx || coinm` exclusion the early return had grown
  around is kept.

### Changed

- `PARTIAL_TP_TOLERANCE` 0.1% -> 5%. Measured venue rounding dust reaches 0.93%
  (median 0.196%), so the old threshold classified routine lot-size rounding as
  stranding and would have held deals open for remainders below the venue's
  minimum order size. Real strandings are 50-98% short.

## [1.56.8] - 2026-08-30

### Fixed

- `updateBalance` (the dashboard's portfolio refresh) no longer waits on the
  on-demand `userSnapshots` run without a deadline. One wedged venue could hold
  it past the dashboard's own 30s client timeout — prod logged 163s and 127s —
  so the user saw a failed request rather than a slow one. The refresh is now
  capped at 25s (`SNAPSHOT_REFRESH_DEADLINE_MS`), after which the last stored
  snapshot is served and the refresh keeps running in the background.

## [1.56.7] - 2026-08-29

### Added

- `getAllOpenPositions` now returns `linkedBots` on each position: every Gainium
  deal mapping onto that venue position, with the size each one holds, the bot's
  start condition and its status. A venue position is a single netted lot that
  several deals can share, so the existing single-bot fields could only ever
  describe one of them.

### Fixed

- Bot attribution for shared positions no longer discards all but one claim.
  `getImportedPositions` assigned into a single-value map, so each later claim
  overwrote its predecessor and only one bot was ever reported — grid bots were
  evaluated last, so a grid bot masked a DCA bot on the same position. The
  legacy `botId`/`botName`/`botType` fields deliberately still report that last
  claim, so the existing dashboard sees exactly what it saw before.

## [1.56.5] - 2026-08-29

### Fixed

- **Bots now reconcile their orders after a socket reconnect, not only after a
  process restart.** `checkOrdersAfterReconnect` is triggered by a user-stream
  (re)subscribe, but Kraken's and Binance's reconnect handlers never published
  that signal — only bybit's and bitget's did. A Kraken ETH/EUR safety order
  filled at 16:15 UTC on 2026-08-28 was therefore not booked until 07:52 the
  next morning, when a deploy restarted the worker: 15h38m in which the deal
  held twice the position the engine thought it had, with its take-profit
  priced off a stale average. (Publisher side ships in websocket-connector.)
- **A transient order lookup in the reconcile pass is retried instead of
  silently dropping the order.** `!res.data` was treated the same as "the venue
  says this order is gone": one warning, `continue`, nothing to re-check it.
  2,731 lookups failed that way across 352 bots in 8 hours. `reconcileLookup`
  now retries with exponential backoff and ±50% jitter, and stops immediately
  on a definitive not-found so the quarantine path keeps owning that case.
- **The reconcile pass no longer stampedes.** A user-stream connector restart
  re-subscribes every account at once, which put 5,319 DCA bots into the pass
  within seconds — 1,422 in a single second — each calling `getOrder` per open
  order, manufacturing the very lookup failures the pass exists to catch. The
  start is now spread over a random window (`BOT_RECONCILE_SPREAD_MS`).
- Reconcile lookup failures are reported once per pass with a count instead of
  one warning per order.

## [1.56.4] - 2026-08-29

### Added

- **`exchange/helpers.ts` `resolveCoinbaseKeysType`** — corrects the Coinbase
  key type when the submitted credentials plainly contradict it. A Coinbase
  Developer Platform key is self-identifying (the key NAME is a resource path,
  the secret is a PEM private key) and cloud auth cannot work without them, so
  a CDP key submitted under "Legacy Keys" is now simply authenticated the right
  way. The selector sits behind an Advanced Settings disclosure defaulting to
  Legacy, and getting it wrong was the largest verification-failure bucket in
  production.
- Correcting this silently is safe in a way the OKX origin is NOT, and the
  difference is the point: `keysType` only chooses between `{apiKey, apiSecret}`
  and `{cloudApiKeyName, cloudApiSecret}` when building the client, so it
  changes how we authenticate and nothing about what the account may trade.
  `okxSource` selects a venue with a different tradable universe, which is why
  that one is only ever reported.
- The correction is one-directional. Absence of the CDP markers is not evidence
  of a legacy key — a truncated paste looks identical — so `cloud` is never
  downgraded; that direction stays a message. Paper providers are excluded:
  their credentials are minted by paper-trading, not typed.

## [1.56.2] - 2026-08-29

### Added

- **`verify.probeOkxOrigins` — work out which OKX platform a key actually
  belongs to.** OKX runs each region as a separate venue and a key only
  authenticates against its issuer, so a perfectly good my.okx.com key and a
  nonexistent one produce the same "API key doesn't exist" on okx.com. The
  origin selector sits behind an "Advanced Settings" disclosure that defaults
  to okx.com, so EU users — exactly the people who need to change it — often
  never see it. This class was 18 of 39 OKX verification failures in
  2026-08-04..28. On a key-not-found rejection the other origins are now swept
  concurrently under an 8s deadline, and the failure message names the platform
  that authenticated.
- The sweep is narrowly gated by `isOkxOriginSuspect`: a timeout must never
  reach it. 20 of those same 39 failures were the venue not answering in time,
  and firing three more `sendtoall` fan-outs at an already-slow venue is how
  the OKX rate-limit pile-up of bug #329 was built. A wrong-passphrase
  rejection is excluded too — the key was found, so the origin is right.
- The result NAMES the correct origin rather than switching to it. `addExchange`
  derives the tradable universe from `okxSource` BEFORE it verifies — OKX
  Europe has no coin-margined product and its X-Perps are beta-gated to the
  Alpha group — so adopting an origin at this point would put the user on the
  EU venue with none of those guards applied. Ambiguous or overrunning sweeps
  resolve to "no answer" and the original failure is reported unchanged.

## [1.56.1] - 2026-08-29

### Fixed

- **A failed exchange-key verification now says what the exchange actually
  refused.** The connector already reports the precise cause — "API key doesn't
  exist" (wrong OKX regional origin), "Unmatched IP", "you are in unified
  account mode", a Binance permission object naming the switch that is off —
  but it arrives as `JSON.stringify(BaseReturn)`, and the resolver forwarded a
  reason only when it contained no brace and no "catch". That discarded nearly
  every venue error in favour of `API keys not valid for <tradeType>`. Over
  2026-08-04..28 that single message covered 370 failures across 93 distinct
  users, several of whom retried 8, 13 and 19 times. New
  `exchange/verifyFailureMessage.ts` unwraps the envelope and, where a rule
  recognises the error, prepends what to do about it. Interpretation is
  strictly additive — the venue's own sentence is always kept underneath, so a
  rule that is wrong or has gone stale can add noise but can never hide the
  evidence. Guidance describes venue behaviour only and never names Gainium
  egress IPs, because core also runs on self-hosted installs that call
  exchanges from their own address.

### Added

- `exchange/helpers.ts` `requiresPassphrase(provider)` — okx / kucoin / bitget
  and their per-market variants. The credential-write paths need this because
  the edit form legitimately leaves the passphrase blank, so the resolver has
  to decide for itself whether blank means "unchanged" or "missing".

## [1.56.0] - 2026-08-29

### Added

- **v2 REST API support for hedge bots (`hedgeCombo` / `hedgeDca`)** — community request "API Endpoints for Hedge Combo Bots". `GET /api/v2/bots/{hedgeCombo,hedgeDca}` and `.../details` list and fetch a hedge bot with both legs populated, and start / stop / restore / archive / clone now accept the two hedge types alongside `dca`, `combo` and `grid`. The engine already supported every one of these operations for hedge bots; only the REST layer refused the bot type.
- **Hedge profit is aggregated server-side** (`bot/hedgeAggregate.ts`). A hedge bot is a WRAPPER over two child bots, and the wrapper's own `profit` / `profitToday` / `workingTimeNumber` are written once at creation and never updated — the engine only ever writes `status` back to it. The dashboard has always summed the legs client-side; without this, every hedge bot would have reported a flat 0 profit over REST. `profit`, `profitByAssets`, `profitToday`, `unrealizedProfit`, `workingTimeNumber` and `dealsInBot` are now summed from the legs at read time. The two legs are independent bots that may settle in DIFFERENT quote assets, so the `*Usd` fields and `profitByAssets` are always exact while the native-unit fields are only summed when the quote assets agree — `profitBasis.native` (`exact` | `mixed`) says which you got. Used by the REST layer only; the GraphQL/dashboard path is unchanged.
- `POST /api/v2/bots/{hedgeType}/{botId}/start` accepts an optional `hedgeConfig: { LONG, SHORT }` body naming what each leg should do with a position it already holds, validated against the action enum before it can reach a leg's `action` field.
- `POST /api/v2/bots/{hedgeType}/{botId}/clone` takes PER-LEG overrides — `{ long?, short?, sharedSettings? }` — because a hedge bot's two legs have their own pairs, exchanges and settings. A flat settings body (what the dca/combo/grid clone takes) is rejected with a 400 that explains the shape rather than being silently ignored. Legs are matched by their own `strategy`, never by position in `bots`.
- `PUT /api/v2/bots/{hedgeType}/{botId}` and `.../pairs` still reject hedge bots — their settings and pair lists are per leg — but now say so instead of listing the accepted types.

## [1.55.5] - 2026-08-28

### Fixed

- **The Deal Returns scatter silently dropped every deal that was open when the bot's settings last changed.** `getBotProfitChartData` read `botProfitChart`, a denormalized one-row-per-closed-deal shadow that only `DCABotHelper.botUpdateStats` writes — and that method returns early, before the write, for any deal whose `createTime` predates the bot's `resetStatsAfter`. Changing order sizing (`baseOrderSize`/`orderSize`/`ordersCount`/`volumeScale`/`maxNumberOfOpenDeals`) stamps `resetStatsAfter`, which is right for the aggregate Statistics tab but permanently erased the straddling deals from this chart, while the deals table beside it still listed them. Because the deals open longest are the ones most likely to straddle a settings change, the points lost were the best ones: bug #564's bot had 212 rows for 363 closed deals and a scatter topping out at 1.77% against a real best deal of 8.14% — the reporter counted 10 deals above 1.3% in the table and 4 in the chart. The resolver now derives the series from the closed deals themselves (`$match` → small `$project` → `$sort closeTime` → `$limit 500`, same 500-point cap), using the new pure `dealReturnPercentage()` helper that mirrors `botUpdateStats`' `perc` expression over the settings snapshot frozen on each deal. This also repairs existing history — no backfill could reconstruct rows that were never written, but deals are never cold-archived (only orders and transactions are), so the full series is recomputable on the next read for every affected bot. Verified against the reporter's 363 real deals: 362 points (the 363rd is a zero-profit cancel, which `botUpdateStats` skipped too), max 8.14%, 10 points above 1.3%; 194 of the 209 pairable pre-existing rows reproduce bit-identically and the rest to float noise.

## [1.55.4] - 2026-08-28

### Fixed

- **`orders` had no `dealId` index, so every per-deal order lookup full-scanned the collection.** `registerIndexes` declared `userId`, `botId`, `clientOrderId`, `latestOrders_filled` and `fillFailsafe_resting` but nothing on `dealId`, and the deal-scoped queries are a family — `{dealId,typeOrder}`, `{dealId,status,typeOrder}` as both a find and a `$match/$group`, `{dealId,side}`, `{dealId}` sorted by `transactTime`, and `{created:{$gte,$lt},dealId,typeOrder}` — for which `dealId` equality is the only indexable predicate any of them has. On prod that last shape alone burned 72,735s of slow-op time over 18,556 ops in ~24h, 69% of all slow-query time on the database, examining ~220 billion documents in an 11.9M-doc collection to return ~429 rows (p50 3.9s, max 11.3s); the scans also evict everyone else's working set from the WiredTiger cache, so unrelated queries degrade with them. `orderSchema.index({ dealId: 1 })` is now declared, so `models.order.syncIndexes()` builds and keeps it at boot rather than relying on a hand-run `createIndex` — one such manual attempt reported success while building nothing, and the gap re-fired later at 20x the cost. Not compound with `status`/`typeOrder`: `status` is mutable and moving entries in an 11.9M-key index is the write regression the partial indexes beside it were shaped to avoid, whereas `dealId` is effectively write-once — rewritten with the same value on every fill event, and genuinely reassigned only by a deal merge. Measured on a seeded 300k-doc collection: 300,000 docsExamined → 1 returned at 249ms becomes an `IXSCAN dealId_1` at 2 docsExamined and 4ms, identical result sets, no measurable insert/update cost.

## [1.55.3] - 2026-08-28

### Fixed

- **Trailing take profit could never arm on a deal whose settings had been edited, leaving it with no take profit at all.** `getTrailingSettings`, `getDealMoveSlPrice` and `getDealSlRefPrice` read the deal's reference price as `settings.avgPrice ?? deal.avgPrice`, while every other site in the file writes the same expression as `settings.avgPrice || deal.avgPrice`. `0 ?? x` is `0`, and an edited deal can carry `settings.avgPrice: 0` — the dashboard's mass deal-edit seeds its form from the bot-form defaults, which declare `avgPrice: 0`, then diffs that against each selected deal's real average and ships the difference, zeroing every deal in the selection at once. A zero reference does not weaken the exits, it removes them: `trailingTpPrice` becomes `0`, which `checkTrailing` gates the arm branch on as falsy, so trailing TP never armed however far price ran — and because `trailingTp` also suppresses the resting TP limit order, the deal had no take profit of any kind while `bestPrice` kept updating, so it still looked actively managed. The same zero put move SL's trigger at `0`, which `last >= required` satisfies on the first tick of a long, and the `baseSlOn: avg` stop at `0` — unreachable for a long, instantly hit for a short. All three now resolve through `dealRefPrice`, and `updateDealSettings` drops an unusable `avgPrice` from an incoming patch so the zero can no longer be persisted by any client (both dashboards, `/api/updateDeal`, the v2 API, the AI deal tools). Pinned by `src/bot/dealRefPrice.spec.ts`.

## [1.55.2] - 2026-08-28

### Added

- **`resetStatsAfter` is now readable over GraphQL** (`fullDCABot`, `fullComboBot`). The field
  has existed on the bot document for years and drives real behaviour — changing order sizing
  (`baseOrderSize`, `orderSize`, `ordersCount`, `volumeScale`, `orderSizeType`, `useDca`,
  `maxNumberOfOpenDeals`) or `profitCurrency` clears `stats`/`symbolStats` and stamps it, after
  which `botUpdateStats` skips every deal created before that instant. Nothing exposed it, so the
  dashboards could not tell a user that a bot's Statistics tab describes a SHORTER window than its
  deals list, and the disagreement read as wrong data (bug #540: a bot whose stats counted 149 of
  its 353 closed deals). Additive and read-only: a new nullable `Float` on two existing types, no
  resolver change — `getBot` already returns the whole lean document.

## [1.55.1] - 2026-08-28

### Fixed

- **A percentage add/reduce funds request was not a percentage of the position.** `addDealFunds` and `reduceDealFunds` sized a `perc` request as the deal's cost basis (`usage.current.quote`) divided by `deal.lastPrice`. `lastPrice` reads like a current price and is not one: `updateDeal` maintains it as a running MINIMUM of fill prices on a long and a MAXIMUM on a short. Cost basis over the *lowest* fill resolves to more base than the deal holds — by exactly the deal's drawdown ratio `avgPrice/lastPrice` — so the error was invisible on a deal that had not averaged down and widened with every safety order that filled: about +1.9% three levels deep and +8.0% eight levels deep. Beyond that the `tpQty` guard treats the request as covering the whole remaining position and CLOSES the deal instead of reducing it, so on a deep ladder a 93% reduce was a full exit. The divisor is now `avgPrice` — the deal's VWAP over its filled orders, which is what bought the cost basis, so cost basis over it is the base acquired by construction — falling back to `lastPrice` only for a deal with no fills, where the two coincide. This restores the documented behaviour: a long holding 1 ETH reduced by 20% sells 0.2 ETH. Futures shorts divided by the running maximum and so under-sized; they are corrected in the opposite direction. Spot short and coin-M deals carry a base amount and never divided by a price — those branches are unchanged. The two percentage branches were hand-maintained copies that had already drifted apart once, and now share a single `percentFundsBasis`.

## [1.54.7] - 2026-08-28

### Fixed

- **A fallback fee rate could permanently overwrite an account's real one.** When a venue cannot say what an account pays, the connector answers with the published schedule's entry rung — a plausible number with `status: OK`, indistinguishable from a real rate at the call site — and the fee sweep wrote it straight over whatever was stored. On Kraken that rung matches NO tier in the live schedule (it reads 0.40%/0.25%; real Tier 1 is 0.80%/0.40%), so the replacement was not merely stale but a rate the venue offers nobody, understating the true cost by about half. Observed 2026-08-28: a transient `EGeneral:Temporary lockout` (#543) made TradeVolume fail for several accounts mid-sweep and 1341 of one account's 1615 pairs were overwritten in a single pass — 16 of 54 Kraken connections were left on it, 7 of them with live bots, some carrying rates last touched in April. These fees size the base-order gross-up and the take-profit, so the error is real money. A fallback may now only CREATE a row that does not exist yet; once any rate is stored, only the venue's own answer may replace it. `source` is persisted on the fee row so the two can be told apart. Poisoned accounts self-heal on their next successful lookup — verified on a live account, which went from the 0.40%/0.25% fallback to its real 0.60%/0.30% (Kraken Tier 2) across 1340 pairs.

## [1.54.6] - 2026-08-27

### Fixed

- `getAllUserFees` dropped `UserFee.source` on the way through the exchange layer, so 1.54.3's fallback-attribution logging never fired. The mapper rebuilds each entry as a `{pair, maker, taker}` literal rather than spreading, which silently discards any field the connector adds unless it is named — the single-pair `getUserFees` returns its response unmapped and was unaffected. Verified against prod: the connector reported `EGeneral:Permission denied` for one account on every sweep while main-app logged zero fallback lines.

## [1.54.5] - 2026-08-27

### Fixed

- **A follow-up to 1.54.4: an observed fee could be overwritten with zero on the grid/combo transaction path.** That path is built on an invariant the *estimate* happens to satisfy — for a buy the fee sits in `comBase` and `comQuote` is 0, for a sell the other way round — and four separate conversions (`comBase = comQuote / price` and friends) read that shape. A real fee does not satisfy it: Kraken bills the base asset on a sell and Coinbase bills quote on both sides, so writing the venue's split in directly left the opposite field at 0 and let the very next conversion clobber the real number. The observed total is now expressed on the trade's side before it is written (`observedFeeOnSide`), which keeps the magnitude — the thing that was wrong — and leaves the shape alone.
- `getCommDeal` converts an observed fee at the ORDER's own fill price rather than the deal's current price. The estimate it replaces was per order at `v.price`, so a deal that had moved since a fill would otherwise value that fill's fee at today's price.

## [1.54.4] - 2026-08-27

### Added

- **`deal.feePaid` is now an OBSERVATION rather than a computation, wherever the venue reported one.** It was previously the sum of `qty * price * storedFeeRate` over every filled order — an estimate that is only ever as good as the stored rate, and therefore wrong for a whole deal whenever that rate has drifted from what the venue really charges. exchange-connector core 1.20.8 and paper-trading core 1.3.8 now report the fee each venue actually took, and `CommonOrder` mirrors their fields here (`feePaid`, `feeSide`, `feeAsset`, `feeBreakdown`) — all optional and additive. The captured fee is persisted on the order document.
- The same observation now feeds `deal.commission` (`getCommDeal`) and the combo/grid transaction's `pureFeeBase`/`pureFeeQuote`, so the deal's cost basis, its P&L and its reported fee all come from one source.
- **The user-stream commission is no longer discarded.** websocket-connector has always forwarded `commission` + `commissionAsset` on both `executionReport` and `ORDER_TRADE_UPDATE`, and `convertExecutionReportToOrder` threw them away. This matters most on Binance, whose order endpoints report no fee at all: for an order that rests and fills later, the stream is the only source there is. The stream reports per TRADE, so the fee is accumulated across slices, made idempotent against a replayed report by a `feeTradeId` high-water mark (venue trade ids increase monotonically, so a report at or below the mark is ignored, and a report with no id at all is ignored because a repeat could not be told from a new trade).

### Notes

- **`commission` remains the fallback, per ORDER rather than per deal**, and a fee that cannot be resolved is NEVER booked as zero. A zeroed fee is a claim that the fill was free, and replaces a roughly-right number with a definitely-wrong one. Three cases fall back: the venue reported nothing (paper legs from before core 1.3.8, an order with no fills, Binance futures order lookups, any order predating this change); the venue charged in an asset that is neither side of the pair (a BNB, BGB or KCS discount) — the amount is kept on the order but converting it needs an FX rate at the fill's timestamp that is not available here; or a multi-currency `feeBreakdown` where not every leg is on the pair. `observedFeeSplit` returns `null` rather than a zeroed split so this cannot be got wrong by accident.
- An observed fee already on an order survives a later poll that reports none — `mergeCommonOrderWithOrder` rebuilds the order from the exchange payload, so without that the stream-captured Binance fee would be silently erased by the next order check.
- Covered by a standalone ts-node check (`src/bot/orderFee.spec.ts`; this repo has no test runner).

## [1.54.3] - 2026-08-27

### Added

- `UserFee.source` mirrored from the exchange-connector contract (optional/additive), so `updateUserFee` can log WHICH user received published-schedule fallback rates instead of their account's real ones. The connector cannot say — it receives credentials only, never a userId — so the sweep is the only place the two halves join. Previously a degraded lookup was silent: it answers OK with a plausible number and the stale rate is written to the user's fees unremarked.

## [1.54.2] - 2026-08-27

### Fixed

- **A Kraken DCA deal opened with no safety orders on the exchange at all.** `placeOrders` looks the pair up with `getExchangeInfo`, which is keyed on the platform form (`ETH-EUR`), but callers that take the symbol off an exchange ORDER pass the venue's own spelling — on Kraken `ETHEUR`, `XBTUSD`, `XRPUSD`. The lookup missed, and the method returned before placing anything. Since the ladder is built when the base order fills and handed straight to `placeOrders` as `orderBo.symbol`, it was dropped on every deal open: the deal ran with only its base order, and the ladder reached the exchange only if something later reloaded the bot (a settings save, a restart, a worker recycle), because the restore path passes the deal's own symbol. Silent — the miss is a warning in the service log, with no bot message and nothing on the deal, so a user could only find it by looking at their exchange. Present daily in production as `Exchange info not found for XBTUSD` / `XRPUSD`. The pair is now resolved from the deal, with the argument kept as the fallback when the deal is not in memory; two combo callers carried the identical defect and are fixed by the same change. Venues whose native symbol already matches the platform form (most of them) were never affected.

## [1.54.1] - 2026-08-27

### Fixed

- Cancelling a Kraken **spot** order no longer cancels a different order. `cancelOrderOnExchange` addressed the venue by our client order id, and Kraken spot has no client-id lookup — the connector falls back to `userref = parseInt(clientOrderId.substring(0, 8), 16)`, which stops at the first non-hex char, so every `D-*` id collapses to userref 13 and every `CMB-*` to 12. `getOrder` then returned whichever same-userref order the account listed first and we cancelled that one, reporting success. Kraken spot now uses the stored `orderId` (the Kraken txid), routing through the connector's exact `isKrakenSpotTxid` → `getSpotOrderByTxid` path — the swap `_handleUnknownOrder` already made in 1.32.4 for the same reason. In production 232 Kraken txids were shared by more than one client order id across 1,992 order rows, on 63 of 79 Kraken-spot bots.

## [1.54.0] - 2026-08-27

### Added

- `getBotDcaUsage` / `getComboBotDcaUsage` — DCA-usage histogram folded in Mongo over all of a bot's deals, for the dashboard's DCA Analysis widget

## [1.53.14] - 2026-08-26

### Fixed

- Bot notifications now name the pair that actually errored. `processError` labelled every message with `settings.pair[0]`, so on a multi-pair bot each notification claimed the bot's first pair no matter which one failed — a row could read `BTC-USDC` above a message about AIOZ. The occurrence's own symbol is now threaded through `handleErrors` / `handleOrderErrors` (`order.symbol`, or the deal's symbol), and `settings.pair[0]` stays the fallback only for bot-level conditions that have no erroring pair, such as a revoked API key. Across a month of production `Not enough balance` messages, a meaningful minority of machine-checkable rows named a pair contradicted by their own message text. The same value feeds the realtime `bot message` socket payload, so the notification bell is corrected too.

## [1.53.13] - 2026-08-26

### Changed

- The base-order fallback notice added in 1.53.12 now logs at debug level for the `nominal` case and keeps log level for the two that are worth reading. Measured on prod right after the fix went live: the `nominal` branch is the routine one — every deal whose opening order has not landed yet passes through it, ~650 lines/min across the DCA fleet and 1% of the worker's whole stdout — and it is the case with nothing to diagnose. `deal` and `accounted` say something about a deal's books and stay visible. The line also prints `(new)` rather than an empty id for a deal that does not exist yet.

## [1.53.12] - 2026-08-26

### Fixed

- **A DCA take-profit was sized from the NOMINAL base order size instead of the position the deal actually held.** `getTPOrder` builds the close as `sum(entry fills) + base order`, and when the base order's row was not in the order map it re-derived one from `baseOrderSize`. Two things put it in that state and both are now closed.

  First, a base order that partially fills and is then CANCELED is a terminal row, and `loadOrders` filtered `status: CANCELED` out of its query — so after a worker restart `findBaseOrderByDeal`, which is written for precisely this case (`['CANCELED','FILLED']` plus `executedQty > 0`), could never find it. A Coinbase AIOZ deal's base order executed 345.3 of 1790.1 before being cancelled; the nominal put 1788.4 back, and the deal asked the venue to sell 5147.9 against 3711.30 held. The venue rejected it, which leaves a deal with no take-profit at all. Open deals now load their partially-executed cancelled entry orders back, scoped by deal id so the query examines the same documents as before. The same rows are what the deal fee split and `updateUsage`'s filled base were already written to read.

  Second, deals restored from the Redis snapshot had their orders — take-profit included — generated *before* `_loadOrders` populated the order book, so the sizing saw no fills whatsoever and the nominal became the entire take-profit: 1786.1 against the same 3711.30, and a still-resting 2226 against 103,547 on another deal. The restored deals are now seeded first and their orders generated after the load. That also fixes a second-order case: generating and setting a deal in one pass meant `getDeal` could not see the deal whose orders it was generating, and `findBaseOrderByDeal` returns nothing without it.

  The base order size is now taken from the deal's own books when its row is missing — the volume the counted fills do not explain IS the base order, exactly, with no reference to settings. The settings-derived fallback is kept for the case it was written for, a deal whose opening order has not landed yet, and is no longer reachable once the deal holds anything.
- A safety order that partially filled and was then cancelled now counts toward the take-profit size. It was matched `status: FILLED` only, so every one of them under-stated the position by whatever it had already executed — the same omission as the base order, on the orders that outnumber it.
- The settings-derived base order fallback now converts `usd` sizes through the USD rate and treats an unset `orderSizeType` as quote, matching `getBaseOrder`. `percFree`/`percTotal` are a percentage of a live balance the take-profit path cannot see, so they fall to the venue minimum rather than being read as a coin quantity — a `percTotal` BTC deal had rested a 0.537 BTC take-profit against 0.105 BTC held.

## [1.53.11] - 2026-08-26

### Fixed

- **A keep-orders reload rebuilt the bot's order book from a stale Redis snapshot and silently lost every order created since that snapshot was written.** `setOrdersToRedis` is `@RunWithDelay`'d and the timer resets on every order mutation, so under churn the snapshot is not one debounce interval stale — it is as old as the last quiet gap in the bot's order activity, seconds or more. A keep-orders reload (a settings save, a deal restore) sets `serviceRestart` *and* `secondRestart`, then `clearClassProperties` wipes `orders`/`ordersKeys` and refills them from `_loadOrders`, which gated its Redis shortcut on bare `serviceRestart` and so took the snapshot. Orders newer than it were not marked stale, they were gone: no entry in `orders`, none in `ordersKeys`. `accountCallback` then dropped every later stream event for them at its `ordersKeys` guard and logged nothing at any level, so a fill that really happened on the venue was discarded and the deal sat holding a position the bot did not know about until a REST reconcile happened to notice hours later — and where the lost order was a resting safety order, the reload re-placed the same price level moments after, duplicating it on the exchange. `_loadOrders` now uses the same `serviceRestart && !secondRestart` cold-start guard as the deals snapshot beside it and as the rest of the engine; a reload reads the DB, which is one bot and cheap, and a mass restart still gets the snapshot it exists for. Grid was never affected (it passes `skipRedis`); DCA, combo and hedge shared the path.
- A fill or partial fill delivered for an order the bot is not tracking is now reported as `STREAM-DESYNC` instead of being dropped in silence. `SharedStream` routes these to one bot specifically, so the bot's book disagreeing with the router is a real desync and, on a fill, money about to go unbooked — it was the same silent `return` that kept the loss above invisible.

## [1.53.10] - 2026-08-26

### Fixed

- Booking a partial fill off a canceled take-profit now requires a usable `updateTime`. Cancel records written from a REST response rather than a stream event can carry a bogus `executedQty` next to `updateTime: -1`; production holds such a row, and it looks exactly like a 1.29 partial fill on an order the venue never filled. Trusting it would invent a sale and under-size every later take-profit by the phantom amount — a silent failure in the opposite direction to the one 1.53.8 fixed. Stream events always carry a real timestamp, so nothing legitimate is lost.

## [1.53.9] - 2026-08-26

### Fixed

- A keep-orders reload — a settings save, or a deal restore — no longer re-places a running deal's take-profit. 1.53.8 left this path alone because `placeOrders` has its own take-profit guard, but that guard only covers one of the three ways the recompute can land. `currentOrders` is rebuilt from the deal's current price, so the recomputed take-profit sits at a different price and often a different size than the one already resting: a larger one makes `placeOrders` cancel the resting take-profit and send a replacement, and one of equal size makes it place a second take-profit on top (the price differs, so `isOrderExistInDeal` finds no counterpart and neither quantity branch fires). Only a smaller one was skipped. The first two reach every open deal in a single pass, so a 50-pair bot re-placed ~50 take-profits inside two minutes with the entries hours in the past — which Binance Futures scores as ~50 orders placed against no fills in the same 10-minute cycle, an unfilled ratio of 1.0 against a 0.99 ban threshold, and restricts the whole account for. A running deal keeps the settings and the orders it started with, so its resting take-profit is the correct one and a save has no business touching it; one is now placed only when the deal has none resting. The two legitimate cancels are unchanged, both being scoped to a single deal: a deal closing cancels its own take-profit, and a position that changes size has its take-profit resized by the fill path.

## [1.53.8] - 2026-08-26

### Fixed

- A partially-filled take-profit that was later canceled no longer loses the part that executed. `updatePartiallyFilledTP` records it off the PARTIALLY_FILLED event, but not every venue emits one — Coinbase keeps such an order OPEN — and `processCanceledOrder` was an empty stub even though the cancel report carries the executed quantity. The deal went on counting base the account no longer held, so every later take-profit was sized above the free balance, rejected by the venue, and the deal was left with no take-profit and no way to close it. The record keys on `clientOrderId`, so seeing both events books the quantity once.
- A keep-orders reload — a settings save, or a deal restore — no longer stacks a second ladder of safety orders on the live one. The reload deliberately leaves the deal's orders resting, but still re-placed a full set: `currentOrders` is rebuilt from the deal's current price, so its levels sit at prices and sizes that `isOrderExistInDeal` (which matches on price+qty+side) finds no counterpart for, and the deal ended up with twice the resting exposure the user configured. A take-profit cannot duplicate this way — `placeOrders` has its own guard — so that path is unchanged.

## [1.53.7] - 2026-08-25

### Fixed

- A DCA deal whose 35s enter-market fallback was refused by the venue is no longer stranded without an order. `checkBaseOrder` cancels the resting limit base order to make room for the market entry and used to latch `enterMarketPrice` before sending it, so a refusal — a Coinbase book in limit-only mode — left the deal in `start` with nothing on the book and the latch permanently suppressing any further attempt. The latch now records the venue's answer rather than our intent, and a limit-only refusal re-places the base order as a limit instead of abandoning the entry. Such deals still counted as an active pair on the Bots tab while showing no trade, which is the count mismatch users reported.

## [1.53.6] - 2026-08-25

### Changed

- `priceBalancesUsd` now builds its tokenized-stock fallback map lazily. `pairs` has no index on `assetCategory`, so that lookup is a collection scan, and it is only ever read for an asset the crypto rate table could not price — but it ran on every call, including the all-crypto portfolios that are the overwhelming majority. With `getBalances(includeUsdValues)` this path is now on every dashboard portfolio view, so the scan is skipped unless something actually needs it.

## [1.53.5] - 2026-08-25

### Added

- `getBalances` can value each holding in USD server-side (`includeUsdValues`), reusing the same `priceBalancesUsd` per-venue path the portfolio snapshot cron and the public REST balances endpoint already use. The dashboard previously had to derive a price by matching an exchange ticker against the screener's coin symbols, which silently rendered `$0.00` for anything the screener could not match — a coin renamed upstream (Coinbase still lists Toncoin as `TON`; the screener carries CoinGecko's `gram`) or a long-tail listing the screener does not carry at all. An asset the venue publishes no rate for now returns `null` rather than a confident zero, so a consumer can tell "worth nothing" apart from "we could not price this". Off by default; existing callers are byte-for-byte unchanged.

## [1.53.4] - 2026-08-24

### Fixed

- Backtest files are served only from inside the `user-files` directory. `loadBacktestDetails` read a path back from the database and handed it straight to `sendFile`, trusting whatever was stored. The writer bounds what it creates today, but rows written before that guard are still in the database, so the serving side now re-checks containment against the same root rather than trusting the stored value. Reported on `main-app-sh` PR #12 by M1ch43lV.

## [1.53.3] - 2026-08-24

### Fixed

- Combo futures bots now refuse to start when the symbol already holds a position on the opposite side, the same rule DCA and Grid bots have always had. On a one-way (non-hedge) account the venue keeps a single net position per symbol, so two opposing combo bots fought over it: the second bot's reduce-only exits were rejected by the exchange and its deal could only be closed by hand. Hedge legs are unaffected.

## [1.53.2] - 2026-08-24

### Fixed

- A DCA bot-settings save really does leave running deals their orders now. 1.53.0 stopped re-deriving each open deal's settings — that part held — but it removed only one of **two** teardowns, and not the one users were hitting. `restoreWork`, which runs further down `start()`, cancels every resting order for any reload it does not classify as a cold service restart, and the reload flags deliberately make a settings save not look like one. So the cancel moved instead of going away: one 50-pair bot had all 300 of its orders pulled and re-placed about two minutes after an edit, with the user watching it happen for the second time. A reload that must keep the book now says so explicitly, and `restoreWork` reconciles against the venue instead of tearing it down. Combo was never affected — its own `restoreWork` override tests `serviceRestart` alone — and that asymmetry is now pinned by a test rather than left as a coincidence.

## [1.53.1] - 2026-08-24

### Fixed

- A bot reload no longer replays stale signal deals. `restoreWork` walks every deal still in `start` and re-placed its opening order regardless of why the deal existed — so a deal created by a TradingView webhook that was refused at the time (for example under a Binance Quantitative Rules restriction) could be executed hours later by a reload, opening a trade at a moment the signal never described. One production account had a reload replay a 21-hour-old webhook deal into a long the strategy had since flipped short on. The sweep now applies the same rule as the Quantitative Rules give-up path: only an ASAP deal — whose start carries no timing — is re-attempted; a deal opened by a webhook, indicator, timer or manual click is cancelled instead, and its own trigger opens the next one.

## [1.53.0] - 2026-08-24

### Changed

- A bot-settings save now applies to **new deals only**. Deals that are already running keep the settings they opened with and keep their resting orders. Previously every save re-derived each open deal's settings from the new bot settings and then cancelled and re-placed the bot's whole order book — take-profits included — so an edit that could not possibly affect an open deal still re-targeted live take-profits, cost every order its place in the exchange queue, and left open deals with no TP or SL resting on the exchange for the width of the cancel/re-place window. Changing a Deal Start filter, which only ever decides whether a *new* deal opens, tore down and rebuilt the orders of every deal already running. This applies to DCA, Combo and both Hedge types; a Grid bot has no per-deal settings and still rebuilds its ladder on save. A running deal is still editable on its own, from that deal's menu. Combo's TP/SL-only shortcut, which pushed the new target onto open deals without the full reload, is gone for the same reason. The bot worker still reloads on save so the next deal uses the new settings, and it now rebuilds its indicator subscriptions when it does: the keep-orders reload path reconciles indicators by symbol alone, so swapping one indicator for another on the same pair would otherwise have left the old one subscribed and never subscribed the new one.

## [1.52.11] - 2026-08-23

### Fixed

- A deal we decline to re-open is now released instead of holding its symbol. A deal is written before its opening order reaches the venue, so an order refused under Binance's Quantitative Rules leaves the deal in `start` with nothing on the exchange. While the retry loop existed something eventually opened or failed it; now that we correctly stop retrying, nothing did — and an abandoned deal still counts against `max deals per pair`, so it silently swallowed every later signal for that symbol. One account had a deal created during an account-wide restriction hold XTZUSDT for four hours and eat a TradingView signal that arrived long after the restriction had cleared; 42 deals on that account were sitting in the same state. Only a deal still in `start` is released — one that has opened, closed or been cancelled is left exactly as it is, so this can never abandon a real position.

## [1.52.10] - 2026-08-23

### Fixed

- A Binance Quantitative Rules restriction no longer re-opens itself. Every order refused during one restriction was scheduled to retry at that restriction's expiry plus one second — the same instant for all of them — so the moment an account-wide window lifted, everything it had blocked fired together: one account saw 39 opening orders retry, fill and place 39 take-profits inside a single minute across 39 symbols. Binance measures the unfilled ratio per symbol in 10-minute buckets, so a burst of that shape lands placed quantity on dozens of symbols with nothing executed against it, records a violation on each, and ten symbols at once re-opens the account-wide restriction the burst was waiting out — 69 seconds after the previous one expired, in that account's case. Retries are now spread across a jitter window, backed off per attempt, capped, and refused outright once a symbol is within a few violations of the level-2 threshold, since our own refused retry is itself a violation. Only a deal started ASAP is retried at all: every other start condition is a point in time, so re-sending it after a restriction lifts opens a trade the original signal never described, and its own trigger will fire again anyway.

## [1.52.9] - 2026-08-22

### Fixed

- A Kraken Futures duplicate-order rejection no longer writes off an order the venue is actually holding. Kraken spells it `clientOrderIdAlreadyExist` with no spaces, so it matched none of the duplicate-recovery variants (OKX's spaced `Client order ID already exists` already did) and fell through to the terminal write-off — which also unregisters the id from the shared stream, so the venue's later fills reach no bot at all. One combo bot on krakenUsdm had a reduce-only SELL written off 1.7s after it went live on the venue, then filled 34 @ 1.4219 an hour later — a fill the deal never saw. Both spellings now also classify as `Duplicate order ID` instead of Uncategorized.

## [1.52.8] - 2026-08-22

### Fixed

- The pre-start position check no longer treats a reported leverage of 0 as a mismatch. A connector that cannot state a position's leverage reports 0 — Kraken Futures has no per-position leverage at all (it is a per-contract account preference), and exchange-connector core 1.19.14 reports `'0'` for cross/dynamic or an unreadable preference where it used to hardcode `'1'`. Compared literally, that hardcoded 1 refused to start every Kraken futures bot above 1x into an existing position ("Leverage in active position is 1, but in settings 2") — and users worked around it by dropping bots to 1x. Unknown is not a mismatch; a real isolated leverage still is.

## [1.52.7] - 2026-08-22

### Fixed

- A deal abandoned with an open position is no longer reported as "Deal closed". Stopping a bot whose `stopType` is `leave` cancels the deal's resting orders and deliberately leaves whatever already filled on the exchange, but the bot event still read `Deal closed, id: …, profit: 0$` — so a user who read their event log correctly concluded the deal was finished. It was not: the position stayed on the venue, unmanaged, with no take profit and no stop loss. A 125 XRP Kraken futures short was left that way on Aug 18, went unwatched for three days, and was liquidated by the venue on Aug 21. A `canceled` deal that still holds volume now names the outcome, the size left behind and that the bot no longer manages it.
- The explicit `leave` close path recorded nothing at all. It cancels the resting orders and returns before `processDealClose`, so a deal left open produced no event and no message anywhere. It now reports the abandoned position as a warning (never an error — leaving a position is what the user asked for, and it must not flip the bot into `error`), under its own `Position left open` subtype so the admin rules can tune it without touching real errors. The throttle is bypassed: stopping two bots in a row has to report both positions.
- A bot blocked by the pre-start position check no longer goes quiet. When `loadData` refuses to start (leverage, margin type or side of an existing venue position disagrees with the settings) the bot is stopped, but no status event was written — the event log's last line stayed `open status is set` while the bot sat closed and never retried. A hedge long leg blocked this way opened zero deals for ten days and looked merely idle; the user attributed it to an unrelated stop-loss deal on the other leg. The transition is now recorded, and says the bot will not retry on its own.

## [1.52.6] - 2026-08-22

### Fixed

- A bot error the user never saw is no longer deleted before they can see it. `restoreFromRangeOrError()` tombstoned every undismissed message on a bot whenever it left `error` status, on the premise that leaving that status meant the condition was gone — but `BotStatusEnum.error` is soft and the bot returns to `open` on the very next cycle whether or not anything was fixed, so the clear ran against live conditions, every cycle. The notifications feed filters on `isDeleted`, so the row vanished from the panel seconds after it was written: an OKX key that could not place an order for three days produced 12 visible messages, 12 tombstoned, and nothing at all in Notifications — the only surviving trace was the bot's Events tab (community #5041). Recovery now clears the bot's error badge and nothing else; a repeat `$inc`s the one row the user is looking at, as `logMode: 'once'` always intended, and dismissal remains what re-arms the subType.

## [1.52.5] - 2026-08-21

### Fixed

- `getDataByPriority` now falls back to the OAuth/top-level value when a field is absent from the partial `userDefined` override, so a surname saved to Settings → Personal data survives a reload instead of reading back empty (bug #471). The `userSettings` mutation also mirrors `lastName` into `userDefined` alongside `name`, and no longer drops `name`/`lastName` when they are deliberately cleared.

## [1.52.4] - 2026-08-21

### Fixed

- `getBalances` for a futures leg that is `linkedTo` its spot leg (OKX / Bybit unified accounts) now returns the shared balance pool, tagged with the requested leg — the bot form showed "BAL 0" for every such account because balances are only stored under the source leg (reported on OKX Europe X-Perps, forum topic 4925).

## [1.52.3] - 2026-08-21

### Fixed

- API-key signatures can no longer be replayed. The `time` header is part of the signed material but was never compared to the clock, so a captured request stayed valid indefinitely and could be replayed verbatim. Requests whose timestamp sits more than five minutes from server time are now rejected before the signature is even computed; `API_SIGNATURE_WINDOW_MS` widens or (at `0`) disables the check. The signature comparison is also constant-time now, so it no longer leaks through timing how many leading bytes a guess got right (GHSA-whmj-5f67-9f3w).
- Session tokens expire. `jsonwebtoken` reads a numeric `expiresIn` as seconds, and this was handed a millisecond epoch — signing an `exp` roughly 56,000 years out, so no session ever expired and any leaked token was permanent access. Minting now goes through a shared `signSessionToken` helper that takes seconds and derives the persisted `expiredAt` from the token's own claims, so the stored row and the enforced expiry cannot disagree. Override the 30-day default with `SESSION_TTL_SECONDS` (GHSA-7gxr-ppgj-jjg8).
- Failed logins return one generic message. The login mutation answered "Password not correct" for a real account and "Sign up Error" for an unknown one, which let anyone sort addresses into those that have accounts and those that do not (GHSA-whmj-5f67-9f3w).
- Credential-bearing GraphQL operations are rate limited. The `/api` REST routes had a limiter; the GraphQL endpoint had none, so the login mutation could be brute-forced at full speed. Ten attempts per minute per address now, applied only to auth operations so ordinary dashboard traffic is untouched — `AUTH_RATE_LIMIT_MAX` adjusts it (GHSA-whmj-5f67-9f3w).

## [1.52.2] - 2026-08-21

### Fixed

- `cli:reset-password` now signs the account out everywhere as well as changing the password. It only rewrote the password before, so every session stayed valid — and on a self-hosted install this command is the recovery path an operator reaches for when an account looks compromised, which meant the intruder stayed logged in through the very reset meant to evict them. Same reasoning as the `changePassword` fix in 1.52.0.

## [1.52.1] - 2026-08-21

### Fixed

- A closed futures deal now reports the quantity it actually closed. `size` means the live position while a deal is open, but once the position is gone there is nothing left to read it from, so it was back-derived from the deal's usage instead — a different quantity, in the same field. Whether the derived value or the real one ended up stored depended on whether a usage update happened to land after the deal's status flipped, so roughly half of closed futures deals showed one basis and half the other, and `Size × Average Price` did not reconcile with `Notional Value`. The real closed amount — the closing fill plus any earlier partial take-profits — is now recorded when the deal closes and preserved afterwards. Display only: nothing in the engine reads this field.


## [1.52.0] - 2026-08-21

### Changed

- **Changing your password now requires your current password.** `changePasswordInput` gains a required `currentPassword` field, so a session alone is no longer sufficient to set a new password (GHSA-4m6h-m5mj-733x). **This is a breaking API change** — update the dashboard to main-dash-sh 2.45.0 or later in the same upgrade, or the change-password form will stop working.
- Changing your password now signs out every other session on the account, keeping only the one you changed it from. Previously all existing sessions survived a password change.

### Fixed

- The Socket.IO user stream now requires `userId` and `userToken` to be strings before they are used to look a user up, and no longer registers the legacy inbound bot-relay events unless `STREAM_ACCEPT_LEGACY_SOCKET_RELAY=true` is set (GHSA-hmxp-q7gj-rr88). Live updates travel over Redis (`STREAM_TYPE=redis`, the default in `.env.sample`), so the relay events are unused in a standard deployment.

## [1.51.30] - 2026-08-21

### Fixed

- The not-enough-balance guard is no longer wiped by an ordinary small fill on the same pair, so a recovery order the exchange keeps refusing is finally allowed to back off. The guard counts refusals per (symbol, side), which deliberately puts a combo bot's routine grid orders and its much larger safety/recovery order on one counter, and it retired that counter on any success at least as big as the *smallest* order the venue had ever refused on the key. That floor screens out nothing: once a grid order has been refused a single time during a dip, it sits at grid-order size forever, and every grid fill a few minutes later cleared both the counter and the retry cooldown that only the big order had built. One Kraken combo bot re-sent the same 262 USD recovery order — identical symbol, side, quantity and price, a fresh order id each time — for seventeen days, arming and losing the guard six times in six hours. Retiring the guard now takes a success at the *largest* size the venue has refused, and the same rule stops a small affordable order from decaying the counter before it is sent. Suppression still starts at the smallest refused size, so nothing that was being held back is let through.

## [1.51.29] - 2026-08-21

### Fixed

- Combo futures deals now record the funding they accrue, and their take profit accounts for it. Combo's `createDeal` never seeded the funding cursor its DCA counterpart does, and the per-deal funding write is a compare-and-swap on that cursor — so on a combo deal it matched no document and every write was silently dropped, while closing the deal still subtracted the in-memory funding from the reported profit. Users were left with a profit figure reduced by a real cost and no line anywhere explaining it. Deals already open adopt the cursor on their next settlement instead of having to be reopened, and a combo deal started on a pair the bot was not already holding subscribes to that symbol's funding straight away rather than waiting for the next bot start.
- Combo take-profit and stop-loss targets now include accrued funding. The target is a percentage of the deal's usage, and it previously ignored funding entirely, so a perpetual held long enough for funding to rival that percentage could reach its take profit and still close at a loss. The two directions of the equation — the price that hits a target, and the percentage at a price — had been maintained as two hand-written copies; they now share one implementation, with a test pinning their round-trip and their agreement with the previous formulas when funding is zero.

## [1.51.28] - 2026-08-21

### Fixed

- A deal whose opening order the exchange refused under a Binance Quantitative Rules cooldown now re-attempts as soon as the cooldown ends, instead of waiting for the periodic order sweep. The retry timer that exists for exactly this — the exchange never saw the order, so nothing in normal running re-places it — was skipped for any caller that asks for the rejection reason back, which is every deal-opening order. One deal spent 2h28m between its refusal and its next attempt, most of it after the restriction had already expired. The re-attempt re-runs the whole deal-opening sequence rather than re-sending the bare order, because that is what starts the deal on an immediate fill and arms the limit-reposition timers on one that rests; it is keyed on the deal, so repeated refusals collapse onto the single re-open the deal needs instead of accumulating one pending retry per attempt. An opening order held back this way is also no longer left behind as an order the exchange has never heard of. Safety orders and take-profits retry exactly as before.

## [1.51.27] - 2026-08-21

### Fixed

- A DCA or combo bot whose DCA order spacing scales on ATR or ADR now always carries the ATR/ADR indicator that spacing is computed from, and says so plainly if it ever does not. That indicator is what prices the safety-order ladder, and until now it was only ever created as a side-effect of switching the "Base scaling on" selector in the interface — so a bot saved through the public API, a clone, an AI agent tool, or a form submit that never touched that selector could be stored set to ATR with no indicator behind it. Such a bot could not open a single deal, on any pair, for its entire life: the engine found no levels to place orders at and returned without opening anything, writing no error, no bot message and no event. The bot log simply stopped after "Balance check skipped", the deal never appeared, and because the interface hides the ATR panel when the indicator is missing, the owner could not see or repair the cause either. The indicator is now filled in whenever a bot is created or saved with ATR/ADR scaling, so the combination cannot be stored broken from any path. If a bot still reaches that state, the deal attempt now reports that the ATR/ADR indicator is missing instead of failing silently — while a bot whose indicator is merely still warming up stays quiet, as before.

## [1.51.26] - 2026-08-21

### Fixed

- A `startDeal`, `closeDeal`, `addFunds` or `reduceFunds` webhook sent to a multi-pair DCA bot now accepts the pair written the way the platform itself writes it. The webhook only ever recognised the `BASE_QUOTE` form, so `AAVE_USDT` worked but `AAVEUSDT` and `AAVE-USDT` were both refused with "Symbol AAVE-USDT format is incorrect" and no deal was opened — even though those are exactly the identifiers the bot stores in its own pair list and shows in the interface, compact on Binance and dashed on KuCoin. Users copying a pair out of their own bot settings therefore got a webhook that returned HTTP 200, was logged as received, and then quietly did nothing. The pair is now resolved by matching it against the bot's own configured pairs ignoring separators and case, so the underscore, dashed, compact, slashed and lower-case forms all reach the same pair. The quote asset is never guessed from the text: only pairs already configured on the bot can match, an exact `BASE_QUOTE` match still takes precedence, and a pair that is genuinely not on the bot is still refused.

## [1.51.25] - 2026-08-20

### Fixed

- An order whose response was lost on the way back is no longer either placed twice or written off while it is still live on the exchange. Sending an order could fail with a timeout, a dropped connection or a server error — none of which say whether the exchange actually received it — and the order was then re-sent with the same client order id up to six times. On an exchange that does not reject a repeated client order id, such as Hyperliquid, each re-send opened another real order. The opposite case was worse: when the send finally gave up, the order was recorded as cancelled without ever asking the exchange, and because that also unhooks it from the live fill feed, the exchange's later fills for it reached no bot at all — so the position moved on the exchange and never in the deal, silently, with the take-profit ladder then sized off the wrong position. An order is now sent once, and on any outcome that does not tell us what happened the exchange is asked what it has: if the order is there it is adopted rather than re-sent, and it is only re-sent when the exchange confirms it never arrived. The same question is asked before an order is written off, so an order the exchange is still holding is kept. Genuine exchange rejections — minimum notional, tick size, insufficient funds — are unaffected and still fail immediately.

## [1.51.24] - 2026-08-20

### Added

- A deal that was created but whose opening order the exchange refused now records why, on the deal itself. The deal row is written before that order reaches the exchange, so a refusal left the deal listed with no orders and nothing explaining it; the only trace was a bot-level warning that names neither the deal nor the pair. The deal now carries the exchange's reason, when the restriction is expected to lift where the exchange grades it, and whether it covers one pair or the whole account — available over GraphQL, over `/api/v2/deals/*` at the `standard` field preset, and pushed live to an open dashboard. It is cleared the moment the exchange accepts an opening order, and it changes nothing else: the deal keeps its status and the bot is not put into an error state. That matters most for the Binance Quantitative Rules (-4400) cooldown this was built for, where the whole point of the existing handling is that we stop sending orders rather than escalate the restriction, and the deal opens by itself once the cooldown ends.

## [1.51.23] - 2026-08-18

### Fixed

- `addExchange` no longer persists one trade type's connections before the next one has been verified. A "Spot & Futures" add whose key lacked the Futures permission saved the Spot leg and then returned an error, so the account kept a connection the user was told had not been created — and the duplicate check then refused every retry with that key. All requested trade types are verified up front, anything a failed attempt already wrote is rolled back, and the duplicate reason names the existing connection and how to clear it.

## [1.51.22] - 2026-08-18

### Fixed

- The terminal-deal position pre-check no longer skips paper connections. It was written to skip them on the assumption that the engine does; the engine does not. Its `paperExchanges` exclusion guards the margin-type rule and the grid branch only — the side rule fires for `botType === dca` outright, and a terminal deal is a DCA bot. The pre-check was therefore a no-op for exactly the accounts most likely to be driven by an automation on a loop, which is the case it was built for. Paper connections are now checked like any other futures connection.

## [1.51.21] - 2026-08-18

### Fixed

- Take profit and percentage stop loss are fee-compensated on futures again. Both prices are derived from the deal's average entry and then pushed out far enough to clear the round trip — but the fee that displacement reads is deliberately zeroed on futures, because there the fee is charged against margin and never taken out of the position, so the *quantity* leg must ignore it. The two uses were folded into one value in 1.14.17, and the price leg has been reading the zeroed one since: every futures TP and percentage SL was placed at exactly the configured percentage from average entry, with no allowance for fees. Nothing about that is visible from the outside — the deal closes cleanly and the reported profit is accurate, it is simply smaller than the configured percentage implies, by roughly one round trip. It goes unnoticed at ordinary targets and dominates at small ones, where a tenth of a percent is most of the target. The price leg now reads the venue's real fee, the quantity leg still ignores it on futures, and both are pinned by tests.

## [1.51.20] - 2026-08-18

### Fixed

- The re-raise cooldown no longer misses one-bot-per-deal patterns. It is keyed per (bot, subType), which is what makes the window mean anything for a bot the user keeps — but a terminal deal is one bot per deal, created by the request that starts it, so the bot id is never the same twice and the cooldown could suppress nothing at all: every occurrence was the first for its bot, and a caller looping on a condition that would not clear collected one notification per attempt. Terminal deals now key the cooldown on the user, the subType and the symbol, which is what identifies the constraint and is stable across the bots.

### Added

- A repeated-refusal breaker on `POST /api/v2/deals/terminal`. The `400` for a position conflict tells an honest caller why, but does nothing about an automation that ignores the answer and re-sends — and each attempt still pays for a credentialed position read on the way to the same refusal, spending the same exchange rate-limit budget as real trading. After three consecutive refusals of the same (user, connection, symbol, kind), the refusal is replayed from Redis as a `429` with `Retry-After` and the read is skipped. The window widens per refusal, caps at 15 minutes, expires on its own, and is cleared by the first deal that goes through, so a user who closes the position recovers with no intervention. Fed only by refusals the endpoint decides itself — never by the engine's asynchronous start failures, some of which are ours.

## [1.51.19] - 2026-08-18

### Fixed

- `POST /api/v2/deals/terminal` no longer answers `200` for a deal the engine is about to refuse. The endpoint created the bot and dispatched it to a worker, where `loadData` rejected the start because a position was already open on the symbol in the opposite direction — after the response had been sent. The caller was told the deal had been created and scheduled, had no object to watch, and never learned otherwise; the abandoned bot was left behind, closed and without deals, once per attempt. The same question is now asked before anything is created, and a conflict comes back as a `400` naming the side already open. The check is conservative by design: only a conflict it can establish rejects, while unreadable positions, a symbol it cannot line up, a hedge account that may legitimately hold both sides, spot deals and paper exchanges all fall through to the engine's own check unchanged.

## [1.51.18] - 2026-08-18

### Security

- DataGrid `contains` / `startsWith` / `endsWith` filters now match the user's value as a literal string. `mapDataGridOptionsToMongoOptions` ran the value through `encodeURIComponent` and fed the result straight to `new RegExp`, but `encodeURIComponent` leaves `.`, `*`, `(` and `)` intact — so the value reached the engine as a pattern rather than a literal. A bare `(` threw a `SyntaxError` and failed the whole query, and a value such as `.*` silently matched every document instead of the substring the operator names promise. Every metacharacter is now escaped. Reported as GHSA-cc5x-49gv-35wr; note the report's denial-of-service impact does not apply — the pattern is serialised into the MongoDB query and evaluated by `mongod`, never matched on the Node event loop.

## [1.51.17] - 2026-08-17

### Fixed

- A bot error the user alone can resolve (an unsigned exchange agreement, a dead API key, a venue restriction) was re-raised on every bot cycle. `logMode: 'once'` caps such a condition at one visible bot message per bot only while that message stays the coalescing target, and for any subType with `errorsBot: true` it never does: `BotStatusEnum.error` is a soft status, so `restoreFromRangeOrError()` clears the bot's messages and `$unset`s their bucket before the next attempt. The condition re-failed, inserted a fresh row, and every occurrence looked like a first occurrence — a new dashboard message and alert each cycle. `processError` now consults a Redis-backed exponential re-raise cooldown per (bot, subType) — same mechanism and 5min→1h ceiling as the compliance/auth/balance guards — and while it is open writes the occurrence into the hidden lane instead. Hidden rows are born `isDeleted`, which is what the recovery clear filters on, so their bucket survives and they coalesce; the admin Bot Errors page keeps a counted record. User-initiated (`force`) reports are never suppressed, and a Redis failure re-raises as before.

## [1.51.16] - 2026-08-14

### Fixed

- Futures deal take profit placed as a zero-quantity order after a bot worker restart

## [1.51.15] - 2026-08-13

### Fixed

- Reducing a deal's funds by 100% told the user "Reduce funds order qty 1222 NEAR is more than closed order qty 1222 NEAR. Order size will be reduced" — an inequality between two equal numbers, followed by a promise the bot does not keep. When the requested reduction covers the whole remaining position there is nothing left to keep, so the deal is closed at market and no reduce order is placed. The warning now says the deal will be closed, and distinguishes a reduction that exactly covers the position from one that exceeds it. Behaviour is unchanged — only the wording.

## [1.51.14] - 2026-08-13

### Fixed

- `/trade_signal` rejects a webhook it can't act on instead of answering 200. `singleWebhookProcess` returned `undefined` whenever no branch matched — an unknown action name, or a known action whose required parameters or bot state were missing — and `webhookProcess` turned that into `StatusEnum.ok`. The caller got a success for a signal that did nothing. It now returns `{status: notok, reason}`, which the route already maps to HTTP 400, naming the action and listing the supported ones.

### Removed

- `enterLong`, `enterShort`, `exitLong` and `exitShort` dropped from `WebhookActionEnum`. No handler was ever written for them, so they were the silent-200 case above in its purest form: advertised by the dashboard, discarded by the engine.

## [1.51.13] - 2026-08-12

### Fixed

- RPC-latency counters now expose a per-window max (`windowMaxMs`) alongside the cumulative one, so a monitor can report the worst round-trip of a sample window rather than a since-boot high-water mark

## [1.51.12] - 2026-08-12

### Fixed

- Changing a DCA bot's profit currency no longer re-bases the deals that are already running. A running deal keeps the profit currency it entered with; only deals opened after the change use the new one. Combo bots already behaved this way.

## [1.51.11] - 2026-08-12

### Fixed

- The backtest callback routes (`/api/serverSideBacktest`, `/api/serverSideBacktestSaveFile`) now authenticate the caller. They sit above the global JWT middleware — deliberately, since the backtest worker calls them host-to-host with no user token — which left them reachable by anyone who could reach the port. Cloud already guards the equivalent routes with a shared token compiled into its private source; that could not be copied here, because this repo is public and a literal would be both published and identical across every install, so the token is derived per-install from `JWT_SECRET` (override with `INTERNAL_API_SECRET`). Fails closed: with no secret configured, no caller is accepted.

## [1.51.10] - 2026-08-12

### Fixed

- `saveFile` now refuses to write outside `user-files`. The name, extension and subdirectory it receives all arrive from a request body and are all concatenated into a path, so any one of them could walk out of the directory with `../` — the extension included, since it is appended after a dot. Rather than filtering each argument, the resolved directory and the resolved file path are both checked to still be under the root, which also covers whatever argument gets threaded through here next.

## [1.51.9] - 2026-08-10

### Fixed

- The not-enough-balance guard is now aware of order SIZE, so a bot that keeps a small order filling on the same pair and side as one the exchange refuses no longer hammers the venue forever. The guard counts failures per (symbol, side), but affordability depends on the order's notional: a combo bot's 4.83 USD grid order filled every few minutes on Kraken SOL-USD BUY while its 35.10 USD safety order on the same key was refused, and each of those fills wiped the failure counter and the cooldown the safety order had built up. The counter never survived long enough to engage, so every single retry reached the exchange and raised a "Not enough balance" alert — 48 in 12h on one bot, with the guard disarmed for 12.2h at a stretch. Orders below the size the venue has actually refused now pass through the guard untouched (the grid keeps trading), and only a success at or above that size clears it. The failure counter's arm and trip thresholds were also one apart, which let every second attempt slip past the guard.

## [1.51.8] - 2026-08-10

### Fixed

- An order the exchange never accepted is no longer re-checked against the exchange five times before the bot gives up on it. Such an order carries a placeholder instead of an exchange order id, so "the exchange does not know this order" is the final answer the first time it is given — waiting ~15 seconds to ask four more times cannot change it. A Kraken Futures combo bot was holding 37 grid orders that had been refused for insufficient funds days earlier, and re-checking them after a restart cost 222 exchange calls and eleven minutes of errors. Checks that fail for any other reason — a timeout, a rate limit — still get the full retry ladder, as do orders that do hold a real exchange order id.

## [1.51.7] - 2026-08-10

### Fixed

- The not-enough-balance cooldown now opens on any real venue rejection once the failure counter has tripped, instead of only when our own balance figures also agreed the order was unaffordable. `required` is one order's bare notional while the venue prices the whole safety-order ladder plus its fees, so the two disagree — a Kraken Futures bot was refused `insufficientAvailableFunds` for a 12.75 USD order while the venue's OWN available margin read 13.40 USD, and that disagreement was the one case that never backed off. The cooldown is also consulted whichever way the balance comparison falls, so the window it opens actually suppresses. 22 rejected orders in 1.4h becomes 3.

## [1.51.6] - 2026-08-10

### Fixed

- `getActiveOrders()` now honours the exchange auth-failure cooldown, like `checkAssets()` already did. Gating only the balance call left the combo open-a-deal path re-asking a dead API key once per minute — 236 rejections in 3.9h on one bot — while the balance path was correctly backed off to hourly.

## [1.51.5] - 2026-08-10

### Fixed

- `setStatus(..., ignoreErrors)` now forwards the flag to `stop()`. `stop()` assigns `this.ignoreErrors = ignoreErrors` (default `false`) as its first statement, so calling it without the argument wiped the flag `setStatus` had just set and every caller asking to close a bot quietly was ignored. Both the DCA/combo and the grid helper are affected.
- `resetUser` marks its own bot teardown as errors-to-ignore, except for `softLive` which deletes nothing. It closes the account's bots and then deletes their paper user milliseconds later, while the workers are still cancelling — paper-trading answers `400 User not found` and the bot filed it as a user-visible error on a bot that no longer exists. `changeStatus` carries the new `input.ignoreErrors` through to the grid/DCA/combo workers.

## [1.51.4] - 2026-08-08

### Added

- `getAccountFills()` on the exchange layer — read-only access to the venue's own execution history, for reconciling what a venue actually did against what we recorded. Distinct from `getTrades`, which is the public tape for a symbol. Returns an empty list for every venue publishing no such feed and for the paper simulator, whose fills we already own in full.

## [1.51.3] - 2026-08-08

### Added

- Balance records now keep `venueAvailable`, the venue's own figure for how much of an asset is spendable, whenever the user stream publishes one. The field is optional and stays **absent** when the venue reports nothing — absent means unknown, not zero, and a stored zero would read as "none of this balance is spendable". On a pooled cross-collateral account (Kraken Futures' flex account) `free`/`locked` cannot express what the venue has committed, so `free - venueAvailable` is the only continuously-available signal that an account holds a position the engine is not tracking — which is otherwise invisible until an order is rejected.

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
