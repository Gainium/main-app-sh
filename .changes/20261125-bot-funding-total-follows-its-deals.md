---
bump: patch
section: Fixed
---
- A futures DCA or combo bot's funding total no longer counts a settlement again when a deal is restored from an older snapshot after a restart; the restored deal adopts its stored funding and the settlement cursor is now saved to the snapshot
