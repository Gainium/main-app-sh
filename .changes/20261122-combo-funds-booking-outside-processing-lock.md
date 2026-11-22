---
bump: patch
section: Fixed
---
- Combo: an add / reduce funds fill is booked after the per-deal processing lock is released, so a fill handler that re-enters processing through its cancel loop can no longer stop the deal; the per-deal lock is exported for subclasses that override a locked method
