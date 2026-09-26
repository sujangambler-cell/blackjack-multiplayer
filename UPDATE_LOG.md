# CASINO X — V26.2 VISUAL FIX

## Store 3.1 — rebuilt to the reference direction
- The Store is now a proper premium showroom rather than a small generic overlay.
- Desktop uses a left navigation rail, large hero banner, large product art and clean product cards.
- Mobile Mode uses a compact horizontal category rail and a two-column catalogue designed to avoid overflow.
- Product cards keep the price hidden; tapping BUY opens the purchase screen with price, rarity and a large in-game preview.
- VIP stays as a dedicated high-value in-game-chip deal.

## Private Casino 2.0 — rebuilt as a real room
- Replaced the small “starter showcase” presentation with a large room scene.
- Added a glass window wall with a night skyline and individual illuminated buildings outside.
- Added interior ceiling glow, art-deco Casino X sign, sofas, plants, coffee table, rug and a large casino table.
- The equipped room/floor/wall/feature still controls the cosmetic state and feature prop.
- Mobile Mode uses the full screen for the property and keeps the main room objects large/readable.

## Developer Controls
- Existing Store item editing and VIP pricing controls remain.
- Added more standard UI targets for common Store/table/mobile controls.
- Added safe custom #id/.class positioning with separate PC/Mobile X, Y and scale.
- Added local PREVIEW and server-side SAVE for custom positions.
- RESET ALL UI clears both standard and custom positioning.

## Compatibility / validation
- Existing accounts, balances, inventories and VIP data are preserved.
- HTML ID uniqueness check: passed.
- Python compile check: passed.
- JavaScript syntax check: passed.
- Store/casino server smoke test: passed.
- No Blackjack/Poker gameplay logic was intentionally changed in this visual update.
