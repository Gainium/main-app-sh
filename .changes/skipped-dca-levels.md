---
bump: minor
section: Added
---
- DCA deals now record the ladder levels the price moved past before they could be placed. The bot never buys them at market by itself; each one can be executed from the deal, and "Execute next DCA" no longer re-executes a level that already filled.
