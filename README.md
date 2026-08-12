# Blackjack — public multiplayer web edition

A real-time multiplayer Blackjack table for up to 5 players. The website and WebSocket multiplayer server now share **one port**, which makes the project compatible with public cloud hosts such as Render.

## Run locally

```bash
pip install -r requirements.txt
python server.py
```

Open `http://localhost:8080`. The port can be changed with the `PORT` environment variable.

## Deploy publicly on Render

1. Put the contents of this folder in a GitHub repository.
2. In Render, create a **Web Service** and connect that repository.
3. Build Command: `pip install -r requirements.txt`
4. Start Command: `python server.py`
5. Render supplies the `PORT` environment variable automatically.
6. Deploy. Render will give you an `https://...onrender.com` URL.

The browser automatically uses `wss://` for the multiplayer connection when the public site uses HTTPS.

## Game rules

- Enter a name and a table code, then sit down.
- Up to 5 players can share a table.
- Build a bet and press READY.
- HIT / STAND / DOUBLE appear on the active player's turn.
- Dealer plays automatically after all players act.
- Blackjack pays 3:2.
- Dealer stands on soft 17.
