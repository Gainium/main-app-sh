---
bump: patch
section: Fixed
---
- A DCA or Combo safety order the exchange refuses for insufficient balance is placed again as a limit at its level's price, backing off from 5 to 60 minutes; after 24 hours of refusals the level is listed under the deal's skipped DCA levels and the user is told why. Previously the level stayed missing until the bot was restarted.
