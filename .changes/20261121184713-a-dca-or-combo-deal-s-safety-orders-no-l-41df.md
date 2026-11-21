---
bump: patch
section: Fixed
---
- A DCA or Combo deal's safety orders no longer take their price as their quantity after the exchange lowers a pair's quantity precision; a Combo deal restored with such orders recalculates them, tells the user, and never sends a safety order far outside its level budget
