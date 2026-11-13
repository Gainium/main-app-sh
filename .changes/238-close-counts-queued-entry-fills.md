---
bump: patch
section: Fixed
---
- A DCA take-profit that closed the whole position while several safety-order fills from the same exchange message were still being booked no longer sends market orders to "close the rest" of those fills, and the closed deal books them at their own fill price
