---
bump: patch
section: Fixed
---
- Deleting a DCA or combo bot is now refused while any of its deals is still open or starting, even when no worker has the bot loaded, and the scheduled purge of deleted bots skips a bot whose deals are still open and removes exactly the bots it read instead of re-running its filter
