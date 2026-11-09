---
bump: patch
section: Fixed
---
- DCA: a ladder whose step shrinks below one price tick (step scale under 1 over many levels) no longer stops placing its safety orders after the market gaps through its last levels; a moved level may now sit past the ladder's computed depth by up to a tenth of that depth, while a flash wick far beyond the ladder is still refused.
