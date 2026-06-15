# Changelog

## [1.20.0] - 2026-06-15

### Changed
- Bybit exchange account stores a free-text domain instead of a fixed zone; `bybitHost` GraphQL field is now `String` (the `BybitHost` enum was removed) and the DB field is no longer enum-restricted.

### Added
- Migration v43: convert existing Bybit account zone codes (`eu`/`com`/…) to bare domains (`bybit.eu`/`bybit.com`/…).

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
