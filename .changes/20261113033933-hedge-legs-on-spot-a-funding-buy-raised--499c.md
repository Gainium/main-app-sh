---
bump: patch
section: Fixed
---
- Hedge legs on spot: a funding buy raised to the exchange minimum is judged against what the safety orders need, so a slightly short market fill no longer cancels the deal and strands the bought coins
