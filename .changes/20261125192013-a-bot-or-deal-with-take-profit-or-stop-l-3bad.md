---
bump: patch
section: Fixed
---
- A bot or deal with take profit or stop loss on but no saved close condition now places its take profit and arms its stop loss, as the dashboard shows (a stop loss already passed when it is first armed waits for the price to return to the safe side, and that arming survives a restart); new bots are saved with the condition
