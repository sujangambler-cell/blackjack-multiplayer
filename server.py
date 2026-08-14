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
ADMIN_EVENTS = {"double_xp": False, "bonus_cash": False}
USER_SOCKETS = {}
BANNED_WORDS = {
    "fuck", "shit", "bitch", "asshole", "nigger", "nigga", "cunt",
    "dick", "pussy", "porn", "sex", "rape", "slut", "whore"
}

def load_accounts():
    global ACCOUNTS, TOKENS
    try:
        if ACCOUNTS_FILE.exists():
            ACCOUNTS = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
            TOKENS = {}
            for key, account in ACCOUNTS.items():
                tok = account.get("session_token")
                if tok:
                    TOKENS[tok] = key
    except Exception:
        ACCOUNTS = {}
        TOKENS = {}

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

# ---------------------------------------------------------------------------
# Progression / daily systems
# ---------------------------------------------------------------------------
ACHIEVEMENT_DEFS = {
    "first_blackjack": {"title": "FIRST BLACKJACK", "desc": "Get your first Blackjack.", "icon": "🃏"},
    "five_streak": {"title": "ON FIRE", "desc": "Reach a 5-win streak.", "icon": "🔥"},
    "ten_blackjacks": {"title": "BLACKJACK HUNTER", "desc": "Get 10 Blackjacks.", "icon": "♠"},
    "ten_k": {"title": "10K CLUB", "desc": "Reach 10,000 chips.", "icon": "💰"},
    "fifty_k": {"title": "HIGH ROLLER", "desc": "Reach 50,000 chips.", "icon": "👑"},
    "hundred_wins": {"title": "CENTURY", "desc": "Win 100 hands.", "icon": "🏆"},
}
LEVELS = [
    (0, "Rookie"), (100, "Card Shark"), (500, "High Roller"),
    (1500, "Blackjack Master"), (4000, "Casino Legend"),
]

def ensure_account_progress(account):
    defaults = {
        "money": STARTING_MONEY, "games_played": 0, "wins": 0, "losses": 0,
        "pushes": 0, "blackjacks": 0, "best_win_streak": 0, "current_win_streak": 0,
        "biggest_win": 0, "xp": 0, "achievements": [], "daily_claim": "",
        "daily_challenges": {}, "daily_challenge_date": "", "daily_challenge_claimed": [],
        "friends": [], "friend_requests": [], "session_token": account.get("session_token"),
    }
    changed = False
    for k, v in defaults.items():
        if k not in account:
            account[k] = v
            changed = True
    if changed:
        save_accounts()
    return account

def account_level(xp):
    level = 1
    title = LEVELS[0][1]
    for threshold, name in LEVELS:
        if xp >= threshold:
            level = LEVELS.index((threshold, name)) + 1
            title = name
    return level, title

def today_key():
    return time.strftime("%Y-%m-%d", time.localtime())

def ensure_daily(account):
    ensure_account_progress(account)
    today = today_key()
    if account.get("daily_challenge_date") != today:
        account["daily_challenge_date"] = today
        account["daily_challenges"] = {"play10": 0, "win3": 0, "blackjack1": 0}
        account["daily_challenge_claimed"] = []
        save_accounts()

def unlock_achievements(account):
    ensure_account_progress(account)
    earned = set(account.get("achievements", []))
    checks = {
        "first_blackjack": account["blackjacks"] >= 1,
        "five_streak": account["best_win_streak"] >= 5,
        "ten_blackjacks": account["blackjacks"] >= 10,
        "ten_k": account["money"] >= 10000,
        "fifty_k": account["money"] >= 50000,
        "hundred_wins": account["wins"] >= 100,
    }
    new = [k for k, ok in checks.items() if ok and k not in earned]
    if new:
        earned.update(new)
        account["achievements"] = sorted(earned)
        save_accounts()
    return new

def is_user_online(username_key):
    for room in rooms.values():
        for p in room.get("players", []):
            if p.get("username_key") == username_key and p.get("connected"):
                return True
    return False

def friends_payload(account):
    out = []
    for key in account.get("friends", []):
        friend = ACCOUNTS.get(key)
        if friend:
            out.append({"username": friend["username"], "online": is_user_online(key), "level": account_level(int(friend.get("xp",0)))[0]})
    return out

def profile_payload(account):
    ensure_account_progress(account)
    ensure_daily(account)
    level, title = account_level(int(account.get("xp", 0)))
    games = int(account.get("games_played", 0))
    wins = int(account.get("wins", 0))
    return {
        "username": account["username"], "balance": int(account.get("money", 0)),
        "stats": {
            "gamesPlayed": games, "wins": wins, "losses": int(account.get("losses", 0)),
            "pushes": int(account.get("pushes", 0)), "blackjacks": int(account.get("blackjacks", 0)),
            "winRate": round((wins / games * 100), 1) if games else 0,
            "bestWinStreak": int(account.get("best_win_streak", 0)),
            "biggestWin": int(account.get("biggest_win", 0)),
        },
        "xp": int(account.get("xp", 0)), "level": level, "levelTitle": title,
        "achievements": list(account.get("achievements", [])),
        "friends": friends_payload(account),
        "dailyClaimed": account.get("daily_claim") == today_key(),
        "dailyChallenges": account.get("daily_challenges", {}),
    }

def leaderboard_payload():
    rows = []
    for a in ACCOUNTS.values():
        ensure_account_progress(a)
        level, title = account_level(int(a.get("xp", 0)))
        rows.append({"username": a["username"], "balance": int(a.get("money", 0)),
                     "wins": int(a.get("wins", 0)), "blackjacks": int(a.get("blackjacks", 0)),
                     "winRate": round((a.get("wins", 0) / a.get("games_played", 0) * 100), 1) if a.get("games_played", 0) else 0,
                     "streak": int(a.get("best_win_streak", 0)), "games": int(a.get("games_played", 0)),
                     "level": level, "levelTitle": title})
    def top(key): return sorted(rows, key=lambda x: (x[key], x["username"].lower()), reverse=True)[:20]
    return {"balance": top("balance"), "wins": top("wins"), "blackjacks": top("blackjacks"),
            "winRate": top("winRate"), "streak": top("streak"), "games": top("games")}

def challenge_defs():
    return [
        {"id": "play10", "title": "TABLE REGULAR", "desc": "Play 10 hands today.", "target": 10, "reward": 250},
        {"id": "win3", "title": "WINNER'S RUN", "desc": "Win 3 hands today.", "target": 3, "reward": 300},
        {"id": "blackjack1", "title": "NATURAL", "desc": "Get a Blackjack today.", "target": 1, "reward": 400},
    ]

def challenge_payload(account):
    ensure_daily(account)
    vals = account.get("daily_challenges", {})
    claimed = set(account.get("daily_challenge_claimed", []))
    return [{**d, "progress": min(d["target"], int(vals.get(d["id"], 0))),
             "complete": int(vals.get(d["id"], 0)) >= d["target"], "rewarded": d["id"] in claimed} for d in challenge_defs()]

def update_daily_progress(account, result):
    ensure_daily(account)
    vals = account["daily_challenges"]
    vals["play10"] = int(vals.get("play10", 0)) + 1
    if result == "win" or result == "blackjack": vals["win3"] = int(vals.get("win3", 0)) + 1
    if result == "blackjack": vals["blackjack1"] = 1
    claimed = set(account.get("daily_challenge_claimed", []))
    for d in challenge_defs():
        if vals.get(d["id"], 0) >= d["target"] and d["id"] not in claimed:
            account["money"] = int(account.get("money", 0)) + d["reward"]
            add_xp(account, 30)
            claimed.add(d["id"])
    account["daily_challenge_claimed"] = sorted(claimed)
    save_accounts()

def add_xp(account, amount):
    ensure_account_progress(account)
    mult = 2 if ADMIN_EVENTS.get("double_xp") else 1
    account["xp"] = max(0, int(account.get("xp", 0)) + int(amount) * mult)


def get_room(code: str, public=False) -> dict:
    if code not in rooms:
        rooms[code] = {
            "code": code,
            "public": bool(public),
            "phase": "LOBBY",
            "players": [],
            "host_id": None,
            "created_at": time.time(),
            "kicked": [],
            "deck": fresh_shoe(),
            "dealer_hand": [],
            "active_player_id": None,
            "lucky_players": set(),
            "muted_users": set(),
            "paused": False,
            "dealer_preview_active": False,
            "dealer_preview_cards": [],
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
    return [p for p in room["players"] if p["connected"] and not p.get("spectator")]

def connected_spectators(room):
    return [p for p in room["players"] if p["connected"] and p.get("spectator")]

def public_tables_payload():
    rows = []
    for room in rooms.values():
        if not room.get("public"):
            continue
        players = active_players(room)
        spectators = connected_spectators(room)
        host = find_player(room, room.get("host_id")) if room.get("host_id") else None
        rows.append({
            "code": room["code"], "players": len(players), "maxPlayers": MAX_PLAYERS,
            "spectators": len(spectators), "host": host.get("username") if host else "—",
            "phase": room.get("phase", "LOBBY"), "canJoin": len(players) < MAX_PLAYERS,
            "canSpectate": bool(players) and room.get("phase") in ("PLAYING", "ROUND_OVER"),
        })
    rows.sort(key=lambda r: (r["players"] >= r["maxPlayers"], -r["players"], r["code"]))
    return rows

def random_room_code():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(random.choice(alphabet) for _ in range(6))
        if code not in rooms:
            return code

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
        "paused": bool(room.get("paused", False)),
        "activePlayerId": room["active_player_id"],
        "hostId": room.get("host_id"),
        "dealerHand": dealer_hand,
        "dealerDisplay": hand_display(room["dealer_hand"]) if show_dealer and room["dealer_hand"] else None,
        "players": [
            {
                "id":        p["id"],
                "name":      p["name"],
                "username":  p["username"],
                "isHost":    p["id"] == room.get("host_id"),
                "canClaim":  int(p.get("money", 0)) <= 0,
                "money":     p["money"],
                "bet":       p["bet"],
                "hand":      p["hand"],
                "display":   hand_display(p["hand"]) if p["hand"] else None,
                "status":    p["status"],
                "result":    p["result"],
                "connected": p["connected"],
                "spectator": bool(p.get("spectator")),
                "pity":      p.get("pity_banner", False),
                "lucky":     p.get("username_key") in room.get("lucky_players", set()),
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

async def broadcast_public_tables():
    payload = json.dumps({"type": "public_tables", "tables": public_tables_payload()})
    sockets = set()
    for room in rooms.values():
        for p in room.get("players", []):
            if p.get("ws"):
                sockets.add(p["ws"])
    for ws in sockets:
        try:
            await ws.send(payload)
        except Exception:
            pass

async def send_public_tables(websocket):
    await websocket.send(json.dumps({"type": "public_tables", "tables": public_tables_payload()}))

def chat_clean(text):
    text = " ".join(str(text or "").split())[:180]
    low = text.lower()
    for word in BANNED_WORDS:
        if word in low:
            return None
    return text

# ---------------------------------------------------------------------------
# Admin helpers
# ---------------------------------------------------------------------------
def admin_payload(room):
    users = [{"username": a["username"], "money": int(a.get("money", 0)), "xp": int(a.get("xp", 0)),
              "wins": int(a.get("wins", 0)), "games": int(a.get("games_played", 0))}
             for a in ACCOUNTS.values()]
    table_players = []
    if room:
        table_players = [{
            "id": p["id"], "username": p["username"], "money": int(p["money"]),
            "lucky": p.get("username_key") in room.get("lucky_players", set()),
            "muted": p.get("username_key") in room.get("muted_users", set()),
            "connected": p.get("connected", False),
        } for p in room.get("players", [])]
    preview = None
    if room and room.get("dealer_preview_active") and room.get("dealer_preview_cards"):
        preview = [{"rank": c["rank"], "suit": c["suit"], "faceUp": True}
                   for c in room["dealer_preview_cards"]]
    connected = sum(1 for r in rooms.values() for p in r.get("players", []) if p.get("connected"))
    active_tables = len(rooms)
    total_money = sum(int(a.get("money", 0)) for a in ACCOUNTS.values())
    return {"users": users, "tablePlayers": table_players,
            "dealerPreviewActive": bool(room and room.get("dealer_preview_active")),
            "dealerPreview": preview,
            "metrics": {"accounts": len(ACCOUNTS), "online": connected, "tables": active_tables, "money": total_money},
            "events": dict(ADMIN_EVENTS), "paused": bool(room and room.get("paused", False))}

async def send_admin_data(websocket, room):
    if websocket in ADMIN_SOCKETS:
        await websocket.send(json.dumps({"type": "admin_data", **admin_payload(room)}))

def invalidate_dealer_preview(room):
    if not room.get("dealer_preview_cards"):
        room["dealer_preview_active"] = False
        return
    # Put reserved preview cards back into the shoe, then reshuffle.
    room["deck"].extend(room["dealer_preview_cards"])
    random.shuffle(room["deck"])
    room["dealer_preview_cards"] = []
    room["dealer_preview_active"] = False

def prepare_dealer_preview(room):
    invalidate_dealer_preview(room)
    eligible = [p for p in active_players(room) if p["money"] > 0]
    n = len(eligible)
    if n <= 0 or len(room["deck"]) < (2 * n + 2):
        return False
    # Deal order is: each player, dealer; each player, dealer. Reserve the
    # exact two dealer cards that deal_round() will use.
    first_index = -(n + 1)
    second_index = -(2 * n + 2)
    preview = [room["deck"][first_index], room["deck"][second_index]]
    for card in preview:
        room["deck"].remove(card)
    room["dealer_preview_cards"] = preview
    room["dealer_preview_active"] = True
    return True

def lucky_card(room, player, hand):
    if player.get("username_key") not in room.get("lucky_players", set()):
        return draw_card(room)
    # Lucky mode is deliberately player-specific: prefer a useful card.
    candidates = [c for c in room["deck"] if hand_value(hand + [{**c, "faceUp": True}]) <= 21]
    if not candidates:
        return draw_card(room)
    # Prefer 10-value cards when the player is on 11 or less, otherwise prefer
    # a card that moves the hand close to 21 without busting.
    target = min(21, hand_value(hand) + 10)
    candidates.sort(key=lambda c: abs((hand_value(hand) + card_value(c["rank"])) - target))
    chosen = candidates[0]
    room["deck"].remove(chosen)
    return chosen

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
        p["status"] = "spectating" if p.get("spectator") else "betting"
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
            # If a preview is active, reserved dealer cards have already been
            # removed from the shoe, so player draws remain deterministic.
            card = lucky_card(room, p, p["hand"])
            card["faceUp"] = True
            p["hand"].append(card)
        if room.get("dealer_preview_cards"):
            dealer_card = room["dealer_preview_cards"][round_num]
        else:
            dealer_card = draw_card(room)
        dealer_card["faceUp"] = (round_num == 0)
        room["dealer_hand"].append(dealer_card)
    room["dealer_preview_cards"] = []
    room["dealer_preview_active"] = False

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

        if ADMIN_EVENTS.get("bonus_cash") and p["result"] in ("win", "blackjack"):
            bonus = max(10, int(round(p["bet"] * 0.25)))
            p["money"] += bonus
            p["admin_bonus"] = bonus
        p["money"] = max(0, int(p["money"]))
        account = ACCOUNTS.get(p.get("username_key"))
        if account is not None:
            ensure_account_progress(account)
            account["games_played"] += 1
            if p["result"] == "win":
                account["wins"] += 1
                account["current_win_streak"] += 1
                account["best_win_streak"] = max(account["best_win_streak"], account["current_win_streak"])
                account["biggest_win"] = max(account["biggest_win"], int(p["bet"]))
                add_xp(account, 15)
            elif p["result"] == "blackjack":
                account["wins"] += 1
                account["blackjacks"] += 1
                account["current_win_streak"] += 1
                account["best_win_streak"] = max(account["best_win_streak"], account["current_win_streak"])
                account["biggest_win"] = max(account["biggest_win"], int(round(p["bet"] * 1.5)))
                add_xp(account, 25)
            elif p["result"] in ("lose", "bust"):
                account["losses"] += 1
                account["current_win_streak"] = 0
                add_xp(account, 5)
            elif p["result"] == "push":
                account["pushes"] += 1
                add_xp(account, 8)
            update_daily_progress(account, p["result"])
            unlock_achievements(account)
            save_accounts()
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
    for p in active_players(room):
        account = ACCOUNTS.get(p.get("username_key"))
        if account and p.get("ws"):
            try:
                await p["ws"].send(json.dumps({"type":"profile", "profile": profile_payload(account)}))
            except Exception:
                pass

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
            ensure_account_progress(ACCOUNTS[key])
            save_accounts()
            token = new_token()
            TOKENS[token] = key
            ACCOUNTS[key]["session_token"] = token
            USER_SOCKETS[key] = websocket
            save_accounts()
            await websocket.send(json.dumps({"type": "auth_ok", "mode": "signup", "username": username, "balance": STARTING_MONEY, "token": token, "profile": profile_payload(ACCOUNTS[key])}))
            continue

        if kind == "login":
            username = (msg.get("username") or "").strip()
            password = msg.get("password") or ""
            key = username_key(username)
            account = ACCOUNTS.get(key)
            if account:
                ensure_account_progress(account)
            if not account or not verify_password(password, account["salt"], account["password"]):
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "Incorrect username or password."}))
                continue
            token = new_token()
            old = account.get("session_token")
            if old: TOKENS.pop(old, None)
            TOKENS[token] = key
            account["session_token"] = token
            USER_SOCKETS[key] = websocket
            save_accounts()
            await websocket.send(json.dumps({"type": "auth_ok", "mode": "login", "username": account["username"], "balance": account["money"], "token": token, "profile": profile_payload(account)}))
            continue

        if kind == "resume":
            token = msg.get("token")
            key = TOKENS.get(token)
            if key in ACCOUNTS and ACCOUNTS[key].get("session_token") == token:
                account = ACCOUNTS[key]
                ensure_account_progress(account)
                USER_SOCKETS[key] = websocket
                await websocket.send(json.dumps({"type": "auth_ok", "mode": "resume", "username": account["username"], "balance": account.get("money",0), "token": token, "profile": profile_payload(account)}))
            else:
                await websocket.send(json.dumps({"type": "session_invalid"}))
            continue

        if kind == "logout":
            token = msg.get("token")
            key = TOKENS.pop(token, None)
            if key in ACCOUNTS and ACCOUNTS[key].get("session_token") == token:
                ACCOUNTS[key]["session_token"] = None
                if USER_SOCKETS.get(key) is websocket: USER_SOCKETS.pop(key, None)
                save_accounts()
            continue

        if kind == "public_tables":
            await send_public_tables(websocket)
            continue

        if kind == "create_public":
            token = msg.get("token")
            key = TOKENS.get(token)
            if key not in ACCOUNTS:
                await websocket.send(json.dumps({"type":"error","message":"Please log in first."}))
                continue
            code = random_room_code()
            get_room(code, public=True)
            await websocket.send(json.dumps({"type":"public_created","code":code}))
            await send_public_tables(websocket)
            continue

        if kind == "friends":
            key = TOKENS.get(msg.get("token"))
            if key in ACCOUNTS:
                await websocket.send(json.dumps({"type":"friends","friends":friends_payload(ACCOUNTS[key])}))
            continue

        if kind == "add_friend":
            key = TOKENS.get(msg.get("token"))
            target_key = username_key(msg.get("username"))
            if key not in ACCOUNTS or target_key not in ACCOUNTS:
                await websocket.send(json.dumps({"type":"error","scope":"friends","message":"Player not found."}))
                continue
            if target_key == key:
                await websocket.send(json.dumps({"type":"error","scope":"friends","message":"You cannot add yourself."}))
                continue
            friends = set(ACCOUNTS[key].get("friends", []))
            if target_key in friends:
                await websocket.send(json.dumps({"type":"error","scope":"friends","message":"Already in your friends list."}))
                continue
            friends.add(target_key)
            ACCOUNTS[key]["friends"] = sorted(friends)
            save_accounts()
            await websocket.send(json.dumps({"type":"friends","friends":friends_payload(ACCOUNTS[key])}))
            continue

        if kind == "remove_friend":
            key = TOKENS.get(msg.get("token"))
            target_key = username_key(msg.get("username"))
            if key in ACCOUNTS:
                ACCOUNTS[key]["friends"] = [x for x in ACCOUNTS[key].get("friends", []) if x != target_key]
                save_accounts()
                await websocket.send(json.dumps({"type":"friends","friends":friends_payload(ACCOUNTS[key])}))
            continue

        if kind == "invite_friend":
            key = TOKENS.get(msg.get("token"))
            target_key = username_key(msg.get("username"))
            if key in ACCOUNTS and target_key in set(ACCOUNTS[key].get("friends", [])) and room:
                target_ws = USER_SOCKETS.get(target_key)
                if target_ws:
                    await target_ws.send(json.dumps({"type":"table_invite","from":ACCOUNTS[key]["username"],"room":room["code"]}))
                else:
                    await websocket.send(json.dumps({"type":"error","scope":"friends","message":"That friend is offline."}))
            continue

        if kind == "chat":
            if room is not None and player is not None:
                if player.get("username_key") in room.get("muted_users", set()):
                    await websocket.send(json.dumps({"type":"error","scope":"chat","message":"You are muted by the admin for this table."}))
                    continue
                now = time.monotonic()
                if now - float(player.get("last_chat_at", 0.0)) < 0.75:
                    await websocket.send(json.dumps({"type":"error","scope":"chat","message":"Slow down a little — chat is limited to prevent spam."}))
                    continue
                text = chat_clean(msg.get("text"))
                if text:
                    player["last_chat_at"] = now
                    payload = json.dumps({"type":"chat","username":player["username"],"text":text,"ts":int(time.time()*1000)})
                    for rp in room.get("players", []):
                        if rp.get("ws"):
                            try: await rp["ws"].send(payload)
                            except Exception: pass
                elif player:
                    await websocket.send(json.dumps({"type":"error","scope":"chat","message":"That message isn't allowed."}))
            continue

        if kind == "profile":
            token = msg.get("token")
            key = TOKENS.get(token)
            if key in ACCOUNTS:
                await websocket.send(json.dumps({"type":"profile", "profile": profile_payload(ACCOUNTS[key])}))
                await websocket.send(json.dumps({"type":"leaderboard", "leaderboard": leaderboard_payload()}))
            continue

        if kind == "leaderboard":
            await websocket.send(json.dumps({"type":"leaderboard", "leaderboard": leaderboard_payload()}))
            continue

        if kind == "achievements":
            token = msg.get("token")
            key = TOKENS.get(token)
            if key in ACCOUNTS:
                account = ACCOUNTS[key]
                new = unlock_achievements(account)
                await websocket.send(json.dumps({"type":"achievements", "achievements": ACHIEVEMENT_DEFS, "earned": account.get("achievements", []), "new": new}))
            continue

        if kind == "daily":
            token = msg.get("token")
            key = TOKENS.get(token)
            if key in ACCOUNTS:
                account = ACCOUNTS[key]
                await websocket.send(json.dumps({"type":"daily", "claimed": account.get("daily_claim") == today_key(), "challenges": challenge_payload(account)}))
            continue

        if kind == "claim_daily":
            token = msg.get("token")
            key = TOKENS.get(token)
            if key in ACCOUNTS:
                account = ACCOUNTS[key]
                ensure_daily(account)
                if account.get("daily_claim") != today_key():
                    account["money"] = int(account.get("money", 0)) + 250
                    account["daily_claim"] = today_key()
                    add_xp(account, 25)
                    unlock_achievements(account)
                    save_accounts()
                    await websocket.send(json.dumps({"type":"daily_claimed", "amount":250, "profile":profile_payload(account)}))
                else:
                    await websocket.send(json.dumps({"type":"error", "scope":"daily", "message":"Today's reward has already been claimed."}))
            continue

        if kind == "join":
            token = msg.get("token")
            account_key = TOKENS.get(token)
            if not account_key or account_key not in ACCOUNTS:
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "Please log in first."}))
                continue
            code = (msg.get("room") or "PUBLIC").strip().upper()[:12] or "PUBLIC"
            spectate = bool(msg.get("spectate"))
            if spectate and code not in rooms:
                await websocket.send(json.dumps({"type":"error","message":"That table does not exist."}))
                room = None
                continue
            room = get_room(code)
            if spectate and not room.get("players"):
                await websocket.send(json.dumps({"type":"error","message":"There is nobody to spectate yet."}))
                room = None
                continue
            if account_key in room.get("kicked", []):
                await websocket.send(json.dumps({"type": "error", "message": "You were kicked from this table. Create/use another table."}))
                room = None
                continue
            connected_count = sum(1 for p in room["players"] if p["connected"] and not p.get("spectator"))
            if not spectate and connected_count >= MAX_PLAYERS:
                await websocket.send(json.dumps({"type": "error", "message": "Table is full."}))
                room = None
                continue

            pid = new_id()
            account = ACCOUNTS[account_key]
            ensure_account_progress(account)
            player = {
                "id": pid,
                "ws": websocket,
                "name": account["username"],
                "username": account["username"],
                "username_key": account_key,
                "money": int(account.get("money", STARTING_MONEY)),
                "bet": 0,
                "hand": [],
                "status": "spectating" if spectate or room["phase"] not in ("LOBBY", "BETTING") else "betting",
                "spectator": spectate or room["phase"] not in ("LOBBY", "BETTING"),
                "result": None,
                "connected": True,
                "consecutive_losses": 0,
                "pity_banner": False,
                "double_used": False,
                "last_chat_at": 0.0,
            }
            if room.get("host_id") is None:
                room["host_id"] = pid
            room["players"].append(player)
            invalidate_dealer_preview(room)
            if room["phase"] == "LOBBY":
                room["phase"] = "BETTING"

            await websocket.send(json.dumps({"type": "joined", "id": pid, "room": code, "username": account["username"], "balance": player["money"], "isHost": room["host_id"] == pid}))
            await broadcast(room)
            await broadcast_public_tables()
            continue

        if kind == "admin_login":
            password = msg.get("password") or ""
            if ADMIN_PASSWORD and hmac.compare_digest(password, ADMIN_PASSWORD):
                ADMIN_SOCKETS.add(websocket)
                await websocket.send(json.dumps({"type": "admin_ok"}))
                await send_admin_data(websocket, room)
            else:
                await websocket.send(json.dumps({"type": "error", "scope": "admin", "message": "Incorrect admin password."}))
            continue

        if kind == "leave_table":
            if player and room:
                was_active = room["active_player_id"] == player["id"]
                invalidate_dealer_preview(room)
                try:
                    room["players"].remove(player)
                except ValueError:
                    pass
                player = None
                room = None if delete_room_if_empty(room) else room
                if room:
                    if was_active:
                        room["active_player_id"] = None
                        await move_to_next_or_dealer(room)
                    await broadcast(room)
            await broadcast_public_tables()
            await websocket.send(json.dumps({"type": "left_table"}))
            await send_admin_data(websocket, room)
            continue

        if room is None or player is None:
            continue

        # ---- betting actions ----
        if room.get("paused") and kind in {"chip","clear_bet","all_in","ready","hit","stand","double"}:
            continue
        if kind == "chip":
            if player["status"] not in ("betting", "ready"): continue
            try:
                amt = int(msg.get("amount", 0))
            except (TypeError, ValueError):
                amt = 0
            if amt <= 0 or amt > 1000000:
                continue
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
            card = lucky_card(room, player, player["hand"])
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
            card = lucky_card(room, player, player["hand"])
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
                await websocket.send(json.dumps({"type":"profile", "profile": profile_payload(ACCOUNTS[player["username_key"]])}))

        elif kind == "refresh_balance":
            account = ACCOUNTS.get(player["username_key"])
            if account:
                player["money"] = int(account.get("money", 0))
                await websocket.send(json.dumps({"type": "balance", "balance": player["money"]}))
                await websocket.send(json.dumps({"type":"profile", "profile": profile_payload(account)}))
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

        elif kind == "admin_kick":
            if websocket not in ADMIN_SOCKETS or not room:
                continue
            target = find_player(room, msg.get("targetId"))
            if not target:
                continue
            target_ws = target.get("ws")
            try:
                if target_ws:
                    await target_ws.send(json.dumps({"type":"kicked", "message":"Removed by the admin."}))
                    await target_ws.close()
            except Exception:
                pass

        elif kind == "admin_mute":
            if websocket not in ADMIN_SOCKETS or not room:
                continue
            target = find_player(room, msg.get("targetId"))
            if target:
                key = target.get("username_key")
                if bool(msg.get("muted")):
                    room.setdefault("muted_users", set()).add(key)
                else:
                    room.setdefault("muted_users", set()).discard(key)
                await broadcast(room)
                await send_admin_data(websocket, room)

        elif kind == "admin_reshuffle":
            if websocket not in ADMIN_SOCKETS or not room or room.get("phase") == "PLAYING":
                continue
            invalidate_dealer_preview(room)
            room["deck"] = fresh_shoe()
            await broadcast(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_reset_round":
            if websocket not in ADMIN_SOCKETS or not room or room.get("phase") == "PLAYING":
                continue
            await reset_for_betting(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_bonus_table":
            if websocket not in ADMIN_SOCKETS or not room:
                continue
            amount = max(0, min(100000, int(msg.get("amount", 0))))
            if amount:
                for p in active_players(room):
                    p["money"] += amount
                    persist_player_money(p)
                await broadcast(room)
                await send_admin_data(websocket, room)

        elif kind == "admin_event":
            if websocket not in ADMIN_SOCKETS:
                continue
            event = str(msg.get("event", ""))
            if event in ADMIN_EVENTS:
                ADMIN_EVENTS[event] = bool(msg.get("enabled"))
                await websocket.send(json.dumps({"type":"admin_event_state", "events": dict(ADMIN_EVENTS), "paused": bool(room and room.get("paused", False))}))
                await send_admin_data(websocket, room)

        elif kind == "admin_pause":
            if websocket not in ADMIN_SOCKETS or not room:
                continue
            if room.get("phase") == "PLAYING":
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Pause is available between rounds only."}))
                continue
            room["paused"] = bool(msg.get("paused"))
            await broadcast(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_data":
            await send_admin_data(websocket, room)

        elif kind == "admin_give_table_money":
            if websocket not in ADMIN_SOCKETS or not room:
                continue
            target = find_player(room, msg.get("targetId"))
            try:
                amount = int(msg.get("amount", 0))
            except Exception:
                amount = 0
            if not target or amount <= 0 or amount > 1_000_000:
                continue
            target["money"] += amount
            persist_player_money(target)
            await broadcast(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_toggle_lucky":
            if websocket not in ADMIN_SOCKETS or not room:
                continue
            target = find_player(room, msg.get("targetId"))
            if not target:
                continue
            enabled = bool(msg.get("enabled"))
            key = target.get("username_key")
            if enabled:
                room.setdefault("lucky_players", set()).add(key)
            else:
                room.setdefault("lucky_players", set()).discard(key)
            await broadcast(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_toggle_preview":
            if websocket not in ADMIN_SOCKETS or not room:
                continue
            enabled = bool(msg.get("enabled"))
            if enabled and room["phase"] == "BETTING":
                ok = prepare_dealer_preview(room)
                if not ok:
                    await websocket.send(json.dumps({"type":"error", "scope":"admin", "message":"Dealer preview could not be prepared yet."}))
                    continue
            else:
                invalidate_dealer_preview(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_add_money":
            # Backward-compatible account-wide command.
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

        elif kind == "admin_reset_account":
            if websocket not in ADMIN_SOCKETS:
                continue
            key = username_key(msg.get("username"))
            if key in ACCOUNTS:
                account = ACCOUNTS[key]
                password = account.get("password")
                salt = account.get("salt")
                username = account.get("username")
                friends = account.get("friends", [])
                requests = account.get("friend_requests", [])
                created = account.get("created", time.time())
                account.clear()
                account.update({"username": username, "salt": salt, "password": password, "money": STARTING_MONEY,
                                "friends": friends, "friend_requests": requests, "created": created})
                ensure_account_progress(account)
                save_accounts()
                for r in rooms.values():
                    for p in r["players"]:
                        if p.get("username_key") == key:
                            p["money"] = STARTING_MONEY
                            await broadcast(r)
                await send_admin_data(websocket, room)

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
        await broadcast_public_tables()

    ADMIN_SOCKETS.discard(websocket)
    for key, sock in list(USER_SOCKETS.items()):
        if sock is websocket:
            USER_SOCKETS.pop(key, None)

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
