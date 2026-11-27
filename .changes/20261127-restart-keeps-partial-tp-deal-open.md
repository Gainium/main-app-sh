---
bump: patch
section: Fixed
---
- A DCA deal kept open after its take profit sold only part of the position, because the sale of the rest was refused, is no longer closed by a bot restart
- When a deal does close with coins left unsold, its profit no longer counts those coins as sold at the take-profit price
