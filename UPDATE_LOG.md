# CASINO X — V26.2.1 MOBILE + RENDER FIX

## Root cause: Store / Casino mobile CSS was corrupted
- The trailing "V6 WEALTH / FLEX SYSTEM" block in `public/style.css` contained **literal `\n` sequences** instead of real newlines.
- Large sections of Store 3.x, VIP, purchase overlay, casino room, and mobile overrides were therefore not applied correctly by the browser.
- That block has been expanded into valid CSS.

## Mobile Mode layout (Store + Personal Casino)
Mobile Mode uses `html[data-mobile="1"]` with a ~430px app column **inside a desktop viewport**.
`@media (max-width: …)` alone does **not** run in that situation.

### Store (mobile)
- Full-width phone shell (no half-screen desktop sidebar)
- Category nav becomes a compact **horizontal scroll rail**
- Side promo ("HIGH ROLLER?") hidden on mobile
- Hero banner stacks and fits the phone width
- Product grid forced to **2 columns**, `min-width: 0`, no horizontal page scroll
- Product names wrap; BUY buttons stay inside cards
- VIP membership card is a single-column, content-sized card (no giant clipped block)
- Footer is compact; note text hidden; CLOSE STORE full-width
- Content scrolls inside the store shell; safe-area padding supported

### Personal Casino (mobile)
- Full-screen property shell
- Room uses aspect-ratio + viewport-based sizing instead of fixed desktop dimensions
- Window, skyline, table, furniture, plants kept readable with percentage positioning
- Close / Edit controls remain accessible
- No horizontal overflow

### Narrow real phones
Matching `@media (max-width: 700px)` rules mirror the data-mobile layout for real mobile viewports.

## Server / Render
- `python -m py_compile server.py` passes
- HTTP `/` and `/health` serve successfully
- WebSocket handshake initializes
- Developer settings save logs write failures instead of failing silently
- WebSocket upgrade header read is more defensive
- `requirements.txt` allows `websockets>=14,<18` for broader Render compatibility
- Existing accounts, inventory, VIP, multiplayer, and Developer Controls preserved

## Validation
- Python compile: passed
- JavaScript syntax (`node --check public/game.js`): passed
- HTML IDs unique: passed
- Server start + `/` 200 + `/health` ok + WebSocket connect: passed

## V26.2.1 — Render HTTP 503 fix
- Root cause: when `DATABASE_URL` was set but Postgres was unreachable, `load_accounts()` raised and the process never bound the port → Render returned **HTTP 503**.
- Fix: fall back to local JSON storage with a clear warning instead of crashing.
- Added short Postgres connect retries and a `DB_ACTIVE` flag so season/save paths do not keep hitting a dead DB after fallback.
