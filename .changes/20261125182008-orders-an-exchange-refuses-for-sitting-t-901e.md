---
bump: minor
section: Fixed
---
- Orders an exchange refuses for sitting too far from the price are held without being sent again once the exchange's price band is known (it is kept across restarts), and each deal publishes them as heldOrders so the chart can show where they will rest.
