---
bump: patch
section: Fixed
---
- A futures DCA bot opening several deals at once now checks each new deal against the margin the earlier deals of the same burst already need, so deals the account can no longer fund get the usual "not enough balance" warning instead of being sent to the exchange and refused
