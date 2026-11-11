---
bump: patch
section: Added
---
- A session is now stored with a SHA-256 of its token and found by that hash, or by the stored token for sessions created before this release. An index for the hash lookup is created on the users collection at the next start
