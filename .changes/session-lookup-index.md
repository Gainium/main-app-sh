---
bump: patch
section: Changed
---
- Signed-in requests find their account through a database index on the session token; the index is created on the users collection at the next start
