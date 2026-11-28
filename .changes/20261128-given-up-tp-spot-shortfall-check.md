---
bump: patch
section: Fixed
---
- A long spot DCA deal whose take profit the bot stopped re-sending is now checked against the account's balance of its coin. When the account holds less than the deal, the deal is held, and its take profit is placed again automatically as soon as the account holds the deal's amount. Before, it stayed without a take profit until the next worker restart.
- On a spot hedge bot, that hold message now names the hedge's own short side as a place the coins can have gone, and says how many coins the deal is short.
