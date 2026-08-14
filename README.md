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
