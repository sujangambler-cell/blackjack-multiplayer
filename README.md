# Multiplayer Blackjack

Python + WebSocket multiplayer Blackjack game.

## Local testing

1. Install dependencies:
   `pip install -r requirements.txt`
2. Optional admin password:
   - Linux/macOS: `ADMIN_PASSWORD='your-password' python server.py`
   - Windows PowerShell: `$env:ADMIN_PASSWORD='your-password'; python server.py`
3. Open `http://localhost:8080`.

## Current update

- Login now leads to a persistent Main Menu.
- Leaving a table returns to Main Menu without logging out.
- Settings include GUI scale, theme, sound toggle and SFX volume.
- Premium animated space/casino backgrounds are rendered locally in the browser, including floating cards, casino chips, money and stars on the account/menu screens.
- Admin authentication is server-side and is accessed from Settings → ADMIN; the password dialog opens above Settings and the dashboard appears after successful authentication.
- Admin panel supports table-player money grants, per-player Lucky Mode and protected Dealer Preview.
- Dealer Preview data is never included in normal player state messages.
- Additional synthesized game/UI sound effects are included without external audio assets.

Do not commit `ADMIN_PASSWORD` to source code; configure it as an environment variable in deployment.


## Persistent production storage

Casino X now uses PostgreSQL when the `DATABASE_URL` environment variable is
configured. This is the recommended Render deployment configuration.

The current version previously stored accounts in `accounts.json`, not SQLite.
When PostgreSQL is configured and the database has no accounts yet, the server
automatically imports the existing `accounts.json` once.

### Render setup

1. Create a PostgreSQL database in Render.
2. Open the Casino X web service's Environment settings.
3. Add/link `DATABASE_URL` to the PostgreSQL database's internal connection URL.
4. Redeploy the web service.
5. Verify that login, balance, store purchases, XP, achievements, daily rewards,
   and Season 1 progress survive a service restart.

If `DATABASE_URL` is not set, local development continues to use `accounts.json`.
If `DATABASE_URL` is set but PostgreSQL is unavailable, the server intentionally
fails to start rather than silently reverting to ephemeral file storage.

### Important fixes in this release

- Fixed Store purchases for regular paid themes/chips being incorrectly rejected.
- Prevented the same account from occupying multiple active table seats.
- Added PostgreSQL persistence with automatic first-run migration from accounts.json.
