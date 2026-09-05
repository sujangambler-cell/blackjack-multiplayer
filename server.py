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

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None
    dict_row = None

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PORT = int(os.environ.get("PORT", "8080"))
PUBLIC_DIR = pathlib.Path(__file__).parent / "public"
STARTING_MONEY = 5000
ZERO_CLAIM = 100
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ACCOUNTS_FILE = pathlib.Path(__file__).parent / "accounts.json"
MAX_PLAYERS_DEFAULT = 5
MAX_PLAYERS_HARD_CAP = 10
READY_GRACE_S = 0.8      # small pause after last player hits ready before dealing
ROUND_OVER_S = 4.5       # results screen duration before next betting phase
ROULETTE_BET_WINDOW_S = 12
ROULETTE_SPIN_DELAY_S = 2.0
ROULETTE_NUMBERS = list(range(37))
ROULETTE_RED = {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36}

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
USER_SOCKETS = {}
BANNED_WORDS = {
    "fuck", "shit", "bitch", "asshole", "nigger", "nigga", "cunt",
    "dick", "pussy", "porn", "sex", "rape", "slut", "whore"
}

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

def _db_enabled():
    return bool(DATABASE_URL)

def _db_connect():
    if not _db_enabled():
        raise RuntimeError("DATABASE_URL is not configured")
    if psycopg is None:
        raise RuntimeError("psycopg is not installed")
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=10)

def _ensure_db():
    with _db_connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                username_key TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                salt TEXT NOT NULL,
                password TEXT NOT NULL,
                data JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

def _load_accounts_from_db():
    global ACCOUNTS, TOKENS
    with _db_connect() as conn:
        rows = conn.execute("SELECT username_key, data FROM accounts").fetchall()
    ACCOUNTS = {}
    TOKENS = {}
    for row in rows:
        key = row["username_key"]
        account = dict(row["data"])
        ACCOUNTS[key] = account
        tok = account.get("session_token")
        if tok:
            TOKENS[tok] = key

def _migrate_json_accounts_to_db():
    if not ACCOUNTS_FILE.exists():
        return
    try:
        raw = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return
    except Exception as exc:
        print("Could not read accounts.json for migration:", exc)
        return

    with _db_connect() as conn:
        count = conn.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()["n"]
    if count:
        return

    global ACCOUNTS, TOKENS
    ACCOUNTS = raw
    TOKENS = {}
    for key, account in ACCOUNTS.items():
        # Existing session tokens are deliberately invalidated during migration.
        account["session_token"] = None
        TOKENS.pop(account.get("session_token"), None)
        ensure_account_progress(account)
    save_accounts()
    print(f"Migrated {len(ACCOUNTS)} account(s) from accounts.json to PostgreSQL.")

SEASON_START_TS = 0.0
SEASON_DURATION_S = 21 * 24 * 60 * 60
SEASON_META_FILE = pathlib.Path(__file__).parent / "season_meta.json"

def _load_or_create_season_start():
    global SEASON_START_TS
    if _db_enabled():
        with _db_connect() as conn:
            row = conn.execute("SELECT setting_value FROM app_settings WHERE setting_key=%s", ("season_1_start",)).fetchone()
            if row:
                SEASON_START_TS = float(row["setting_value"])
            else:
                SEASON_START_TS = time.time()
                conn.execute("INSERT INTO app_settings (setting_key, setting_value) VALUES (%s, %s)", ("season_1_start", str(SEASON_START_TS)))
        return
    try:
        if SEASON_META_FILE.exists():
            raw=json.loads(SEASON_META_FILE.read_text(encoding="utf-8"))
            SEASON_START_TS=float(raw.get("season_1_start",0))
        if not SEASON_START_TS:
            SEASON_START_TS=time.time()
            SEASON_META_FILE.write_text(json.dumps({"season_1_start":SEASON_START_TS}),encoding="utf-8")
    except Exception:
        SEASON_START_TS=time.time()

def load_accounts():
    global ACCOUNTS, TOKENS
    if _db_enabled():
        try:
            _ensure_db()
            _load_or_create_season_start()
            _load_accounts_from_db()
            if not ACCOUNTS:
                _migrate_json_accounts_to_db()
                _load_accounts_from_db()
            print(f"PostgreSQL account storage enabled ({len(ACCOUNTS)} account(s)).")
            return
        except Exception as exc:
            print("FATAL: PostgreSQL is configured but unavailable:", exc)
            raise

    try:
        _load_or_create_season_start()
        if ACCOUNTS_FILE.exists():
            ACCOUNTS = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
            TOKENS = {}
            for key, account in ACCOUNTS.items():
                tok = account.get("session_token")
                if tok:
                    TOKENS[tok] = key
        print(f"Local JSON account storage enabled ({len(ACCOUNTS)} account(s)).")
    except Exception as exc:
        print("Could not load accounts:", exc)
        ACCOUNTS = {}
        TOKENS = {}

def save_accounts():
    if _db_enabled():
        with _db_connect() as conn:
            for key, account in ACCOUNTS.items():
                conn.execute("""
                    INSERT INTO accounts (username_key, username, salt, password, data, updated_at)
                    VALUES (%s, %s, %s, %s, %s::jsonb, NOW())
                    ON CONFLICT (username_key) DO UPDATE SET
                        username = EXCLUDED.username,
                        salt = EXCLUDED.salt,
                        password = EXCLUDED.password,
                        data = EXCLUDED.data,
                        updated_at = NOW()
                """, (key, account.get("username", key), account.get("salt", ""), account.get("password", ""), json.dumps(account)))
        return
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


COSMETIC_THEMES = {
    "classic":{"name":"Classic Noir","price":0,"season":None,"limited":False,"scope":"GLOBAL"},
    "midnight":{"name":"Midnight Velvet","price":12000,"season":None,"limited":False,"scope":"GLOBAL"},
    "royal":{"name":"Royal Eclipse","price":25000,"season":None,"limited":False,"scope":"GLOBAL"},
    "neon":{"name":"Neon Afterdark","price":40000,"season":None,"limited":False,"scope":"GLOBAL"},
    "casino1927":{"name":"Casino X: 1927","price":0,"season":1,"limited":True,"scope":"GLOBAL"},
    "admin_star":{"name":"Admin Star","price":0,"season":None,"limited":False,"scope":"GLOBAL","admin_only":True},
}
COSMETIC_CHIPS = {
    "classic":{"name":"Classic Chip","price":0,"season":None,"limited":False,"scope":"GLOBAL"},
    "silver":{"name":"Silver Edge","price":8000,"season":None,"limited":False,"scope":"GLOBAL"},
    "gold":{"name":"Gold Crest","price":18000,"season":None,"limited":False,"scope":"GLOBAL"},
    "casino1927":{"name":"1927 Brass Chip","price":0,"season":1,"limited":True,"scope":"GLOBAL"},
    "admin_chip":{"name":"Admin Chip","price":0,"season":None,"limited":False,"scope":"GLOBAL","admin_only":True},
}
COSMETIC_DECKS = {
    "classic":{"name":"Classic Deck","price":0,"season":None,"limited":False,"scope":"BLACKJACK"},
    "midnight":{"name":"Midnight Deck","price":14000,"season":None,"limited":False,"scope":"BLACKJACK"},
    "casino1927":{"name":"1927 Art Deco Deck","price":0,"season":1,"limited":True,"scope":"BLACKJACK"},
}
COSMETIC_TABLES = {
    "classic":{"name":"Classic Felt","price":0,"season":None,"limited":False,"scope":"GLOBAL"},
    "royal":{"name":"Royal Green Table","price":22000,"season":None,"limited":False,"scope":"GLOBAL"},
    "casino1927":{"name":"1927 Golden House Table","price":0,"season":1,"limited":True,"scope":"GLOBAL"},
}
COSMETIC_BALLS = {
    "classic":{"name":"Classic Roulette Ball","price":0,"season":None,"limited":False,"scope":"ROULETTE"},
    "brass1927":{"name":"1927 Brass Roulette Ball","price":0,"season":1,"limited":True,"scope":"ROULETTE"},
}
SEASON = {
    "id":1,"name":"CASINO X: 1927","subtitle":"THE GOLDEN AGE OF THE HOUSE","duration":"21 DAYS","theme":"casino1927",
    "tiers":[
        {"tier":1,"xp":0,"reward":{"type":"chips","amount":500,"name":"500 CHIPS"}},
        {"tier":2,"xp":120,"reward":{"type":"chip","id":"casino1927","name":"1927 BRASS CHIP"}},
        {"tier":3,"xp":300,"reward":{"type":"chips","amount":1000,"name":"1,000 CHIPS"}},
        {"tier":4,"xp":600,"reward":{"type":"deck","id":"casino1927","name":"1927 ART DECO DECK"}},
        {"tier":5,"xp":1000,"reward":{"type":"chips","amount":2500,"name":"2,500 CHIPS"}},
        {"tier":6,"xp":1500,"reward":{"type":"ball","id":"brass1927","name":"1927 BRASS ROULETTE BALL"}},
        {"tier":7,"xp":2200,"reward":{"type":"chips","amount":4000,"name":"4,000 CHIPS"}},
        {"tier":8,"xp":3000,"reward":{"type":"table","id":"casino1927","name":"1927 GOLDEN HOUSE TABLE"}},
        {"tier":9,"xp":4000,"reward":{"type":"title","id":"golden_age","name":"GOLDEN AGE HIGH ROLLER"}},
        {"tier":10,"xp":5250,"reward":{"type":"theme","id":"casino1927","name":"CASINO X: 1927 UNIVERSAL THEME"}},
    ]
}
def season_active(): return SEASON_START_TS > 0 and time.time() < SEASON_START_TS + SEASON_DURATION_S
def season_times():
    start=float(SEASON_START_TS or time.time()); end=start+SEASON_DURATION_S
    return start,end,max(0,int(end-time.time()))

def season_payload(account):
    xp=int(account.get("season_xp",0)); claimed=set(account.get("season_claimed",[]))
    start_ts,end_ts,remaining=season_times()
    tiers=[{**t,"claimed":str(t["tier"]) in claimed,"unlocked":xp>=t["xp"] and season_active()} for t in SEASON["tiers"]]
    return {"season":{**SEASON,"startAt":start_ts,"endAt":end_ts,"active":season_active(),"remainingSeconds":remaining},"xp":xp,"claimed":sorted(claimed),"tiers":tiers}

def _catalog_payload(catalog,owned,equipped):
    return [{"id":k,**v,"owned":k in owned,"equipped":equipped==k} for k,v in catalog.items() if not v.get("admin_only")]

def store_payload(account):
    ot=set(account.get("owned_themes",["classic"])); oc=set(account.get("owned_chips",["classic"]))
    od=set(account.get("owned_decks",["classic"])); osk=set(account.get("owned_tables",["classic"])); ob=set(account.get("owned_balls",["classic"]))
    return {
        "themes":_catalog_payload(COSMETIC_THEMES,ot,account.get("equipped_theme","classic")),
        "chips":_catalog_payload(COSMETIC_CHIPS,oc,account.get("equipped_chip","classic")),
        "decks":_catalog_payload(COSMETIC_DECKS,od,account.get("equipped_deck","classic")),
        "tables":_catalog_payload(COSMETIC_TABLES,osk,account.get("equipped_table","classic")),
        "balls":_catalog_payload(COSMETIC_BALLS,ob,account.get("equipped_ball","classic")),
        "balance":int(account.get("money",0)),"season":season_payload(account),
        "adminThemes":[{"id":k,**v,"owned":k in ot,"equipped":account.get("equipped_theme","classic")==k} for k,v in COSMETIC_THEMES.items() if v.get("admin_only") and k in ot],
        "adminChips":[{"id":k,**v,"owned":k in oc,"equipped":account.get("equipped_chip","classic")==k} for k,v in COSMETIC_CHIPS.items() if v.get("admin_only") and k in oc]
    }

def ensure_account_progress(account):
    defaults = {
        "money": STARTING_MONEY, "games_played": 0, "wins": 0, "losses": 0,
        "pushes": 0, "blackjacks": 0, "best_win_streak": 0, "current_win_streak": 0,
        "biggest_win": 0, "xp": 0, "achievements": [], "daily_claim": "",
        "daily_challenges": {}, "daily_challenge_date": "", "daily_challenge_claimed": [],
        "friends": [], "avatar": None, "avatar_color": None,
        "owned_themes": ["classic"], "owned_chips": ["classic"], "owned_decks": ["classic"], "owned_tables": ["classic"], "owned_balls": ["classic"], "equipped_theme": "classic", "equipped_chip": "classic", "equipped_deck": "classic", "equipped_table": "classic", "equipped_ball": "classic", "season_xp": 0, "season_claimed": [], "season_title": "",
        "roulette_games": 0, "roulette_wins": 0, "roulette_biggest_win": 0,
        "game_stats": {"blackjack": {"games": 0, "wins": 0}, "roulette": {"games": 0, "wins": 0}},
        "session_token": account.get("session_token"),
    }
    changed = False
    for k, v in defaults.items():
        if k not in account:
            account[k] = v
            changed = True
    stats = account.setdefault("game_stats", {})
    stats.setdefault("blackjack", {"games": 0, "wins": 0})
    stats.setdefault("roulette", {"games": int(account.get("roulette_games", 0)), "wins": int(account.get("roulette_wins", 0))})
    if changed:
        save_accounts()
    return account

# Database loading is intentionally performed only after all account helper
# functions are defined. This prevents startup-time NameError during migration.
load_accounts()

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
        account["daily_challenges"] = {"play10": 0, "win3": 0, "blackjack1": 0, "roulette1": 0}
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

def find_user_table(username_key_str):
    """Return room code + game if this account is seated at a table."""
    for room in rooms.values():
        for p in room.get("players", []):
            if p.get("username_key") == username_key_str and p.get("connected") and not p.get("spectator"):
                return {"room": room.get("code"), "game": room.get("game", "blackjack")}
    return None

def friends_payload(account):
    out = []
    for key in account.get("friends", []):
        friend = ACCOUNTS.get(key)
        if friend:
            loc = find_user_table(key)
            out.append({
                "username": friend["username"],
                "online": is_user_online(key),
                "level": account_level(int(friend.get("xp", 0)))[0],
                "avatar": friend.get("avatar"),
                "avatarColor": friend.get("avatar_color"),
                "location": loc,
            })
    return out

def profile_payload(account):
    ensure_account_progress(account)
    ensure_daily(account)
    level, title = account_level(int(account.get("xp", 0)))
    games = int(account.get("games_played", 0))
    wins = int(account.get("wins", 0))
    # Default avatar color from username hash if missing
    if not account.get("avatar_color"):
        h = sum(ord(c) for c in account.get("username", "P"))
        hues = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6", "#ef4444", "#22c55e", "#0ea5e9"]
        account["avatar_color"] = hues[h % len(hues)]
    return {
        "username": account["username"], "balance": int(account.get("money", 0)),
        "avatar": account.get("avatar"),
        "avatarColor": account.get("avatar_color"),
        "stats": {
            "gamesPlayed": games, "wins": wins, "losses": int(account.get("losses", 0)),
            "pushes": int(account.get("pushes", 0)), "blackjacks": int(account.get("blackjacks", 0)),
            "winRate": round((wins / games * 100), 1) if games else 0,
            "bestWinStreak": int(account.get("best_win_streak", 0)),
            "biggestWin": int(account.get("biggest_win", 0)),
            "rouletteGames": int(account.get("roulette_games", 0)),
            "rouletteWins": int(account.get("roulette_wins", 0)),
            "rouletteBiggestWin": int(account.get("roulette_biggest_win", 0)),
            "gameStats": account.get("game_stats", {}),
        },
        "xp": int(account.get("xp", 0)), "level": level, "levelTitle": title,
        "achievements": list(account.get("achievements", [])),
        "friends": friends_payload(account),
        "dailyClaimed": account.get("daily_claim") == today_key(),
        "dailyChallenges": account.get("daily_challenges", {}),
        "cosmetics": {"theme":account.get("equipped_theme","classic"),"chip":account.get("equipped_chip","classic"),
                       "deck":account.get("equipped_deck","classic"),"table":account.get("equipped_table","classic"),
                       "ball":account.get("equipped_ball","classic"),"title":account.get("season_title","")},
        "season": season_payload(account),
    }

def leaderboard_payload():
    rows = []
    for a in ACCOUNTS.values():
        ensure_account_progress(a)
        level, title = account_level(int(a.get("xp", 0)))
        total_games = int(a.get("games_played", 0))
        total_wins = int(a.get("wins", 0))
        rows.append({"username": a["username"], "balance": int(a.get("money", 0)),
                     "wins": total_wins, "blackjacks": int(a.get("blackjacks", 0)), "rouletteWins": int(a.get("roulette_wins", 0)),
                     "winRate": round((total_wins / total_games * 100), 1) if total_games else 0,
                     "streak": int(a.get("best_win_streak", 0)), "games": total_games,
                     "level": level, "levelTitle": title})
    def top(key): return sorted(rows, key=lambda x: (x[key], x["username"].lower()), reverse=True)[:20]
    return {"balance": top("balance"), "wins": top("wins"), "blackjacks": top("blackjacks"),
            "winRate": top("winRate"), "streak": top("streak"), "games": top("games")}

def challenge_defs():
    return [
        {"id": "play10", "title": "TABLE REGULAR", "desc": "Play 10 hands today.", "target": 10, "reward": 250},
        {"id": "win3", "title": "WINNER'S RUN", "desc": "Win 3 hands today.", "target": 3, "reward": 300},
        {"id": "blackjack1", "title": "NATURAL", "desc": "Get a Blackjack today.", "target": 1, "reward": 400},
        {"id": "roulette1", "title": "RED OR BLACK", "desc": "Win a Roulette bet today.", "target": 1, "reward": 400},
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
    account["xp"] = max(0, int(account.get("xp", 0)) + int(amount))


def get_room(code: str, public=False, game="blackjack", max_players=None) -> dict:
    if code not in rooms:
        try:
            mp = int(max_players) if max_players is not None else MAX_PLAYERS_DEFAULT
        except (TypeError, ValueError):
            mp = MAX_PLAYERS_DEFAULT
        mp = max(2, min(MAX_PLAYERS_HARD_CAP, mp))
        rooms[code] = {
            "code": code,
            "public": bool(public),
            "game": game,
            "max_players": mp,
            "phase": "LOBBY",
            "players": [],
            "host_id": None,
            "created_at": time.time(),
            "kicked": [],
            "deck": fresh_shoe(),
            "dealer_hand": [],
            "active_player_id": None,
            "lucky_players": {},
            "roulette_player_luck": {},
            "roulette_table_luck": {"strength": 0, "expires_at": 0},
            "roulette_settled": set(),
            "dealer_preview_active": False,
            "dealer_preview_cards": [],
            "roulette_bets": {},
            "roulette_last_result": None,
            "roulette_phase": "BETTING",
            "roulette_task": None,
            "double_cash": False,
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
        max_p = int(room.get("max_players", MAX_PLAYERS_DEFAULT))
        rows.append({
            "code": room["code"], "game": room.get("game", "blackjack"), "players": len(players), "maxPlayers": max_p,
            "spectators": len(spectators), "host": host.get("username") if host else "—",
            "phase": room.get("phase", "LOBBY"), "canJoin": len(players) < max_p,
            "canSpectate": bool(players) and room.get("phase") in ("PLAYING", "ROUND_OVER"),
            "doubleCash": bool(room.get("double_cash")),
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
        "game": room.get("game", "blackjack"),
        "phase": room["phase"],
        "activePlayerId": room["active_player_id"],
        "hostId": room.get("host_id"),
        "maxPlayers": int(room.get("max_players", MAX_PLAYERS_DEFAULT)),
        "doubleCash": bool(room.get("double_cash")),
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
                "lucky":     bool(room.get("lucky_players", {}).get(p.get("username_key"), 0)),
                "cosmetics": p.get("cosmetics", {}),
                "avatar": p.get("avatar"),
                "avatarColor": p.get("avatar_color"),
                "friendBoost": int(p.get("friendBoost", 0) or 0),
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
    users = [{"username": a["username"], "money": int(a.get("money", 0))}
             for a in ACCOUNTS.values()]
    table_players = []
    if room:
        table_players = [{
            "id": p["id"], "username": p["username"], "money": int(p["money"]),
            "lucky": bool(room.get("lucky_players", {}).get(p.get("username_key"), 0)),
            "luckStrength": int(room.get("roulette_player_luck", {}).get(p.get("username_key"), 0)),
            "connected": p.get("connected", False),
        } for p in room.get("players", [])]
    preview = None
    if room and room.get("dealer_preview_active") and room.get("dealer_preview_cards"):
        preview = [{"rank": c["rank"], "suit": c["suit"], "faceUp": True}
                   for c in room["dealer_preview_cards"]]
    table_luck = room.get("roulette_table_luck", {}) if room else {}
    table_luck_active = bool(table_luck.get("strength", 0) and table_luck.get("expires_at", 0) > time.time())
    return {"users": users, "tablePlayers": table_players, "dealerPreviewActive": bool(room and room.get("dealer_preview_active")), "dealerPreview": preview,
            "tableLuck": {"strength": int(table_luck.get("strength", 0)), "active": table_luck_active}}



def is_authorized_admin(websocket, room, player):
    return websocket in ADMIN_SOCKETS and room is not None and player is not None and any(
        p is player and p.get("connected") for p in room.get("players", [])
    )

async def send_admin_data(websocket, room):
    if websocket in ADMIN_SOCKETS and room is not None:
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

def _player_has_admin_luck(player):
    """Small permanent luck buff for admin cosmetics (star theme or admin chip)."""
    cos = player.get("cosmetics") or {}
    return cos.get("theme") == "admin_star" or cos.get("chip") == "admin_chip"

def lucky_card(room, player, hand):
    admin_luck = _player_has_admin_luck(player)
    forced = bool(room.get("lucky_players", {}).get(player.get("username_key"), 0))
    if not forced and not admin_luck:
        return draw_card(room)
    # Admin-only mild luck: 35% chance to bias; full lucky mode always biases
    if not forced and admin_luck and random.random() > 0.35:
        return draw_card(room)
    candidates = [c for c in room["deck"] if hand_value(hand + [{**c, "faceUp": True}]) <= 21]
    if not candidates:
        return draw_card(room)
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

def friend_boost_mult(room, player):
    """+5% cash reward per friend seated at the same table (max +25%)."""
    acc = ACCOUNTS.get(player.get("username_key"))
    if not acc:
        return 1.0
    friend_keys = set(acc.get("friends", []))
    if not friend_keys:
        return 1.0
    count = 0
    for other in active_players(room):
        if other.get("id") == player.get("id"):
            continue
        if other.get("username_key") in friend_keys:
            count += 1
    return 1.0 + min(0.25, count * 0.05)

async def finish_round(room):
    dv = hand_value(room["dealer_hand"])
    dealer_bj = is_blackjack(room["dealer_hand"])
    mult = 2 if room.get("double_cash") else 1

    for p in active_players(room):
        if not p["hand"] or p["status"] == "spectating":
            continue
        fb = friend_boost_mult(room, p)
        p["friendBoost"] = round((fb - 1) * 100)
        if p["status"] == "bust":
            p["result"] = "bust"
            p["consecutive_losses"] = p.get("consecutive_losses", 0) + 1
        elif p["status"] == "blackjack":
            if dealer_bj:
                p["money"] += p["bet"]      # push (no mult on returned stake)
                p["result"] = "push"
                p["consecutive_losses"] = 0
            else:
                # 3:2 base; double_cash + friend boost multiply the total return
                p["money"] += round(p["bet"] * 2.5 * mult * fb)
                p["result"] = "blackjack"
                p["consecutive_losses"] = 0
        else:
            pv = hand_value(p["hand"])
            if dealer_bj:
                p["result"] = "lose"
                p["consecutive_losses"] = p.get("consecutive_losses", 0) + 1
            elif dv > 21 or dv < pv:
                p["money"] += round(p["bet"] * 2 * mult * fb)
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
            account["season_xp"] = int(account.get("season_xp", 0)) + (30 if p["result"] == "blackjack" else 20 if p["result"] == "win" else 8 if p["result"] == "push" else 5)
            bs = account.setdefault("game_stats", {}).setdefault("blackjack", {"games": 0, "wins": 0})
            bs["games"] = int(account.get("games_played", 0)); bs["wins"] = int(account.get("wins", 0))
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
# Roulette — server-authoritative European wheel, universal Casino X wallet/XP
# ---------------------------------------------------------------------------
ROULETTE_RED = {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36}
ROULETTE_BLACK = set(range(1,37)) - ROULETTE_RED

def roulette_color(n):
    if n == 0: return "green"
    return "red" if n in ROULETTE_RED else "black"

def roulette_bet_payout(bet_type):
    return {"straight": 35, "red": 1, "black": 1, "odd": 1, "even": 1, "low": 1, "high": 1,
            "dozen1": 2, "dozen2": 2, "dozen3": 2}.get(bet_type, 0)

def roulette_bet_wins(bet, number):
    t = bet.get("type")
    if t == "straight": return int(bet.get("value", -1)) == number
    if t == "red": return number in ROULETTE_RED
    if t == "black": return number in ROULETTE_BLACK
    if t == "odd": return number != 0 and number % 2 == 1
    if t == "even": return number != 0 and number % 2 == 0
    if t == "low": return 1 <= number <= 18
    if t == "high": return 19 <= number <= 36
    if t == "dozen1": return 1 <= number <= 12
    if t == "dozen2": return 13 <= number <= 24
    if t == "dozen3": return 25 <= number <= 36
    return False

def roulette_serialise(room):
    bets = []
    board = []  # all individual bets for board markers
    for p in room.get("players", []):
        plist = room.get("roulette_bets", {}).get(p["id"], [])
        total = sum(int(b["amount"]) for b in plist)
        letter = (p.get("username") or "?")[0].upper()
        color = (p.get("avatar_color") or "#6366f1")
        bets.append({
            "id": p["id"], "username": p["username"], "total": total,
            "isHost": p["id"] == room.get("host_id"),
            "connected": p.get("connected", False),
            "cosmetics": p.get("cosmetics", {}),
            "avatar": p.get("avatar"),
            "avatarColor": color,
        })
        for b in plist:
            board.append({
                "playerId": p["id"],
                "username": p.get("username"),
                "letter": letter,
                "color": color,
                "type": b.get("type"),
                "value": b.get("value"),
                "amount": int(b.get("amount", 0)),
            })
    return {
        "code": room["code"], "game": "roulette",
        "phase": room.get("roulette_phase", "BETTING"),
        "players": bets,
        "boardBets": board,
        "lastResult": room.get("roulette_last_result"),
        "maxPlayers": int(room.get("max_players", MAX_PLAYERS_DEFAULT)),
        "doubleCash": bool(room.get("double_cash")),
        "hostId": room.get("host_id"),
    }

async def roulette_broadcast(room):
    payload=json.dumps({"type":"roulette_state","state":roulette_serialise(room)})
    for p in room.get("players", []):
        if p.get("ws"):
            try: await p["ws"].send(payload)
            except Exception: pass

def roulette_player_bets(room, pid):
    return room.setdefault("roulette_bets", {}).setdefault(pid, [])

def _roulette_candidates_for_luck(room):
    """Return a weighted result pool. Luck never chooses an impossible value;
    it only biases the server's RNG toward outcomes covered by active bets."""
    weighted = []
    all_numbers = list(ROULETTE_NUMBERS)
    weighted.extend(all_numbers)
    table = room.get("roulette_table_luck", {})
    strength = int(table.get("strength", 0)) if table.get("expires_at", 0) > time.time() else 0

    for p in active_players(room):
        key = p.get("username_key")
        p_strength = int(room.get("roulette_player_luck", {}).get(key, 0))
        # Small permanent bias from admin cosmetics
        if _player_has_admin_luck(p):
            p_strength = max(p_strength, 18)
        if p_strength <= 0:
            continue
        if p_strength > 100:
            p_strength = 100
        winning_numbers = [n for n in ROULETTE_NUMBERS
                           if any(roulette_bet_wins(b, n) for b in roulette_player_bets(room, p["id"]))]
        if winning_numbers:
            weighted.extend(winning_numbers * max(1, p_strength // 10))

    if strength:
        # Table luck is a controlled global bias toward numbers covered by any
        # current wager, never a client-supplied winning-number selector.
        covered = [n for n in ROULETTE_NUMBERS if any(
            roulette_bet_wins(b, n)
            for p in active_players(room)
            for b in roulette_player_bets(room, p["id"])
        )]
        if covered:
            weighted.extend(covered * max(1, strength // 10))
    return weighted or all_numbers


async def roulette_spin(room):
    if room.get("roulette_phase") != "BETTING":
        return
    players = active_players(room)
    if not any(roulette_player_bets(room, p["id"]) for p in players):
        return

    room["roulette_phase"] = "SPINNING"
    room["roulette_settled"] = set()
    await roulette_broadcast(room)
    await asyncio.sleep(ROULETTE_SPIN_DELAY_S)

    if "force_next_number" in room and room["force_next_number"] is not None:
        number = int(room.pop("force_next_number"))
        if number < 0 or number > 36:
            number = random.choice(_roulette_candidates_for_luck(room))
    else:
        number = random.choice(_roulette_candidates_for_luck(room))
    color = roulette_color(number)
    room["roulette_last_result"] = {"number": number, "color": color, "ts": int(time.time() * 1000)}
    room["roulette_phase"] = "RESULT"

    for p in list(active_players(room)):
        bets = list(roulette_player_bets(room, p["id"]))
        if not bets or p["id"] in room["roulette_settled"]:
            continue

        account = ACCOUNTS.get(p.get("username_key"))
        total_return = 0
        winning = False
        win_profit = 0

        mult = 2 if room.get("double_cash") else 1
        for b in bets:
            if roulette_bet_wins(b, number):
                winning = True
                payout = roulette_bet_payout(b["type"])
                # double_cash multiplies total return (stake + profit)
                ret = int(b["amount"]) * (payout + 1) * mult
                total_return += ret
                win_profit += ret - int(b["amount"])

        p["money"] += total_return
        room["roulette_settled"].add(p["id"])
        # Clear settled bets immediately so a disconnect cannot refund a wager
        # that has already been settled.
        room["roulette_bets"][p["id"]] = []

        if account is not None:
            ensure_account_progress(account)
            account["roulette_games"] = int(account.get("roulette_games", 0)) + 1
            account["games_played"] = int(account.get("games_played", 0)) + 1
            rs = account.setdefault("game_stats", {}).setdefault("roulette", {"games": 0, "wins": 0})
            rs["games"] = account["roulette_games"]

            if winning:
                account["roulette_wins"] = int(account.get("roulette_wins", 0)) + 1
                account["wins"] = int(account.get("wins", 0)) + 1
                rs["wins"] = account["roulette_wins"]
                account["roulette_biggest_win"] = max(int(account.get("roulette_biggest_win", 0)), win_profit)
                account["biggest_win"] = max(int(account.get("biggest_win", 0)), win_profit)
                add_xp(account, 20)
                account["season_xp"] = int(account.get("season_xp", 0)) + 20
                update_daily_progress(account, "win")
            else:
                account["losses"] = int(account.get("losses", 0)) + 1
                add_xp(account, 5)
                account["season_xp"] = int(account.get("season_xp", 0)) + 5
                update_daily_progress(account, "lose")
            persist_player_money(p)
        p["roulette_last_profit"] = win_profit

    await roulette_broadcast(room)
    await asyncio.sleep(3.5)
    room["roulette_bets"] = {}
    room["roulette_settled"] = set()
    room["roulette_phase"] = "BETTING"
    await roulette_broadcast(room)

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
            game=str(msg.get("game", "all")).lower()
            tables=public_tables_payload()
            if game in ("blackjack","roulette"): tables=[t for t in tables if t.get("game")==game]
            await websocket.send(json.dumps({"type":"public_tables","tables":tables,"game":game}))
            continue

        if kind == "create_public":
            token = msg.get("token")
            key = TOKENS.get(token)
            if key not in ACCOUNTS:
                await websocket.send(json.dumps({"type":"error","message":"Please log in first."}))
                continue
            code = random_room_code()
            game = str(msg.get("game", "blackjack")).lower()
            if game not in ("blackjack", "roulette"): game = "blackjack"
            max_players = msg.get("maxPlayers", MAX_PLAYERS_DEFAULT)
            get_room(code, public=True, game=game, max_players=max_players)
            await websocket.send(json.dumps({"type":"public_created","code":code,"game":game,"maxPlayers":rooms[code].get("max_players", MAX_PLAYERS_DEFAULT)}))
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
                    await target_ws.send(json.dumps({
                        "type": "table_invite",
                        "from": ACCOUNTS[key]["username"],
                        "room": room["code"],
                        "game": room.get("game", "blackjack"),
                    }))
                    await websocket.send(json.dumps({"type": "info", "message": f"Invite sent to {msg.get('username')}"}))
                else:
                    await websocket.send(json.dumps({"type":"error","scope":"friends","message":"That friend is offline."}))
            continue

        if kind == "set_avatar":
            key = TOKENS.get(msg.get("token"))
            account = ACCOUNTS.get(key)
            if account is not None:
                avatar = msg.get("avatar")  # data URL or preset id or null
                color = msg.get("color")
                if avatar is None or avatar == "" or avatar == "reset":
                    account["avatar"] = None
                elif isinstance(avatar, str) and len(avatar) < 400_000:
                    # Allow data URLs and short preset ids
                    account["avatar"] = avatar
                if isinstance(color, str) and color.startswith("#") and len(color) <= 9:
                    account["avatar_color"] = color
                save_accounts()
                # Sync to seated player objects
                for r in rooms.values():
                    for p in r.get("players", []):
                        if p.get("username_key") == key:
                            p["avatar"] = account.get("avatar")
                            p["avatar_color"] = account.get("avatar_color")
                await websocket.send(json.dumps({"type": "profile", "profile": profile_payload(account)}))
            continue

        if kind == "chat":
            if room is not None and player is not None:
                text = chat_clean(msg.get("text"))
                if text:
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

        if kind == "store":
            key = TOKENS.get(msg.get("token"))
            if key in ACCOUNTS:
                await websocket.send(json.dumps({"type":"store", "store":store_payload(ACCOUNTS[key])}))
            continue

        if kind == "season":
            key = TOKENS.get(msg.get("token"))
            if key in ACCOUNTS:
                await websocket.send(json.dumps({"type":"season", "season":season_payload(ACCOUNTS[key])}))
            continue

        if kind == "buy_cosmetic":
            key=TOKENS.get(msg.get("token")); account=ACCOUNTS.get(key); category=str(msg.get("category","")); item_id=str(msg.get("id",""))
            catalogs={"theme":COSMETIC_THEMES,"chip":COSMETIC_CHIPS,"deck":COSMETIC_DECKS,"table":COSMETIC_TABLES,"ball":COSMETIC_BALLS}
            owned_keys={"theme":"owned_themes","chip":"owned_chips","deck":"owned_decks","table":"owned_tables","ball":"owned_balls"}
            catalog=catalogs.get(category,{}); owned_key=owned_keys.get(category)
            if account is not None and owned_key and item_id in catalog:
                item=catalog[item_id]; owned=set(account.get(owned_key,[]))
                if item_id in owned: await websocket.send(json.dumps({"type":"store","store":store_payload(account)}))
                elif item.get("admin_only"): await websocket.send(json.dumps({"type":"error","scope":"store","message":"That item can only be granted by an authorized admin."}))
                elif item.get("limited"): await websocket.send(json.dumps({"type":"error","scope":"store","message":"Limited items are earned through the active season."}))
                elif int(account.get("money",0)) < int(item.get("price",0)): await websocket.send(json.dumps({"type":"error","scope":"store","message":"Not enough chips."}))
                else:
                    account["money"]-=int(item.get("price",0)); owned.add(item_id); account[owned_key]=sorted(owned); save_accounts()
                    await websocket.send(json.dumps({"type":"store","store":store_payload(account),"purchased":item_id}))
                    await websocket.send(json.dumps({"type":"profile","profile":profile_payload(account)}))
                    await websocket.send(json.dumps({"type":"balance","balance":int(account.get("money",0))}))
            continue

        if kind == "equip_cosmetic":
            key=TOKENS.get(msg.get("token")); account=ACCOUNTS.get(key); category=str(msg.get("category","")); item_id=str(msg.get("id",""))
            catalogs={"theme":COSMETIC_THEMES,"chip":COSMETIC_CHIPS,"deck":COSMETIC_DECKS,"table":COSMETIC_TABLES,"ball":COSMETIC_BALLS}
            owned_keys={"theme":"owned_themes","chip":"owned_chips","deck":"owned_decks","table":"owned_tables","ball":"owned_balls"}
            equipped_keys={"theme":"equipped_theme","chip":"equipped_chip","deck":"equipped_deck","table":"equipped_table","ball":"equipped_ball"}
            if account is not None and category in catalogs and item_id in catalogs[category] and item_id in set(account.get(owned_keys[category],[])):
                account[equipped_keys[category]]=item_id; save_accounts()
                for r in rooms.values():
                    for p in r.get("players",[]):
                        if p.get("username_key")==key: p.setdefault("cosmetics",{})[category]=item_id
                await websocket.send(json.dumps({"type":"store","store":store_payload(account),"equipped":item_id}))
                await websocket.send(json.dumps({"type":"profile","profile":profile_payload(account)}))
                for r in rooms.values():
                    if any(p.get("username_key")==key for p in r.get("players",[])):
                        await (roulette_broadcast(r) if r.get("game")=="roulette" else broadcast(r))
            continue

        if kind == "claim_season":
            key = TOKENS.get(msg.get("token")); account = ACCOUNTS.get(key)
            tier_id = str(msg.get("tier"))
            if account is not None:
                match = next((t for t in SEASON["tiers"] if str(t["tier"])==tier_id), None)
                claimed=set(account.get("season_claimed",[]))
                if not season_active() or not match or tier_id in claimed or int(account.get("season_xp",0)) < int(match["xp"]):
                    await websocket.send(json.dumps({"type":"error","scope":"season","message":"That reward is not available."}))
                else:
                    r=match["reward"]
                    if r["type"]=="chips": account["money"] += int(r["amount"])
                    elif r["type"]=="chip": account["owned_chips"] = sorted(set(account.get("owned_chips",[])) | {r["id"]})
                    elif r["type"]=="theme": account["owned_themes"] = sorted(set(account.get("owned_themes",[])) | {r["id"]})
                    elif r["type"]=="deck": account["owned_decks"] = sorted(set(account.get("owned_decks",[])) | {r["id"]})
                    elif r["type"]=="table": account["owned_tables"] = sorted(set(account.get("owned_tables",[])) | {r["id"]})
                    elif r["type"]=="ball": account["owned_balls"] = sorted(set(account.get("owned_balls",[])) | {r["id"]})
                    elif r["type"]=="title": account["season_title"] = r["name"]
                    claimed.add(tier_id); account["season_claimed"]=sorted(claimed); save_accounts()
                    await websocket.send(json.dumps({"type":"season","season":season_payload(account),"profile":profile_payload(account),"claimedTier":int(tier_id)}))
            continue

        if kind == "join":
            token = msg.get("token")
            account_key = TOKENS.get(token)
            if not account_key or account_key not in ACCOUNTS:
                await websocket.send(json.dumps({"type": "error", "scope": "auth", "message": "Please log in first."}))
                continue
            code = (msg.get("room") or "PUBLIC").strip().upper()[:12] or "PUBLIC"
            game = str(msg.get("game", "blackjack")).lower()
            if game not in ("blackjack", "roulette"):
                game = "blackjack"
            spectate = bool(msg.get("spectate"))
            if spectate and code not in rooms:
                await websocket.send(json.dumps({"type":"error","message":"That table does not exist."}))
                room = None
                continue
            room = get_room(code, game=game)
            if room.get("game") != game:
                await websocket.send(json.dumps({"type":"error","scope":"table","message":"That table belongs to another game."})); room=None; continue
            if spectate and not room.get("players"):
                await websocket.send(json.dumps({"type":"error","message":"There is nobody to spectate yet."}))
                room = None
                continue
            if account_key in room.get("kicked", []):
                await websocket.send(json.dumps({"type": "error", "message": "You were kicked from this table. Create/use another table."}))
                room = None
                continue
            connected_count = sum(1 for p in room["players"] if p["connected"] and not p.get("spectator"))
            max_p = int(room.get("max_players", MAX_PLAYERS_DEFAULT))
            if not spectate and connected_count >= max_p:
                await websocket.send(json.dumps({"type": "error", "message": "Table is full."}))
                room = None
                continue

            pid = new_id()
            account = ACCOUNTS[account_key]
            ensure_account_progress(account)

            # Auto-leave any existing seat for this account (fixes ghost "already present" after leave/UI race)
            for code_old, r_old in list(rooms.items()):
                for p_old in list(r_old.get("players", [])):
                    if p_old.get("username_key") != account_key:
                        continue
                    # Refund roulette stakes if any
                    if r_old.get("game") == "roulette":
                        refund = sum(int(b["amount"]) for b in r_old.get("roulette_bets", {}).get(p_old["id"], []))
                        if refund:
                            p_old["money"] = int(p_old.get("money", 0)) + refund
                            persist_player_money(p_old)
                        r_old.get("roulette_bets", {}).pop(p_old["id"], None)
                    was_host_old = r_old.get("host_id") == p_old.get("id")
                    was_active_old = r_old.get("active_player_id") == p_old.get("id")
                    try:
                        r_old["players"].remove(p_old)
                    except ValueError:
                        pass
                    if not r_old["players"]:
                        _cancel(r_old, "_ready_task")
                        _cancel(r_old, "_round_task")
                        rt = r_old.get("roulette_task")
                        if rt and not rt.done():
                            rt.cancel()
                        rooms.pop(code_old, None)
                    else:
                        if was_host_old:
                            r_old["host_id"] = r_old["players"][0]["id"]
                        if was_active_old and r_old.get("game") != "roulette":
                            r_old["active_player_id"] = None
                            try:
                                await move_to_next_or_dealer(r_old)
                            except Exception:
                                pass
                        else:
                            await (roulette_broadcast(r_old) if r_old.get("game") == "roulette" else broadcast(r_old))

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
                "cosmetics":{"theme":account.get("equipped_theme","classic"),"chip":account.get("equipped_chip","classic"),
                             "deck":account.get("equipped_deck","classic"),"table":account.get("equipped_table","classic"),
                             "ball":account.get("equipped_ball","classic")},
                "avatar": account.get("avatar"),
                "avatar_color": account.get("avatar_color"),
                "friendBoost": 0,
            }
            if room.get("host_id") is None:
                room["host_id"] = pid
            room["players"].append(player)
            invalidate_dealer_preview(room)
            if room["phase"] == "LOBBY":
                room["phase"] = "BETTING"

            await websocket.send(json.dumps({"type": "joined", "id": pid, "room": code, "game": room.get("game","blackjack"), "username": account["username"], "balance": player["money"], "isHost": room["host_id"] == pid}))
            await broadcast(room)
            if room.get("game")=="roulette": await roulette_broadcast(room)
            await broadcast_public_tables()
            continue


        if kind == "roulette_state":
            if room and player and room.get("game") == "roulette":
                await roulette_broadcast(room)
            continue

        if kind == "roulette_bet":
            if room is None or player is None or room.get("game") != "roulette" or room.get("roulette_phase") != "BETTING":
                continue
            bet_type = str(msg.get("betType", "")).strip().lower()
            try:
                amount = int(msg.get("amount", 0))
            except (TypeError, ValueError):
                amount = 0
            value = msg.get("value")
            allowed_bets = {"straight","red","black","odd","even","low","high","dozen1","dozen2","dozen3"}
            MAX_ROULETTE_BET = 100_000
            if bet_type not in allowed_bets or amount <= 0 or amount > MAX_ROULETTE_BET or amount > int(player.get("money", 0)):
                await websocket.send(json.dumps({"type":"error","scope":"roulette","message":"Invalid Roulette bet, limit, or insufficient chips."}))
                continue
            if bet_type == "straight":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    value = -1
                if value < 0 or value > 36:
                    await websocket.send(json.dumps({"type":"error","scope":"roulette","message":"Straight bets must be 0–36."}))
                    continue
            else:
                value = None
            player["money"] -= amount
            roulette_player_bets(room, player["id"]).append({"type":bet_type,"value":value,"amount":amount})
            persist_player_money(player)
            await roulette_broadcast(room)
            continue

        if kind == "roulette_clear":
            if room and player and room.get("game")=="roulette" and room.get("roulette_phase")=="BETTING":
                bets=roulette_player_bets(room,player["id"]); refund=sum(int(b["amount"]) for b in bets)
                player["money"]+=refund; room["roulette_bets"][player["id"]]=[]; persist_player_money(player); await roulette_broadcast(room)
            continue

        if kind == "roulette_spin":
            if room and player and room.get("game")=="roulette" and room.get("roulette_phase")=="BETTING":
                if room.get("host_id") == player.get("id") and room.get("roulette_task") is None:
                    task = asyncio.create_task(roulette_spin(room))
                    room["roulette_task"] = task
                    def _clear_roulette_task(done_task, r=room):
                        if r.get("roulette_task") is done_task:
                            r["roulette_task"] = None
                    task.add_done_callback(_clear_roulette_task)
                else:
                    await websocket.send(json.dumps({"type":"error","scope":"roulette","message":"Only the table host can spin the wheel."}))
            continue

        if kind == "admin_login":
            password = msg.get("password") or ""
            if not room or not player:
                await websocket.send(json.dumps({"type": "error", "scope": "admin", "message": "Admin controls are only available inside a game table."}))
                continue
            if ADMIN_PASSWORD and hmac.compare_digest(password, ADMIN_PASSWORD):
                ADMIN_SOCKETS.add(websocket)
                await websocket.send(json.dumps({"type": "admin_ok"}))
                await send_admin_data(websocket, room)
            else:
                await websocket.send(json.dumps({"type": "error", "scope": "admin", "message": "Incorrect admin password."}))
            continue

        if kind == "leave_table":
            ADMIN_SOCKETS.discard(websocket)
            if player and room:
                leaving_id = player["id"]
                was_active = room["active_player_id"] == leaving_id
                was_host = room.get("host_id") == leaving_id
                if room.get("game")=="roulette":
                    refund=sum(int(b["amount"]) for b in room.get("roulette_bets",{}).get(leaving_id,[]))
                    if refund:
                        player["money"] += refund
                        persist_player_money(player)
                    room.get("roulette_bets",{}).pop(leaving_id,None)
                invalidate_dealer_preview(room)
                try:
                    room["players"].remove(player)
                except ValueError:
                    pass
                player = None
                if room.get("game")=="roulette" and not room["players"]:
                    task=room.get("roulette_task")
                    if task and not task.done(): task.cancel()
                room = None if delete_room_if_empty(room) else room
                if room:
                    if was_host:
                        room["host_id"] = room["players"][0]["id"] if room["players"] else None
                    if was_active:
                        room["active_player_id"] = None
                        if room.get("game") != "roulette":
                            await move_to_next_or_dealer(room)
                    await broadcast(room)
            await broadcast_public_tables()
            await websocket.send(json.dumps({"type":"left_table"}))
            await send_admin_data(websocket, room)
            continue

        if room is None or player is None:
            continue
        if room.get("game") == "roulette":
            if kind == "refresh_balance":
                account = ACCOUNTS.get(player.get("username_key"))
                if account:
                    player["money"] = int(account.get("money", 0))
                    await websocket.send(json.dumps({"type":"balance","balance":player["money"]}))
                    await websocket.send(json.dumps({"type":"profile","profile":profile_payload(account)}))
                    await roulette_broadcast(room)
                continue
            if kind == "kick" and room.get("host_id") == player.get("id"):
                target = find_player(room, msg.get("targetId"))
                if target and target.get("id") != player.get("id"):
                    target_ws = target.get("ws")
                    try:
                        await target_ws.send(json.dumps({"type":"kicked","message":"The host removed you from this table."}))
                        await target_ws.close()
                    except Exception:
                        pass
                continue
            if not kind.startswith("admin_"):
                # Other Blackjack actions do not apply to Roulette.
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
            # Refund any pending roulette bets for the kicked player
            if room.get("game") == "roulette":
                refund = sum(int(b["amount"]) for b in room.get("roulette_bets", {}).get(target["id"], []))
                if refund:
                    target["money"] += refund
                    persist_player_money(target)
                room.get("roulette_bets", {}).pop(target["id"], None)
            target_ws = target.get("ws")
            try:
                if target_ws:
                    await target_ws.send(json.dumps({"type": "kicked", "message": "The host removed you from this table."}))
                    await target_ws.close()
            except Exception:
                pass
            try:
                room["players"].remove(target)
            except ValueError:
                pass
            await broadcast(room)
            await broadcast_public_tables()

        elif kind == "transfer_host":
            if room.get("host_id") != player["id"]:
                continue
            target = find_player(room, msg.get("targetId"))
            if not target or target.get("id") == player["id"] or target.get("spectator"):
                continue
            room["host_id"] = target["id"]
            await broadcast(room)
            await websocket.send(json.dumps({"type": "info", "message": f"Host transferred to {target.get('username', 'player')}."}))

        elif kind == "toggle_double_cash":
            if room.get("host_id") != player["id"] and not is_authorized_admin(websocket, room, player):
                continue
            room["double_cash"] = not bool(room.get("double_cash"))
            await broadcast(room)
            await broadcast_public_tables()

        elif kind == "admin_data":
            await send_admin_data(websocket, room)

        elif kind == "admin_give_table_money":
            if not is_authorized_admin(websocket, room, player):
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
            if not is_authorized_admin(websocket, room, player):
                continue
            target = find_player(room, msg.get("targetId"))
            if not target:
                continue
            enabled = bool(msg.get("enabled"))
            key = target.get("username_key")
            luck_map = room.setdefault("lucky_players", {})
            if enabled:
                luck_map[key] = 50
                room.setdefault("roulette_player_luck", {})[key] = 50
            else:
                luck_map.pop(key, None)
                room.setdefault("roulette_player_luck", {}).pop(key, None)
            await broadcast(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_toggle_preview":
            if not is_authorized_admin(websocket, room, player):
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

        elif kind == "admin_set_roulette_luck":
            if not is_authorized_admin(websocket, room, player):
                continue
            target_id = msg.get("targetId")
            try:
                strength = int(msg.get("strength", 0))
            except (TypeError, ValueError):
                strength = -1
            if strength < 0 or strength > 100:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Luck strength must be 0–100."}))
                continue
            target = find_player(room, target_id)
            if not target:
                continue
            room.setdefault("roulette_player_luck", {})[target["username_key"]] = strength
            if strength:
                room.setdefault("lucky_players", {})[target["username_key"]] = strength
            else:
                room.setdefault("lucky_players", {}).pop(target["username_key"], None)
            await send_admin_data(websocket, room)

        elif kind == "admin_set_table_luck":
            if not is_authorized_admin(websocket, room, player):
                continue
            try:
                strength = int(msg.get("strength", 0))
                duration = int(msg.get("duration", 300))
            except (TypeError, ValueError):
                strength, duration = -1, 0
            if strength < 0 or strength > 100 or duration < 10 or duration > 3600:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Table luck must be 0–100 and last 10–3600 seconds."}))
                continue
            room["roulette_table_luck"] = {"strength": strength, "expires_at": time.time() + duration if strength else 0}
            await send_admin_data(websocket, room)

        elif kind == "admin_give_season_xp":
            if not is_authorized_admin(websocket, room, player):
                continue
            target = find_player(room, msg.get("targetId"))
            try:
                amount = int(msg.get("amount", 0))
            except (TypeError, ValueError):
                amount = 0
            if not target or amount <= 0 or amount > 1_000_000:
                continue
            account = ACCOUNTS.get(target.get("username_key"))
            if account:
                account["season_xp"] = int(account.get("season_xp", 0)) + amount
                save_accounts()
                await websocket.send(json.dumps({"type":"season","season":season_payload(account),"profile":profile_payload(account)}))
                await send_admin_data(websocket, room)

        elif kind == "admin_claim_season_reward":
            if not is_authorized_admin(websocket, room, player):
                continue
            target = find_player(room, msg.get("targetId"))
            try:
                tier_id = int(msg.get("tier"))
            except (TypeError, ValueError):
                tier_id = 0
            account = ACCOUNTS.get(target.get("username_key")) if target else None
            match = next((t for t in SEASON["tiers"] if int(t["tier"]) == tier_id), None)
            if not account or not match:
                continue
            claimed=set(account.get("season_claimed", []))
            key=str(tier_id)
            if key in claimed:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"That season reward is already claimed."}))
                continue
            r=match["reward"]
            if r["type"]=="chips": account["money"] += int(r["amount"])
            elif r["type"]=="chip": account["owned_chips"] = sorted(set(account.get("owned_chips",[])) | {r["id"]})
            elif r["type"]=="theme": account["owned_themes"] = sorted(set(account.get("owned_themes",[])) | {r["id"]})
            elif r["type"]=="deck": account["owned_decks"] = sorted(set(account.get("owned_decks",[])) | {r["id"]})
            elif r["type"]=="table": account["owned_tables"] = sorted(set(account.get("owned_tables",[])) | {r["id"]})
            elif r["type"]=="ball": account["owned_balls"] = sorted(set(account.get("owned_balls",[])) | {r["id"]})
            elif r["type"]=="title": account["season_title"] = r["name"]
            claimed.add(key); account["season_claimed"]=sorted(claimed); save_accounts()
            await websocket.send(json.dumps({"type":"season","season":season_payload(account),"profile":profile_payload(account)}))
            await send_admin_data(websocket, room)

        elif kind == "admin_give_item":
            if not is_authorized_admin(websocket, room, player):
                continue
            target = find_player(room, msg.get("targetId"))
            item_id = str(msg.get("itemId", ""))
            item_catalog = {
                "admin_star": {"name":"ADMIN STAR","category":"theme"},
                "admin_chip": {"name":"ADMIN CHIP","category":"chip"},
            }
            item = item_catalog.get(item_id)
            if not target or not item:
                continue
            account = ACCOUNTS.get(target.get("username_key"))
            if account:
                owned_key = "owned_themes" if item["category"] == "theme" else "owned_chips"
                account[owned_key] = sorted(set(account.get(owned_key, [])) | {item_id})
                save_accounts()
                await websocket.send(json.dumps({"type":"store","store":store_payload(account)}))
                await send_admin_data(websocket, room)

        elif kind == "admin_fun":
            if not is_authorized_admin(websocket, room, player) or not room:
                continue
            action = str(msg.get("action", ""))
            banner = None
            if action == "double_cash":
                room["double_cash"] = not bool(room.get("double_cash"))
                banner = "2× CASH " + ("ON" if room["double_cash"] else "OFF")
            elif action == "rain_money":
                for p in active_players(room):
                    p["money"] = int(p.get("money", 0)) + 500
                    persist_player_money(p)
                banner = "CHIP RAIN +$500"
            elif action == "season_xp":
                for p in active_players(room):
                    acc = ACCOUNTS.get(p.get("username_key"))
                    if acc:
                        ensure_account_progress(acc)
                        acc["season_xp"] = int(acc.get("season_xp", 0)) + 100
                        add_xp(acc, 10)
                save_accounts()
                banner = "+100 SEASON XP"
            elif action == "refill_shoe":
                room["deck"] = fresh_shoe()
                banner = "SHOE REFILLED"
            elif action == "chaos_bets":
                # Shorten or extend roulette bet window feel via table luck flag
                room["chaos_bets"] = not bool(room.get("chaos_bets"))
                banner = "CHAOS BETS " + ("ON" if room["chaos_bets"] else "OFF")
            elif action == "force_zero":
                room["force_next_number"] = 0
                banner = "NEXT SPIN → 0"
            elif action == "bias_red":
                room["roulette_table_luck"] = {"strength": 80, "expires_at": time.time() + 120, "bias": "red"}
                banner = "RED BIAS 2 MIN"
            elif action == "clear_luck":
                room["roulette_table_luck"] = {"strength": 0, "expires_at": 0}
                room.pop("force_next_number", None)
                room["lucky_players"] = {}
                room["roulette_player_luck"] = {}
                banner = "LUCK CLEARED"
            if banner:
                # Notify everyone at the table
                note = json.dumps({"type": "info", "message": "ADMIN: " + banner})
                for p in room.get("players", []):
                    ws = p.get("ws")
                    if ws:
                        try:
                            await ws.send(note)
                        except Exception:
                            pass
                if room.get("game") == "roulette":
                    await roulette_broadcast(room)
                else:
                    await broadcast(room)
                await broadcast_public_tables()
                await send_admin_data(websocket, room)

        elif kind == "admin_add_money":
            # Backward-compatible account-wide command.
            if not is_authorized_admin(websocket, room, player):
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
            if not is_authorized_admin(websocket, room, player):
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
            if not is_authorized_admin(websocket, room, player):
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
    # Never leave staked Roulette chips stranded when a browser/tab drops.
    if player and room:
        leaving_id = player["id"]
        was_active = room["active_player_id"] == leaving_id
        was_host = room.get("host_id") == leaving_id
        if room.get("game") == "roulette":
            refund = sum(int(b["amount"]) for b in room.get("roulette_bets", {}).get(leaving_id, []))
            if refund:
                player["money"] += refund
                persist_player_money(player)
            room.get("roulette_bets", {}).pop(leaving_id, None)
        try:
            room["players"].remove(player)
        except ValueError:
            pass

        if not room["players"]:
            _cancel(room, "_ready_task")
            _cancel(room, "_round_task")
            roulette_task = room.get("roulette_task")
            if roulette_task and not roulette_task.done():
                roulette_task.cancel()
            rooms.pop(room["code"], None)
        else:
            if was_host:
                room["host_id"] = room["players"][0]["id"]
            if was_active:
                room["active_player_id"] = None
                if room.get("game") != "roulette":
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

    if request.path == "/ads.txt":
        body = b"google.com, pub-4526604443102763, DIRECT, f08c47fec0942fa0\n"
        return Response(200, "OK", Headers({
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": str(len(body)),
        }), body)

    return None

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
