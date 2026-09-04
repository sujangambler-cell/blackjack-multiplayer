# Casino X

## Persistent production storage

Casino X uses PostgreSQL when the `DATABASE_URL` environment variable is configured.
For local development, when `DATABASE_URL` is absent, it continues to use `accounts.json`.

### Render deployment

1. Create a Render PostgreSQL database.
2. In the Casino X Web Service, open **Environment**.
3. Add the environment variable `DATABASE_URL` using the PostgreSQL database's **Internal Database URL**.
4. Deploy this version.

On first startup, if PostgreSQL has no accounts, the server imports the existing `accounts.json` accounts and initializes any newer progression fields. Existing session tokens are invalidated during migration so players simply log in again.

If `DATABASE_URL` is configured but PostgreSQL cannot be reached, the server intentionally fails startup instead of silently using ephemeral file storage.

## Included fixes

- Fixed PostgreSQL startup ordering (prevents `ensure_account_progress` NameError).
- Added PostgreSQL persistence with automatic one-time migration from `accounts.json`.
- Fixed paid Store item purchase validation.
- Prevented one account from occupying multiple active table seats.
- Kept local `accounts.json` fallback for development only.

### UI / Lobby / Host fixes (this build)

- **Lobby leave**: leave + disconnect fully remove the player, refund pending roulette bets, transfer host, and broadcast immediately (no ghost players).
- **Table size**: create table can choose **2–10 players** (server stores per-room `max_players`).
- **Blackjack shoe**: always visible with higher z-index; scales on desktop.
- **Mobile mode default ON** (user can switch to PC mode in Settings). Larger touch targets, centered seats.
- **Dark mode chips**: no longer forced pure white; skin colors (gold, 1927, silver) remain visible.
- **Host Panel**: Kick + **Transfer Host** + **Double Cash** toggle (applies 2× to Blackjack and Roulette payouts; visible banner on table).
- **Visual quality slider** (Low / Medium / High) with live particle/effect reduction.
- Seasonal 1927 theme and shop equip path preserved and compatible with dark mode.


## Universal Casino X systems

The player wallet, XP/levels, Season 1 progression, inventory/cosmetics, Store and Profile are shared across all games. Blackjack and Roulette write to the same account and progression records. Store items are tagged with a scope (`GLOBAL`, `BLACKJACK`, or `ROULETTE`) so future games can be added without duplicating the economy.

Roulette is a server-authoritative European wheel (0–36) with red/black, odd/even, low/high, dozens and straight-number bets. The host controls the spin; bets are deducted server-side and winnings are returned server-side.


## Casino X quality/security updates

- Store ownership/equipment is server-authoritative and persisted with the existing account/PostgreSQL JSONB data.
- Appearance is available from Settings and only owned cosmetics can be equipped.
- Limited Season 1 rewards are permanent after acquisition; the catalog does not delete ownership at season rollover.
- Admin access is only exposed inside an authenticated game table and server authorization is required for admin actions.
- Public tables are shown directly in each Join/Create lobby and refreshed through WebSocket updates.
- Roulette uses a server-selected European 0–36 result; the client animation receives that result and animates toward it.
- Roulette validates bet type, number, amount, balance, phase, and limits server-side and clears settled wagers before the result phase can refund them.
- Admin Roulette luck is bounded and server-side, with temporary table luck and per-player luck controls.
- Season XP is shared across Blackjack and Roulette through the existing account progression state.
- Responsive layouts were added for Appearance, Admin, Season, and Roulette.


## Season 1
**Casino X: 1927** runs for 21 days from first production initialization. The start time is persisted in PostgreSQL `app_settings`, so restarts do not reset the countdown. Seasonal cosmetics remain permanently owned after the acquisition window closes.

### Final UI pass (Update Log 1)

- Contained **CASINO X** logo glow so it no longer leaks across the lobby; mobile title scales and stays fully visible.
- **Update Log** notebook button (top-right of main menu). Opens once after login/signup per player when the log version changes; version badge = Update Log 1 (bump `UPDATE_LOG_VERSION` in `game.js` for future releases).
- **Season 1 · 1927** pass restyle: art-deco rail, gold progress, single-column tiers; unclaimed tier unlocks slide in from the right (“You reached level X — claim it in the main menu”).
- Side notification stack + invite toast layouts adjusted for phone so they fit cleanly.
- Blackjack felt/seats given more vertical room and a wider arc so the table no longer feels squashed.
