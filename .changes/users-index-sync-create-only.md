---
bump: patch
section: Changed
---
- Start-up index maintenance on the users collection only creates missing indexes and no longer removes ones the core schema does not declare; a failed index build is logged and no longer stops the remaining collections from being checked
