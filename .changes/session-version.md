---
bump: patch
section: Added
---
- Each account now has a session version that every new session is issued at. Changing the password, "Log out all other sessions" and the password reset command raise it, so sessions issued earlier are no longer accepted; the session that made the change stays signed in. Existing sessions are unaffected until one of those actions is taken
