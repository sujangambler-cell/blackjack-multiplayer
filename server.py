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
import hashlib
import hmac
import time
from http import HTTPStatus
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PORT = int(os.environ.get("PORT", "8080"))
PUBLIC_DIR = pathlib.Path(__file__).parent / "public"
STARTING_MONEY = 5000
ZERO_CLAIM = 100
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ACCOUNTS_FILE = pathlib.Path(__file__).parent / "accounts.json"
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

# ---------------------------------------------------------------------------
# Simple account storage (intentionally lightweight for the current version)
# ---------------------------------------------------------------------------
ACCOUNTS: dict[str, dict] = {}
TOKENS: dict[str, str] = {}
ADMIN_SOCKETS = set()
BANNED_WORDS = {
    "fuck", "shit", "bitch", "asshole", "nigger", "nigga", "cunt",
    "dick", "pussy", "porn", "sex", "rape", "slut", "whore"
}

def load_accounts():
    global ACCOUNTS
    try:
        if ACCOUNTS_FILE.exists():
            ACCOUNTS = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        ACCOUNTS = {}

def save_accounts():
    try:
        tmp = ACCOUNTS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(ACCOUNTS, indent=2), encoding="utf-8")
        tmp.replace(ACCOUNTS_FILE)
    except Exception as exc:
        print("Could not save accounts:", exc)

def username_key(name):
    return (name or "").strip().lower()

def username_is_clean(name):
    key = username_key(name)
    return bool(key) and all(word not in key for word in BANNED_WORDS)

def hash_password(password, salt=None):
    salt = salt or os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 150_000).hex()
    return salt, digest

def verify_password(password, salt, digest):
    _, check = hash_password(password, salt)
    return hmac.compare_digest(check, digest)

def new_token():
    return os.urandom(24).hex()

load_accounts()

def get_room(code: str) -> dict:
    if code not in rooms:
        rooms[code] = {
            "code": code,
            "phase": "LOBBY",
            "players": [],
            "host_id": None,
            "kicked": [],
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


def delete_room_if_empty(room):
    """Remove an empty room completely so it cannot be rejoined accidentally."""
    if room and not room["players"] and rooms.get(room["code"]) is room:
        _cancel(room, "_ready_task")
        _cancel(room, "_round_task")
        rooms.pop(room["code"], None)
        return True
    return False

# ---------------------------------------------------------------------------
# Serialisation — what we send to clients
# ---------------------------------------------------------------------------
def public_dealer_hand(room):
    """Only expose the dealer hole card after it is face-up.
    Hidden card rank/suit are intentionally omitted from the JSON sent to clients.
    """
    out = []
    for c in room["dealer_hand"]:
        if c.get("faceUp"):
            out.append({"rank": c["rank"], "suit": c["suit"], "faceUp": True})
        else:
            out.append({"faceUp": False})
    return out


def serialise(room) -> dict:
    show_dealer = room["phase"] in ("PLAYING", "ROUND_OVER")
    dealer_hand = public_dealer_hand(room)
    return {
        "code": room["code"],
        "phase": room["phase"],
        "activePlayerId": room["active_player_id"],
        "hostId": room.get("host_id"),
        "dealerHand": dealer_hand,
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

def persist_player_money(player):
    account = ACCOUNTS.get(player.get("username_key"))
    if account is not None:
        account["money"] = max(0, int(player["money"]))
        save_accounts()

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
        persist_player_money(p)
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

    # Dealer blackjack ends the round immediately. Players with blackjack
    # are handled as a push in finish_round; everyone else loses immediately.
    if dealer_bj:
        await asyncio.sleep(0.35)
        await finish_round(room)
        return

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

        p["money"] = max(0, int(p["money"]))
        persist_player_money(p)
        p["status"] = "done"

        # pity system — 3 losses in a row → comeback bonus
        if p.get("consecutive_losses", 0) >= 3:
            p["money"] += 100
            p["pity_banner"] = True
            p["consecutive_losses"] = 0
            persist_player_money(p)

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

        # ---- account actions ----
        if kind == "signup":
            username = (msg.get("username") or "").strip()
            password = msg.get("password") or ""
            if not 3 <= len(username) <= 16:
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "Username must be 3–16 characters."}))
                continue
            if not username_is_clean(username):
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "That username isn't allowed. Please choose another."}))
                continue
            if len(password) < 8:
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "Password must be at least 8 characters."}))
                continue
            key = username_key(username)
            if key in ACCOUNTS:
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "That username is already taken."}))
                continue
            salt, digest = hash_password(password)
            ACCOUNTS[key] = {"username": username, "salt": salt, "password": digest, "money": STARTING_MONEY, "created": time.time()}
            save_accounts()
            token = new_token()
            TOKENS[token] = key
            await websocket.send(json.dumps({"type": "auth_ok", "mode": "signup", "username": username, "balance": STARTING_MONEY, "token": token}))
            continue

        if kind == "login":
            username = (msg.get("username") or "").strip()
            password = msg.get("password") or ""
            key = username_key(username)
            account = ACCOUNTS.get(key)
            if not account or not verify_password(password, account["salt"], account["password"]):
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "Incorrect username or password."}))
                continue
            token = new_token()
            TOKENS[token] = key
            await websocket.send(json.dumps({"type": "auth_ok", "mode": "login", "username": account["username"], "balance": account["money"], "token": token}))
            continue

        if kind == "join":
            token = msg.get("token")
            account_key = TOKENS.get(token)
            if not account_key or account_key not in ACCOUNTS:
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "Please log in first."}))
                continue
            code = (msg.get("room") or "PUBLIC").strip().upper()[:12] or "PUBLIC"
            room = get_room(code)
            if account_key in room.get("kicked", []):
                await websocket.send(json.dumps({"type": "error", "message": "You were kicked from this table. Create/use another table."}))
                room = None
                continue
            connected_count = sum(1 for p in room["players"] if p["connected"])
            if connected_count >= MAX_PLAYERS:
                await websocket.send(json.dumps({"type": "error", "message": "Table is full."}))
                room = None
                continue

            pid = new_id()
            account = ACCOUNTS[account_key]
            player = {
                "id": pid,
                "ws": websocket,
                "name": account["username"],
                "username": account["username"],
                "username_key": account_key,
                "money": int(account.get("money", STARTING_MONEY)),
                "bet": 0,
                "hand": [],
                "status": "betting" if room["phase"] in ("LOBBY", "BETTING") else "spectating",
                "result": None,
                "connected": True,
                "consecutive_losses": 0,
                "pity_banner": False,
                "double_used": False,
            }
            if room.get("host_id") is None:
                room["host_id"] = pid
            room["players"].append(player)
            if room["phase"] == "LOBBY":
                room["phase"] = "BETTING"

            await websocket.send(json.dumps({"type": "joined", "id": pid, "room": code, "username": account["username"], "balance": player["money"], "isHost": room["host_id"] == pid}))
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
            persist_player_money(player)
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

        elif kind == "claim_100":
            if player["money"] <= 0:
                player["money"] = ZERO_CLAIM
                player["bet"] = 0
                player["status"] = "betting"
                persist_player_money(player)
                await broadcast(room)

        elif kind == "refresh_balance":
            account = ACCOUNTS.get(player["username_key"])
            if account:
                player["money"] = int(account.get("money", 0))
                await websocket.send(json.dumps({"type": "balance", "balance": player["money"]}))
                await broadcast(room)

        elif kind == "kick":
            if room.get("host_id") != player["id"]:
                continue
            target_id = msg.get("targetId")
            target = find_player(room, target_id)
            if not target or target["id"] == player["id"]:
                continue
            if target.get("username_key"):
                room.setdefault("kicked", []).append(target["username_key"])
            target_ws = target.get("ws")
            try:
                if target_ws:
                    await target_ws.send(json.dumps({"type": "kicked", "message": "The host removed you from this table."}))
                    await target_ws.close()
            except Exception:
                pass

        elif kind == "admin_login":
            password = msg.get("password") or ""
            if ADMIN_PASSWORD and hmac.compare_digest(password, ADMIN_PASSWORD):
                await websocket.send(json.dumps({"type": "admin_ok"}))
                await websocket.send(json.dumps({"type": "admin_data", "users": [
                    {"username": a["username"], "money": int(a.get("money", 0))}
                    for a in ACCOUNTS.values()
                ]}))
            else:
                await websocket.send(json.dumps({"type": "error", "scope": "admin", "message": "Incorrect admin password."}))

        elif kind == "admin_data":
            # Kept as a refresh command; admin authentication is tied to this socket.
            pass

        elif kind == "admin_add_money":
            if not websocket in ADMIN_SOCKETS:
                continue
            key = username_key(msg.get("username"))
            amount = int(msg.get("amount", 0))
            if key in ACCOUNTS and 0 < amount <= 1_000_000:
                ACCOUNTS[key]["money"] = int(ACCOUNTS[key].get("money", 0)) + amount
                save_accounts()
                for r in rooms.values():
                    for p in r["players"]:
                        if p.get("username_key") == key:
                            p["money"] = ACCOUNTS[key]["money"]
                            await broadcast(r)
                await websocket.send(json.dumps({"type": "admin_data", "users": [
                    {"username": a["username"], "money": int(a.get("money", 0))}
                    for a in ACCOUNTS.values()
                ]}))

        elif kind == "admin_set_money":
            if not websocket in ADMIN_SOCKETS:
                continue
            key = username_key(msg.get("username"))
            amount = max(0, min(10_000_000, int(msg.get("amount", 0))))
            if key in ACCOUNTS:
                ACCOUNTS[key]["money"] = amount
                save_accounts()
                for r in rooms.values():
                    for p in r["players"]:
                        if p.get("username_key") == key:
                            p["money"] = amount
                            await broadcast(r)
                await websocket.send(json.dumps({"type": "admin_data", "users": [
                    {"username": a["username"], "money": int(a.get("money", 0))}
                    for a in ACCOUNTS.values()
                ]}))

        elif kind == "admin_reset_money":
            if not websocket in ADMIN_SOCKETS:
                continue
            key = username_key(msg.get("username"))
            if key in ACCOUNTS:
                ACCOUNTS[key]["money"] = STARTING_MONEY
                save_accounts()
                for r in rooms.values():
                    for p in r["players"]:
                        if p.get("username_key") == key:
                            p["money"] = STARTING_MONEY
                            await broadcast(r)
                await websocket.send(json.dumps({"type": "admin_data", "users": [
                    {"username": a["username"], "money": int(a.get("money", 0))}
                    for a in ACCOUNTS.values()
                ]}))

    # ---- disconnection / leave ----
    # A player who leaves is removed completely from the room. If they were
    # the last player, the room itself is destroyed and must be created again.
    if player and room:
        was_active = room["active_player_id"] == player["id"]
        try:
            room["players"].remove(player)
        except ValueError:
            pass

        if not room["players"]:
            _cancel(room, "_ready_task")
            _cancel(room, "_round_task")
            rooms.pop(room["code"], None)
        else:
            if was_active:
                room["active_player_id"] = None
                await move_to_next_or_dealer(room)
            await broadcast(room)

    ADMIN_SOCKETS.discard(websocket)

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
