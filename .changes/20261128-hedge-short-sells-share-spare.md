---
bump: patch
section: Fixed
---
- A spot hedge DCA bot's short side no longer sells, across several sells placed together (a deal's base and safety orders), the coins its long side holds for its take profit: each sell is checked against what is left after the sells already accepted
