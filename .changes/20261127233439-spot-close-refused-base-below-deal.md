---
bump: patch
section: Fixed
---
- A long spot deal whose take profit was refused because the account holds less of the coin than the deal still has to sell is now booked closed from the account's outside fills, or paused with one warning, instead of being refused forever
