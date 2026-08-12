"""
Blackjack multiplayer server — Python edition
Requires: pip install websockets

Run: python server.py
Then open http://localhost:8080 in your browser.
Friends on the same WiFi: http://<your-LAN-ip>:8080
Press Ctrl+C to stop.
"""

import asyncio
import json
import mimetypes
import os
import pathlib
import random
import string
from http import HTTPStatus
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PORT = int(os.environ.get("PORT", "8080"))
PUBLIC_DIR = pathlib.Path(__file__).parent / "public"
STARTING_MONEY = 1000
MAX_PLAYERS = 5
READY_GRACE_S = 0.8      # small pause after last player hits ready before dealing
ROUND_OVER_S = 4.5       # results screen duration before next betting phase

# ---------------------------------------------------------------------------
# Cards / deck
# ---------------------------------------------------------------------------
SUITS = ["S", "H", "D", "C"]
RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]

def fresh_shoe():
    cards = [{"rank": r, "suit": s} for _ in range(4) for s in SUITS for r in RANKS]
    random.shuffle(cards)
    return cards

def card_value(rank):
    if rank == "A":   return 11
    if rank in ("J", "Q", "K"): return 10
    return int(rank)

def hand_value(cards):
    total = aces = 0
    for c in cards:
        if not c.get("faceUp"): continue
        total += card_value(c["rank"])
        if c["rank"] == "A": aces += 1
    while total > 21 and aces:
        total -= 10
        aces -= 1
    return total

def hand_display(cards):
    face = [c for c in cards if c.get("faceUp")]
    # low total: all aces = 1
    low = sum(1 if c["rank"] == "A" else card_value(c["rank"]) for c in face)
    high = low + 10  # promote one ace from 1 -> 11
    aces = sum(1 for c in face if c["rank"] == "A")
    is_soft = aces > 0 and high <= 21
    if is_soft:
        return f"{low}/{high}"
    return str(low)

def is_blackjack(cards):
    return len(cards) == 2 and hand_value(cards) == 21

# ---------------------------------------------------------------------------
# Room state
# ---------------------------------------------------------------------------
_next_id = 0
def new_id():
    global _next_id
    _next_id += 1
    return f"p{_next_id}"

rooms: dict[str, dict] = {}

def get_room(code: str) -> dict:
    if code not in rooms:
        rooms[code] = {
            "code": code,
            "phase": "LOBBY",
            "players": [],
            "deck": fresh_shoe(),
            "dealer_hand": [],
            "active_player_id": None,
            # asyncio task handles for cancellation
            "_ready_task": None,
            "_round_task": None,
        }
    return rooms[code]

def draw_card(room):
    if len(room["deck"]) < 20:
        room["deck"] = fresh_shoe()
    return room["deck"].pop()

def active_players(room):
    return [p for p in room["players"] if p["connected"]]

def find_player(room, pid):
    return next((p for p in room["players"] if p["id"] == pid), None)

# ---------------------------------------------------------------------------
# Serialisation — what we send to clients
# ---------------------------------------------------------------------------
def serialise(room) -> dict:
    show_dealer = room["phase"] in ("PLAYING", "ROUND_OVER")
    return {
        "code": room["code"],
        "phase": room["phase"],
        "activePlayerId": room["active_player_id"],
        "dealerHand": room["dealer_hand"],
        "dealerDisplay": hand_display(room["dealer_hand"]) if show_dealer and room["dealer_hand"] else None,
        "players": [
            {
                "id":        p["id"],
                "name":      p["name"],
                "money":     p["money"],
                "bet":       p["bet"],
                "hand":      p["hand"],
                "display":   hand_display(p["hand"]) if p["hand"] else None,
                "status":    p["status"],
                "result":    p["result"],
                "connected": p["connected"],
                "pity":      p.get("pity_banner", False),
            }
            for p in room["players"]
        ],
    }

async def broadcast(room):
    payload = json.dumps({"type": "state", "state": serialise(room)})
    for p in room["players"]:
        ws = p.get("ws")
        if ws is not None:
            try:
                await ws.send(payload)
            except Exception:
                pass

# ---------------------------------------------------------------------------
# Game flow
# ---------------------------------------------------------------------------
async def reset_for_betting(room):
    room["phase"] = "BETTING"
    room["dealer_hand"] = []
    room["active_player_id"] = None
    for p in room["players"]:
        p["hand"] = []
        p["bet"] = 0
        p["status"] = "betting"
        p["result"] = None
        p["pity_banner"] = False
        p["double_used"] = False
    await broadcast(room)

def _cancel(room, key):
    task = room.get(key)
    if task and not task.done():
        task.cancel()
    room[key] = None

async def maybe_start_round(room):
    eligible = [p for p in active_players(room) if p["money"] > 0]
    if not eligible:
        return
    if all(p["status"] == "ready" for p in eligible):
        _cancel(room, "_ready_task")
        room["_ready_task"] = asyncio.create_task(_delayed_deal(room))

async def _delayed_deal(room):
    await asyncio.sleep(READY_GRACE_S)
    await deal_round(room)

async def deal_round(room):
    if room["phase"] != "BETTING":
        return
    players = [p for p in active_players(room) if p["status"] == "ready" and p["bet"] > 0]
    if not players:
        return

    room["phase"] = "PLAYING"
    room["dealer_hand"] = []
    for p in players:
        p["hand"] = []

    # standard deal order: each player gets one card, dealer gets one face-up,
    # each player gets a second card, dealer gets one face-down
    for round_num in range(2):
        for p in players:
            card = draw_card(room)
            card["faceUp"] = True
            p["hand"].append(card)
        dealer_card = draw_card(room)
        dealer_card["faceUp"] = (round_num == 0)
        room["dealer_hand"].append(dealer_card)

    for p in room["players"]:
        if p not in players:
            p["status"] = "spectating"
            continue
        p["money"] -= p["bet"]   # ante up
        p["double_used"] = False
        p["status"] = "blackjack" if is_blackjack(p["hand"]) else "playing"

    await advance_turn(room, first=True)
    await broadcast(room)

async def advance_turn(room, first=False):
    playable = [p for p in active_players(room) if p["status"] == "playing"]
    if not playable:
        room["active_player_id"] = None
        asyncio.create_task(dealer_play(room))
        return
    if first:
        room["active_player_id"] = playable[0]["id"]
    else:
        idx = next((i for i, p in enumerate(playable) if p["id"] == room["active_player_id"]), -1)
        nxt = playable[idx + 1] if idx + 1 < len(playable) else None
        if nxt:
            room["active_player_id"] = nxt["id"]
        else:
            room["active_player_id"] = None
            asyncio.create_task(dealer_play(room))

async def move_to_next_or_dealer(room):
    still_playing = [p for p in active_players(room) if p["status"] == "playing"]
    if not still_playing:
        room["active_player_id"] = None
        asyncio.create_task(dealer_play(room))
    else:
        room["active_player_id"] = still_playing[0]["id"]

async def dealer_play(room):
    # reveal hole card
    for c in room["dealer_hand"]:
        c["faceUp"] = True
    await broadcast(room)

    contenders = [p for p in active_players(room)
                  if p["status"] in ("playing", "stood", "blackjack", "bust")]
    if not contenders:
        await finish_round(room)
        return

    dealer_bj = is_blackjack(room["dealer_hand"])
    everyone_bj_no_dealer = all(p["status"] == "blackjack" for p in contenders) and not dealer_bj

    while not dealer_bj and not everyone_bj_no_dealer and hand_value(room["dealer_hand"]) < 17:
        await asyncio.sleep(0.65)
        card = draw_card(room)
        card["faceUp"] = True
        room["dealer_hand"].append(card)
        await broadcast(room)

    await asyncio.sleep(0.4)
    await finish_round(room)

async def finish_round(room):
    dv = hand_value(room["dealer_hand"])
    dealer_bj = is_blackjack(room["dealer_hand"])

    for p in active_players(room):
        if not p["hand"] or p["status"] == "spectating":
            continue
        if p["status"] == "bust":
            p["result"] = "bust"
            p["consecutive_losses"] = p.get("consecutive_losses", 0) + 1
        elif p["status"] == "blackjack":
            if dealer_bj:
                p["money"] += p["bet"]      # push
                p["result"] = "push"
                p["consecutive_losses"] = 0
            else:
                p["money"] += round(p["bet"] * 2.5)  # 3:2
                p["result"] = "blackjack"
                p["consecutive_losses"] = 0
        else:
            pv = hand_value(p["hand"])
            if dealer_bj:
                p["result"] = "lose"
                p["consecutive_losses"] = p.get("consecutive_losses", 0) + 1
            elif dv > 21 or dv < pv:
                p["money"] += p["bet"] * 2
                p["result"] = "win"
                p["consecutive_losses"] = 0
            elif dv > pv:
                p["result"] = "lose"
                p["consecutive_losses"] = p.get("consecutive_losses", 0) + 1
            else:
                p["money"] += p["bet"]      # push
                p["result"] = "push"
                p["consecutive_losses"] = 0

        p["status"] = "done"

        # pity system — 3 losses in a row → comeback bonus
        if p.get("consecutive_losses", 0) >= 3:
            p["money"] += 100
            p["pity_banner"] = True
            p["consecutive_losses"] = 0

    room["phase"] = "ROUND_OVER"
    room["active_player_id"] = None
    await broadcast(room)

    await asyncio.sleep(ROUND_OVER_S)
    await reset_for_betting(room)

# ---------------------------------------------------------------------------
# WebSocket handler
# ---------------------------------------------------------------------------
async def ws_handler(websocket):
    room = None
    player = None

    async for raw in websocket:
        try:
            msg = json.loads(raw)
        except Exception:
            continue

        kind = msg.get("type")

        # ---- join ----
        if kind == "join":
            code = (msg.get("room") or "PUBLIC").strip().upper()[:12] or "PUBLIC"
            room = get_room(code)
            connected_count = sum(1 for p in room["players"] if p["connected"])
            if connected_count >= MAX_PLAYERS and not find_player(room, "?"):
                await websocket.send(json.dumps({"type": "error", "message": "Table is full."}))
                return

            pid = new_id()
            player = {
                "id": pid,
                "ws": websocket,
                "name": (msg.get("name") or "Player")[:16],
                "money": STARTING_MONEY,
                "bet": 0,
                "hand": [],
                "status": "betting" if room["phase"] in ("LOBBY", "BETTING") else "spectating",
                "result": None,
                "connected": True,
                "consecutive_losses": 0,
                "pity_banner": False,
                "double_used": False,
            }
            room["players"].append(player)
            if room["phase"] == "LOBBY":
                room["phase"] = "BETTING"

            await websocket.send(json.dumps({"type": "joined", "id": pid, "room": code}))
            await broadcast(room)
            continue

        if room is None or player is None:
            continue

        # ---- betting actions ----
        if kind == "chip":
            if player["status"] not in ("betting", "ready"): continue
            amt = int(msg.get("amount", 0))
            player["bet"] = min(player["money"], player["bet"] + amt)
            player["status"] = "betting"
            await broadcast(room)

        elif kind == "clear_bet":
            if player["status"] not in ("betting", "ready"): continue
            player["bet"] = 0
            player["status"] = "betting"
            await broadcast(room)

        elif kind == "all_in":
            if player["status"] not in ("betting", "ready"): continue
            player["bet"] = player["money"]
            player["status"] = "betting"
            await broadcast(room)

        elif kind == "ready":
            if room["phase"] != "BETTING": continue
            if player["bet"] <= 0 or player["bet"] > player["money"]: continue
            player["status"] = "ready"
            await broadcast(room)
            await maybe_start_round(room)

        # ---- play actions ----
        elif kind == "hit":
            if room["phase"] != "PLAYING" or room["active_player_id"] != player["id"]: continue
            card = draw_card(room)
            card["faceUp"] = True
            player["hand"].append(card)
            if hand_value(player["hand"]) > 21:
                player["status"] = "bust"
                player["result"] = "bust"
                await move_to_next_or_dealer(room)
            await broadcast(room)

        elif kind == "stand":
            if room["phase"] != "PLAYING" or room["active_player_id"] != player["id"]: continue
            player["status"] = "stood"
            await move_to_next_or_dealer(room)
            await broadcast(room)

        elif kind == "double":
            if room["phase"] != "PLAYING" or room["active_player_id"] != player["id"]: continue
            if player["double_used"] or len(player["hand"]) != 2 or player["money"] < player["bet"]: continue
            player["money"] -= player["bet"]
            player["bet"] *= 2
            player["double_used"] = True
            card = draw_card(room)
            card["faceUp"] = True
            player["hand"].append(card)
            if hand_value(player["hand"]) > 21:
                player["status"] = "bust"
                player["result"] = "bust"
            else:
                player["status"] = "stood"
            await move_to_next_or_dealer(room)
            await broadcast(room)

    # ---- disconnection ----
    if player:
        player["connected"] = False
        player["ws"] = None
        if room and room["active_player_id"] == player["id"]:
            player["status"] = "stood"
            await move_to_next_or_dealer(room)
        if room:
            await broadcast(room)

# ---------------------------------------------------------------------------
# Combined HTTP + WebSocket server
# ---------------------------------------------------------------------------
# Render and most cloud hosts expose only ONE public port. The same port can
# serve the website over HTTP(S) and upgrade WebSocket requests for multiplayer.

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

async def process_http_request(connection, request):
    """Serve normal browser requests while leaving WebSocket upgrades alone."""
    if request.path == "/health":
        body = b"ok"
        return Response(200, "OK", Headers({
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": str(len(body)),
        }), body)

    # Never intercept a WebSocket handshake. Returning None lets websockets
    # continue with the normal upgrade process.
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None

    path = request.path.split("?", 1)[0]
    if path == "/":
        path = "/index.html"

    # Prevent path traversal outside public/.
    try:
        requested = (PUBLIC_DIR / path.lstrip("/" )).resolve()
        public_root = PUBLIC_DIR.resolve()
        requested.relative_to(public_root)
    except ValueError:
        return Response(403, "Forbidden", Headers({"Content-Type": "text/plain"}), b"Forbidden")

    if not requested.is_file():
        return Response(404, "Not Found", Headers({"Content-Type": "text/plain"}), b"Not Found")

    body = requested.read_bytes()
    content_type = CONTENT_TYPES.get(requested.suffix.lower(), "application/octet-stream")
    return Response(200, "OK", Headers({
        "Content-Type": content_type,
        "Content-Length": str(len(body)),
        "Cache-Control": "no-cache",
    }), body)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
async def main():
    print("Blackjack running!")
    print(f"  Open locally --> http://localhost:{PORT}")
    print(f"  Listening on 0.0.0.0:{PORT}")
    print("  HTTP and WebSocket multiplayer share the same port.")
    print("Press Ctrl+C to stop.\n")

    async with serve(
        ws_handler,
        "0.0.0.0",
        PORT,
        process_request=process_http_request,
        ping_interval=20,
        ping_timeout=20,
    ) as server:
        await server.serve_forever()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
