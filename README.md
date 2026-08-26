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
