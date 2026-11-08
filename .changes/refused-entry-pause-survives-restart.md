---
bump: patch
section: Fixed
---
- A pair paused after the exchange kept cancelling its base orders unfilled now stays paused across a bot restart without warning again, and an ASAP bot retries it by itself when the pause ends
