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
DEVELOPER_SETTINGS_FILE = pathlib.Path(__file__).parent / "developer_settings.json"
DEV_UI_TARGETS = {
    "updateLog": "#btn-update-log",
    "storeButton": "#btn-store",
    "settingsButton": "#btn-settings",
    "hostButton": "#btn-host",
    "adminTableButton": "#btn-admin-table",
    "adminFloatButton": "#btn-admin-float",
    "pokerAdminButton": "#poker-admin",
    "shoe": "#shoe",
    "mobileModeToggle": "#toggle-mobile",
    "chatButton": "#btn-chat-open",
    "historyButton": "#btn-history-open",
    "storeHeroBrowse": "#store-hero-browse-main",
    "storeOwnedToggle": "#store-owned-toggle",
}
DEFAULT_DEVELOPER_SETTINGS = {
    "catalog_overrides": {},
    "vip_price": 250_000_000,
    "ui_layout": {k: {"desktop": {"x": 0, "y": 0, "scale": 1.0}, "mobile": {"x": 0, "y": 0, "scale": 1.0}} for k in DEV_UI_TARGETS},
    "feature_flags": {"store_redesign": True, "store_purchase_preview": True, "developer_controls": True},
    "custom_ui": {},
}
DEVELOPER_SETTINGS = {}

MAX_PLAYERS_DEFAULT = 5
MAX_PLAYERS_HARD_CAP = 10
READY_GRACE_S = 0.8      # small pause after last player hits ready before dealing
ROUND_OVER_S = 4.5       # results screen duration before next betting phase
POKER_MAX_PLAYERS = 6
POKER_MIN_PLAYERS = 2
POKER_SMALL_BLIND = 25
POKER_BIG_BLIND = 50
POKER_DEFAULT_BUYIN = 1000  # legacy only — buy-in removed; full balance is used
POKER_MIN_BUYIN = 200
POKER_MAX_BUYIN = 50000
POKER_ACTION_TIMEOUT_S = 30
POKER_BOT_ACTION_DELAY = (0.9, 2.2)  # min/max seconds before a bot acts
POKER_BETWEEN_HANDS_S = 5.0  # pause after each hand before host can start next
POKER_BOT_STARTING_CHIPS = 5000

BOT_NAME_POOL = [
    "AceBot", "ChipRunner", "RiverShark", "BluffKing", "PotOdds",
    "FoldMaster", "AllInAnnie", "TightTony", "LooseLucy", "CallStation",
    "NitBot", "ManiacMax", "CoolerCarl", "SuitsSam", "NutsNora",
]

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
PRESENCE_LAST = {"online": 0, "playing": 0}

def presence_payload():
    online = len(USER_SOCKETS)
    playing = 0
    for room in rooms.values():
        for p in room.get("players", []):
            if p.get("connected") and not p.get("spectator"):
                playing += 1
    return {"type": "presence", "online": online, "playing": playing}

async def broadcast_presence():
    payload = json.dumps(presence_payload())
    for ws in list(USER_SOCKETS.values()):
        try:
            await ws.send(payload)
        except Exception:
            pass

def leaderboard_playtime_payload(limit=20):
    rows = []
    for key, acc in ACCOUNTS.items():
        if acc.get("banned"):
            continue
        rows.append({
            "username": acc.get("username"),
            "playSeconds": int(acc.get("play_seconds", 0) or 0),
            "level": account_level(int(acc.get("xp", 0)))[0],
            "avatar": acc.get("avatar"),
            "avatarColor": acc.get("avatar_color"),
        })
    rows.sort(key=lambda r: (-r["playSeconds"], r["username"].lower()))
    return rows[:limit]

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

def save_developer_settings():
    try:
        payload = json.dumps(DEVELOPER_SETTINGS, indent=2)
        tmp = DEVELOPER_SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(DEVELOPER_SETTINGS_FILE)
    except Exception as exc:
        print(f"Warning: could not save developer settings: {exc}")

def load_developer_settings():
    global DEVELOPER_SETTINGS
    data = {}
    try:
        if DEVELOPER_SETTINGS_FILE.exists():
            data = json.loads(DEVELOPER_SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    merged = json.loads(json.dumps(DEFAULT_DEVELOPER_SETTINGS))
    if isinstance(data, dict):
        merged.update({k:v for k,v in data.items() if k in merged})
        merged["catalog_overrides"] = data.get("catalog_overrides", {}) if isinstance(data.get("catalog_overrides", {}), dict) else {}
        merged["ui_layout"] = data.get("ui_layout", {}) if isinstance(data.get("ui_layout", {}), dict) else {}
        merged["feature_flags"] = {**DEFAULT_DEVELOPER_SETTINGS["feature_flags"], **(data.get("feature_flags", {}) if isinstance(data.get("feature_flags", {}), dict) else {})}
        merged["custom_ui"] = data.get("custom_ui", {}) if isinstance(data.get("custom_ui", {}), dict) else {}
    for key, default in DEFAULT_DEVELOPER_SETTINGS["ui_layout"].items():
        cur = merged["ui_layout"].get(key, {}) if isinstance(merged["ui_layout"].get(key, {}), dict) else {}
        for mode in ("desktop", "mobile"):
            cur.setdefault(mode, dict(default[mode]))
            for fld, dv in default[mode].items():
                try: cur[mode][fld] = float(cur[mode].get(fld, dv))
                except Exception: cur[mode][fld] = dv
        merged["ui_layout"][key] = cur
    try: merged["vip_price"] = max(1_000_000, int(merged.get("vip_price", VIP_PRICE)))
    except Exception: merged["vip_price"] = VIP_PRICE
    DEVELOPER_SETTINGS = merged

def developer_public_payload():
    return {
        "uiLayout": DEVELOPER_SETTINGS.get("ui_layout", {}),
        "featureFlags": DEVELOPER_SETTINGS.get("feature_flags", {}),
        "vipPrice": int(DEVELOPER_SETTINGS.get("vip_price", VIP_PRICE)),
        "customUi": DEVELOPER_SETTINGS.get("custom_ui", {}),
    }

def developer_admin_payload():
    return {
        **developer_public_payload(),
        "uiTargets": DEV_UI_TARGETS,
        "catalogOverrides": DEVELOPER_SETTINGS.get("catalog_overrides", {}),
    }

def apply_catalog_override(category, item_id, patch):
    meta = STORE_CATALOGS.get(category)
    if not meta: return False
    catalog = meta[0]
    if item_id not in catalog: return False
    item = catalog[item_id]
    allowed = {"name", "price", "desc", "rarity", "admin_only", "vip_only", "limited", "season"}
    for k, v in (patch or {}).items():
        if k not in allowed: continue
        if k == "price":
            try: v = max(0, int(v))
            except Exception: continue
        elif k in {"admin_only", "vip_only", "limited"}:
            v = bool(v)
        elif k == "season":
            try: v = None if v in (None, "", "null") else int(v)
            except Exception: continue
        elif k == "rarity":
            v = str(v).upper()[:24]
        elif k in {"name", "desc"}:
            v = str(v)[:120]
        item[k] = v
    return True

def apply_all_catalog_overrides():
    for key, patch in DEVELOPER_SETTINGS.get("catalog_overrides", {}).items():
        if not isinstance(patch, dict) or ":" not in key: continue
        category, item_id = key.split(":", 1)
        apply_catalog_override(category, item_id, patch)

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
    "classic":{"name":"Classic Noir","price":0,"rarity":"COMMON","desc":"The original Casino X dark felt.","season":None,"limited":False,"scope":"GLOBAL"},
    "midnight":{"name":"Midnight Velvet","price":12000,"rarity":"UNCOMMON","desc":"Deep indigo panels with soft glow.","season":None,"limited":False,"scope":"GLOBAL"},
    "emerald":{"name":"Emerald Lounge","price":18000,"rarity":"UNCOMMON","desc":"Rich green casino ambience.","season":None,"limited":False,"scope":"GLOBAL"},
    "royal":{"name":"Royal Eclipse","price":25000,"rarity":"RARE","desc":"Purple-black royal treatment.","season":None,"limited":False,"scope":"GLOBAL"},
    "neon":{"name":"Neon Afterdark","price":40000,"rarity":"RARE","desc":"Electric neon outlines and pulse.","season":None,"limited":False,"scope":"GLOBAL"},
    "crimson":{"name":"Crimson Royale","price":55000,"rarity":"EPIC","desc":"Blood-red felt with gold accents.","season":None,"limited":False,"scope":"GLOBAL"},
    "golden":{"name":"Golden 1927","price":90000,"rarity":"EPIC","desc":"Art-deco gold and brass elegance.","season":None,"limited":False,"scope":"GLOBAL"},
    "celestial":{"name":"Celestial Casino","price":150000,"rarity":"LEGENDARY","desc":"Starfield background and cosmic glow.","season":None,"limited":False,"scope":"GLOBAL"},
    "casino1927":{"name":"Casino X: 1927","price":0,"rarity":"LEGENDARY","desc":"Season theme — Golden Age of the House.","season":1,"limited":True,"scope":"GLOBAL"},
    "crimson_royale":{"name":"Crimson Royale","price":0,"rarity":"LEGENDARY","desc":"Season theme — red carpet high society.","season":2,"limited":True,"scope":"GLOBAL"},
    "admin_star":{"name":"Admin Star","price":0,"rarity":"ADMIN","desc":"Exclusive founder star theme.","season":None,"limited":False,"scope":"GLOBAL","admin_only":True},
    "admin_blackout":{"name":"Admin Blackout","price":0,"rarity":"ADMIN","desc":"Pure blackout exclusive for operators.","season":None,"limited":False,"scope":"GLOBAL","admin_only":True},
    "founder":{"name":"Casino X Founder","price":0,"rarity":"ADMIN","desc":"The ultimate exclusive founder look.","season":None,"limited":False,"scope":"GLOBAL","admin_only":True},
}
COSMETIC_CHIPS = {
    "classic":{"name":"Classic Chip","price":0,"rarity":"COMMON","desc":"Standard Casino X chip stack.","season":None,"limited":False,"scope":"GLOBAL"},
    "silver":{"name":"Silver Edge","price":8000,"rarity":"UNCOMMON","desc":"Polished silver edge chips.","season":None,"limited":False,"scope":"GLOBAL"},
    "emerald_chip":{"name":"Emerald Stack","price":14000,"rarity":"UNCOMMON","desc":"Green felt-matched chips.","season":None,"limited":False,"scope":"GLOBAL"},
    "gold":{"name":"Gold Crest","price":18000,"rarity":"RARE","desc":"Gold-rimmed high-roller chips.","season":None,"limited":False,"scope":"GLOBAL"},
    "diamond":{"name":"Black Diamond","price":45000,"rarity":"EPIC","desc":"Obsidian chips with diamond inlay.","season":None,"limited":False,"scope":"GLOBAL"},
    "royal_vault":{"name":"Royal Vault","price":80000,"rarity":"LEGENDARY","desc":"Vault-seal legendary chips.","season":None,"limited":False,"scope":"GLOBAL"},
    "casino1927":{"name":"1927 Brass Chip","price":0,"rarity":"LEGENDARY","desc":"Season brass chip design.","season":1,"limited":True,"scope":"GLOBAL"},
    "crimson_velvet":{"name":"Velvet Royale Chip","price":0,"rarity":"LEGENDARY","desc":"Crimson velvet edge seasonal chip.","season":2,"limited":True,"scope":"GLOBAL"},
    "admin_chip":{"name":"Admin Chip","price":0,"rarity":"ADMIN","desc":"Operator exclusive chip.","season":None,"limited":False,"scope":"GLOBAL","admin_only":True},
}
COSMETIC_DECKS = {
    "classic":{"name":"Classic Deck","price":0,"rarity":"COMMON","desc":"Standard playing cards.","season":None,"limited":False,"scope":"GLOBAL"},
    "midnight":{"name":"Midnight Deck","price":14000,"rarity":"UNCOMMON","desc":"Dark-backed midnight cards.","season":None,"limited":False,"scope":"GLOBAL"},
    "emerald_deck":{"name":"Emerald Cards","price":22000,"rarity":"RARE","desc":"Green-accent card faces.","season":None,"limited":False,"scope":"GLOBAL"},
    "crimson_deck":{"name":"Crimson Royale Cards","price":38000,"rarity":"EPIC","desc":"Deep red royal card backs.","season":None,"limited":False,"scope":"GLOBAL"},
    "celestial_deck":{"name":"Celestial Deck","price":70000,"rarity":"LEGENDARY","desc":"Star-pattern card backs.","season":None,"limited":False,"scope":"GLOBAL"},
    "casino1927":{"name":"1927 Art Deco Deck","price":0,"rarity":"LEGENDARY","desc":"Art-deco seasonal deck.","season":1,"limited":True,"scope":"GLOBAL"},
    "crimson_royale_deck":{"name":"Crimson Royale Deck","price":0,"rarity":"LEGENDARY","desc":"Formal crimson seasonal deck.","season":2,"limited":True,"scope":"GLOBAL"},
}
COSMETIC_TABLES = {
    "classic":{"name":"Classic Felt","price":0,"season":None,"limited":False,"scope":"GLOBAL"},
    "royal":{"name":"Royal Green Table","price":22000,"season":None,"limited":False,"scope":"GLOBAL"},
    "casino1927":{"name":"1927 Golden House Table","price":0,"rarity":"LEGENDARY","desc":"1927 golden house table.","season":1,"limited":True,"scope":"GLOBAL"},
    "crimson_table":{"name":"Crimson Royale Table","price":0,"rarity":"LEGENDARY","desc":"Crimson felt with ivory rail.","season":2,"limited":True,"scope":"GLOBAL"},
}
COSMETIC_BALLS = {
    "classic":{"name":"Classic Card Back","price":0,"season":None,"limited":False,"scope":"GLOBAL"},
    "brass1927":{"name":"1927 Brass Card Back","price":0,"rarity":"LEGENDARY","desc":"1927 brass card back.","season":1,"limited":True,"scope":"GLOBAL"},
    "crimson_back":{"name":"Crimson Seal Card Back","price":0,"rarity":"LEGENDARY","desc":"Crimson seal seasonal card back.","season":2,"limited":True,"scope":"GLOBAL"},
}
# Money-focused social/profile cosmetics. Prices are intentionally high so cash has a long-term sink.
PROFILE_FRAMES = {
    "classic": {"name":"Classic Frame","price":0,"rarity":"COMMON","desc":"The standard Casino X frame."},
    "silver": {"name":"Silver Edge Frame","price":10000,"rarity":"COMMON","desc":"Clean silver profile ring."},
    "gold": {"name":"Gold Crest Frame","price":50000,"rarity":"RARE","desc":"A polished high-roller crest."},
    "diamond": {"name":"Diamond Frame","price":250000,"rarity":"EPIC","desc":"Diamond-cut profile ring."},
    "crimson": {"name":"Crimson Royale Frame","price":1000000,"rarity":"LEGENDARY","desc":"Seasoned in crimson and gold."},
    "royal": {"name":"Royal Vault Frame","price":5000000,"rarity":"LEGENDARY","desc":"Made for the richest rooms."},
    "1927": {"name":"1927 Founder Frame","price":10000000,"rarity":"ULTRA","desc":"Art-deco brass for serious collectors."},
    "vip_crown": {"name":"VIP Crown Frame","price":0,"rarity":"VIP","desc":"Animated gold crown frame for VIP members.","vip_only":True},
}
PROFILE_BACKGROUNDS = {
    "classic": {"name":"Classic Noir Background","price":0,"rarity":"COMMON","desc":"The original dark Casino X profile."},
    "velvet": {"name":"Midnight Velvet Background","price":25000,"rarity":"UNCOMMON","desc":"Deep velvet with a soft casino glow."},
    "neon": {"name":"Neon Afterdark Background","price":75000,"rarity":"RARE","desc":"Electric city lights behind your profile."},
    "crimson": {"name":"Crimson Royale Background","price":250000,"rarity":"EPIC","desc":"Red carpet, dark glass, gold trim."},
    "vault": {"name":"Private Vault Background","price":1500000,"rarity":"LEGENDARY","desc":"Cold steel, gold and locked-room luxury."},
    "1927": {"name":"1927 Grand Lobby Background","price":5000000,"rarity":"LEGENDARY","desc":"Classic art-deco grandeur."},
    "vip_private": {"name":"VIP Private Lounge Background","price":0,"rarity":"VIP","desc":"A private velvet lounge reserved for VIP members.","vip_only":True},
}
PROFILE_TITLES = {
    "rookie": {"name":"ROOKIE","price":0,"rarity":"COMMON","desc":"The house welcomes you."},
    "card_shark": {"name":"CARD SHARK","price":50000,"rarity":"RARE","desc":"You know your way around the deck."},
    "high_roller": {"name":"HIGH ROLLER","price":250000,"rarity":"EPIC","desc":"The table notices when you arrive."},
    "vip": {"name":"VIP","price":1000000,"rarity":"LEGENDARY","desc":"Priority treatment. Big-money energy."},
    "whale": {"name":"WHALE","price":10000000,"rarity":"ULTRA","desc":"You play at a different scale."},
    "casino_royalty": {"name":"CASINO ROYALTY","price":100000000,"rarity":"ULTRA","desc":"The house knows your name."},
    "vip_member": {"name":"VIP MEMBER","price":0,"rarity":"VIP","desc":"Exclusive title unlocked by active VIP membership.","vip_only":True},
}
CASINO_ITEMS = {
    "classic_floor": {"name":"Classic Floor","price":0,"rarity":"COMMON","slot":"floor","desc":"The standard Casino X floor."},
    "classic_wall": {"name":"Classic Walls","price":0,"rarity":"COMMON","slot":"wall","desc":"The standard Casino X walls."},
    "feature_none": {"name":"No Feature","price":0,"rarity":"COMMON","slot":"feature","desc":"Keep the room clean and simple."},
    "room_lounge": {"name":"Casino Lounge","price":0,"rarity":"COMMON","slot":"room","desc":"A compact starter room."},
    "room_suite": {"name":"Casino Suite","price":100000,"rarity":"UNCOMMON","slot":"room","desc":"A larger private room."},
    "room_vip": {"name":"VIP Lounge","price":500000,"rarity":"RARE","slot":"room","desc":"Velvet, gold and a view."},
    "room_penthouse": {"name":"Skyline Penthouse","price":2500000,"rarity":"EPIC","slot":"room","desc":"A proper high-roller penthouse."},
    "room_royal": {"name":"Royal Casino","price":10000000,"rarity":"LEGENDARY","slot":"room","desc":"Your own private casino."},
    "floor_marble": {"name":"Black Marble Floor","price":250000,"rarity":"RARE","slot":"floor","desc":"Polished dark marble."},
    "floor_ruby": {"name":"Ruby Carpet","price":1000000,"rarity":"EPIC","slot":"floor","desc":"Crimson carpet with a royal glow."},
    "floor_gold": {"name":"Gold Inlay Floor","price":5000000,"rarity":"LEGENDARY","slot":"floor","desc":"Gold details across the entire room."},
    "wall_1927": {"name":"1927 Art Deco Walls","price":500000,"rarity":"RARE","slot":"wall","desc":"Brass, geometry and old-house style."},
    "wall_velvet": {"name":"Crimson Velvet Walls","price":1000000,"rarity":"EPIC","slot":"wall","desc":"Deep velvet panels and gold trim."},
    "wall_vault": {"name":"Private Vault Walls","price":2500000,"rarity":"LEGENDARY","slot":"wall","desc":"Heavy steel and luxury lighting."},
    "feature_blackjack": {"name":"Private Blackjack Table","price":1000000,"rarity":"EPIC","slot":"feature","desc":"Your room gets its own table."},
    "feature_chandelier": {"name":"Crystal Chandelier","price":5000000,"rarity":"LEGENDARY","slot":"feature","desc":"A massive crystal centerpiece."},
    "feature_statue": {"name":"Golden House Statue","price":10000000,"rarity":"ULTRA","slot":"feature","desc":"A gold statement piece."},
    "feature_bar": {"name":"Diamond Bar","price":25000000,"rarity":"ULTRA","slot":"feature","desc":"Pure flex. No practical reason."},
    "room_vip_private": {"name":"VIP Private Lounge","price":0,"rarity":"VIP","slot":"room","desc":"An exclusive lounge for active VIP members.","vip_only":True},
}

VIP_PRICE = 250_000_000          # in-game chips; 30-day membership
VIP_DURATION_DAYS = 30
VIP_DAILY_BONUS = 10_000_000     # extra in-game chips from the daily claim while VIP is active
VIP_XP_MULTIPLIER = 1.25

def vip_active(account):
    return float(account.get("vip_until", 0) or 0) > time.time()

def vip_payload(account):
    until = float(account.get("vip_until", 0) or 0)
    active = until > time.time()
    days_left = max(0, int((until - time.time() + 86399) // 86400)) if active else 0
    return {
        "active": active, "price": current_vip_price(), "durationDays": VIP_DURATION_DAYS,
        "until": until if active else 0, "daysLeft": days_left,
        "dailyBonus": VIP_DAILY_BONUS, "xpMultiplier": VIP_XP_MULTIPLIER,
    }

WEALTH_RANKS = [
    (0, "ROOKIE"), (10000, "REGULAR"), (100000, "HIGH ROLLER"),
    (1000000, "VIP"), (10000000, "WHALE"), (100000000, "CASINO ROYALTY"),
]

STORE_CATALOGS = {
    "theme": (COSMETIC_THEMES, "owned_themes", "equipped_theme"),
    "chip": (COSMETIC_CHIPS, "owned_chips", "equipped_chip"),
    "deck": (COSMETIC_DECKS, "owned_decks", "equipped_deck"),
    "table": (COSMETIC_TABLES, "owned_tables", "equipped_table"),
    "ball": (COSMETIC_BALLS, "owned_balls", "equipped_ball"),
    "profile_frame": (PROFILE_FRAMES, "owned_profile_frames", "equipped_profile_frame"),
    "profile_background": (PROFILE_BACKGROUNDS, "owned_profile_backgrounds", "equipped_profile_background"),
    "profile_title": (PROFILE_TITLES, "owned_profile_titles", "equipped_profile_title"),
    "casino": (CASINO_ITEMS, "owned_casino_items", "equipped_casino_items"),
}

load_developer_settings()
apply_all_catalog_overrides()

def current_vip_price():
    try: return max(1_000_000, int(DEVELOPER_SETTINGS.get("vip_price", VIP_PRICE)))
    except Exception: return VIP_PRICE

def catalog_collection_value(account):
    total = 0
    for category, (catalog, owned_key, _) in STORE_CATALOGS.items():
        owned = set(account.get(owned_key, [])) if category != "casino" else set(account.get(owned_key, []))
        total += sum(int(catalog.get(item_id, {}).get("price", 0) or 0) for item_id in owned)
    return total

def wealth_payload(account):
    cash = int(account.get("money", 0) or 0)
    collection = catalog_collection_value(account)
    net = cash + collection
    rank = WEALTH_RANKS[0][1]
    next_threshold = None
    for i, (threshold, label) in enumerate(WEALTH_RANKS):
        if net >= threshold:
            rank = label
            if i + 1 < len(WEALTH_RANKS): next_threshold = WEALTH_RANKS[i+1][0]
    return {
        "cash": cash, "collectionValue": collection, "netWorth": net, "rank": rank,
        "nextThreshold": next_threshold, "ownedItems": sum(len(set(account.get(k, []))) for _, (_, k, _) in STORE_CATALOGS.items())
    }

SEASON = {
    "id":2,"name":"CASINO X: CRIMSON ROYALE","subtitle":"DRESS CODE ENFORCED","duration":"21 DAYS","theme":"crimson_royale",
    "tiers":[
        {"tier":1,"xp":0,"reward":{"type":"chips","amount":500,"name":"IVORY GUEST PASS • 500 CHIPS"}},
        {"tier":2,"xp":150,"reward":{"type":"chip","id":"crimson_velvet","name":"VELVET ROYALE CHIP"}},
        {"tier":3,"xp":350,"reward":{"type":"chips","amount":1200,"name":"1,200 CHIPS"}},
        {"tier":4,"xp":700,"reward":{"type":"ball","id":"crimson_back","name":"CRIMSON SEAL CARD BACK"}},
        {"tier":5,"xp":1100,"reward":{"type":"chips","amount":2500,"name":"2,500 CHIPS"}},
        {"tier":6,"xp":1600,"reward":{"type":"deck","id":"crimson_royale_deck","name":"CRIMSON ROYALE DECK"}},
        {"tier":7,"xp":2300,"reward":{"type":"title","id":"crimson_guest","name":"CRIMSON GUEST"}},
        {"tier":8,"xp":3200,"reward":{"type":"table","id":"crimson_table","name":"CRIMSON ROYALE TABLE"}},
        {"tier":9,"xp":4300,"reward":{"type":"title","id":"royale_patron","name":"ROYALE PATRON"}},
        {"tier":10,"xp":5500,"reward":{"type":"theme","id":"crimson_royale","name":"CRIMSON ROYALE UNIVERSAL THEME"}},
    ]
}
def season_active(): return SEASON_START_TS > 0 and time.time() < SEASON_START_TS + SEASON_DURATION_S
def season_times():
    start=float(SEASON_START_TS or time.time()); end=start+SEASON_DURATION_S
    return start,end,max(0,int(end-time.time()))

def season_payload(account):
    # New season → reset seasonal XP/claims (permanent cosmetics already owned stay owned)
    if int(account.get("season_id", 0) or 0) != int(SEASON["id"]):
        account["season_id"] = int(SEASON["id"])
        account["season_xp"] = 0
        account["season_claimed"] = []
        save_accounts()
    xp=int(account.get("season_xp",0)); claimed=set(str(x) for x in account.get("season_claimed",[]))
    start_ts,end_ts,remaining=season_times()
    tiers=[{**t,"claimed":str(t["tier"]) in claimed,"unlocked":xp>=t["xp"] and season_active()} for t in SEASON["tiers"]]
    return {"season":{**SEASON,"startAt":start_ts,"endAt":end_ts,"active":season_active(),"remainingSeconds":remaining},"xp":xp,"claimed":sorted(claimed),"tiers":tiers}

def _catalog_payload(catalog,owned,equipped,account=None):
    vip = bool(account and vip_active(account))
    return [{"id":k,**v,"owned":k in owned,
             "equipped":(equipped.get(v.get("slot"))==k if isinstance(equipped,dict) else equipped==k)}
            for k,v in catalog.items()
            if not v.get("admin_only") and (not v.get("vip_only") or vip or k in owned)]

def store_payload(account):
    ensure_account_progress(account)
    ensure_wealth_progress(account)
    result = {
        "balance": int(account.get("money",0)),
        "wealth": wealth_payload(account),
        "season": season_payload(account),
    }
    for category, (catalog, owned_key, equipped_key) in STORE_CATALOGS.items():
        owned = set(account.get(owned_key, []))
        equipped = account.get(equipped_key, {}) if category == "casino" else account.get(equipped_key, "classic")
        result[category] = _catalog_payload(catalog, owned, equipped, account)
    # Backward-compatible names used by the current settings appearance UI.
    result["themes"] = result["theme"]
    result["chips"] = result["chip"]
    result["decks"] = result["deck"]
    result["tables"] = result["table"]
    result["balls"] = result["ball"]
    result["profileFrames"] = result["profile_frame"]
    result["profileBackgrounds"] = result["profile_background"]
    result["profileTitles"] = result["profile_title"]
    result["casinoItems"] = result["casino"]
    result["adminThemes"] = [{"id":k,**v,"owned":k in set(account.get("owned_themes",[])),"equipped":account.get("equipped_theme","classic")==k} for k,v in COSMETIC_THEMES.items() if v.get("admin_only") and k in set(account.get("owned_themes",[]))]
    result["adminChips"] = [{"id":k,**v,"owned":k in set(account.get("owned_chips",[])),"equipped":account.get("equipped_chip","classic")==k} for k,v in COSMETIC_CHIPS.items() if v.get("admin_only") and k in set(account.get("owned_chips",[]))]
    result["vip"] = vip_payload(account)
    return result

def ensure_account_progress(account):
    defaults = {
        "money": STARTING_MONEY, "games_played": 0, "wins": 0, "losses": 0,
        "pushes": 0, "blackjacks": 0, "best_win_streak": 0, "current_win_streak": 0,
        "biggest_win": 0, "xp": 0, "achievements": [], "daily_claim": "",
        "daily_challenges": {}, "daily_challenge_date": "", "daily_challenge_claimed": [],
        "friends": [], "friend_requests": [], "friend_outgoing": [], "avatar": None, "avatar_color": None, "play_seconds": 0,
        "owned_themes": ["classic"], "owned_chips": ["classic"], "owned_decks": ["classic"], "owned_tables": ["classic"], "owned_balls": ["classic"], "equipped_theme": "classic", "equipped_chip": "classic", "equipped_deck": "classic", "equipped_table": "classic", "equipped_ball": "classic", "owned_profile_frames": ["classic"], "owned_profile_backgrounds": ["classic"], "owned_profile_titles": ["rookie"], "owned_casino_items": ["room_lounge"], "equipped_profile_frame": "classic", "equipped_profile_background": "classic", "equipped_profile_title": "rookie", "equipped_casino_items": {"room":"room_lounge","floor":"classic_floor","wall":"classic_wall","feature":"feature_none"}, "season_xp": 0, "season_claimed": [], "season_title": "", "season_id": 0,
        "roulette_games": 0, "roulette_wins": 0, "roulette_biggest_win": 0,
        "game_stats": {"blackjack": {"games": 0, "wins": 0}, "poker": {"games": 0, "wins": 0}, "roulette": {"games": 0, "wins": 0}},
        "session_token": account.get("session_token"),
        "is_admin": False,
        "vip_until": 0,
        "vip_purchases": 0,
        "vip_daily_claim": "",
        "auto_rebuy": False,
        "auto_rebuy_amount": 1000,
    }
    changed = False
    for k, v in defaults.items():
        if k not in account:
            account[k] = v
            changed = True
    stats = account.setdefault("game_stats", {})
    stats.setdefault("blackjack", {"games": 0, "wins": 0})
    stats.setdefault("roulette", {"games": int(account.get("roulette_games", 0)), "wins": int(account.get("roulette_wins", 0))})
    stats.setdefault("poker", {"games": int(account.get("poker_wins", 0) and account.get("game_stats",{}).get("poker",{}).get("games",0) or 0), "wins": int(account.get("poker_wins", 0))})
    if changed:
        save_accounts()
    return account

# Database loading is intentionally performed only after all account helper
# functions are defined. This prevents startup-time NameError during migration.
load_accounts()

def ensure_wealth_progress(account):
    # Older accounts receive the new economy fields without losing anything.
    account.setdefault("owned_profile_frames", ["classic"])
    account.setdefault("owned_profile_backgrounds", ["classic"])
    account.setdefault("owned_profile_titles", ["rookie"])
    owned_casino=set(account.get("owned_casino_items", []))
    owned_casino.update({"room_lounge","classic_floor","classic_wall","feature_none"})
    account["owned_casino_items"]=sorted(owned_casino)
    account.setdefault("vip_until", 0)
    account.setdefault("vip_purchases", 0)
    account.setdefault("vip_daily_claim", "")
    account.setdefault("equipped_profile_frame", "classic")
    account.setdefault("equipped_profile_background", "classic")
    account.setdefault("equipped_profile_title", "rookie")
    equipped = account.get("equipped_casino_items")
    if not isinstance(equipped, dict): equipped = {}
    equipped.setdefault("room", "room_lounge")
    equipped.setdefault("floor", "classic_floor")
    equipped.setdefault("wall", "classic_wall")
    equipped.setdefault("feature", "feature_none")
    account["equipped_casino_items"] = equipped

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
        account["daily_challenges"] = {"play10": 0, "win3": 0, "blackjack1": 0, "poker1": 0}
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

_PLAY_BUMP_TS = {}
def bump_play_time(account_key, seconds=15):
    """Accumulate play time at most once per interval per user."""
    if not account_key or account_key not in ACCOUNTS:
        return
    now = time.time()
    last = _PLAY_BUMP_TS.get(account_key, 0)
    if now - last < 10:
        return
    _PLAY_BUMP_TS[account_key] = now
    acc = ACCOUNTS[account_key]
    acc["play_seconds"] = int(acc.get("play_seconds", 0) or 0) + int(seconds)
    # persist lightly
    try:
        save_accounts()
    except Exception:
        pass

def is_user_online(username_key):

    # Connected to the game socket counts as online (lobby or table)
    if username_key in USER_SOCKETS:
        return True
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
                "status": "friend",
            })
    return out

def friend_requests_payload(account):
    """Incoming friend requests for this account."""
    out = []
    for key in account.get("friend_requests", []):
        other = ACCOUNTS.get(key)
        if other:
            out.append({
                "username": other["username"],
                "online": is_user_online(key),
                "level": account_level(int(other.get("xp", 0)))[0],
                "avatar": other.get("avatar"),
                "avatarColor": other.get("avatar_color"),
                "status": "incoming",
            })
    return out

def friend_outgoing_payload(account):
    out = []
    for key in account.get("friend_outgoing", []):
        other = ACCOUNTS.get(key)
        if other:
            out.append({
                "username": other["username"],
                "online": is_user_online(key),
                "level": account_level(int(other.get("xp", 0)))[0],
                "status": "outgoing",
            })
    return out

def profile_payload(account):
    ensure_account_progress(account)
    ensure_wealth_progress(account)
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
                       "ball":account.get("equipped_ball","classic"),"title":account.get("equipped_profile_title",account.get("season_title","")),
                       "profileFrame":account.get("equipped_profile_frame","classic"),
                       "profileBackground":account.get("equipped_profile_background","classic")},
        "wealth": wealth_payload(account),
        "vip": vip_payload(account),
        "casino": {"equipped": dict(account.get("equipped_casino_items", {})), "owned": list(account.get("owned_casino_items", []))},
        "season": season_payload(account),
        "isAdmin": bool(account.get("is_admin")),
        "playSeconds": int(account.get("play_seconds", 0) or 0),
        "autoRebuy": bool(account.get("auto_rebuy")),
        "autoRebuyAmount": int(account.get("auto_rebuy_amount", 1000) or 1000),
    }

def leaderboard_payload():
    rows = []
    for a in ACCOUNTS.values():
        ensure_account_progress(a)
        ensure_wealth_progress(a)
        level, title = account_level(int(a.get("xp", 0)))
        total_games = int(a.get("games_played", 0))
        total_wins = int(a.get("wins", 0))
        rows.append({"username": a["username"], "balance": int(a.get("money", 0)), "netWorth": wealth_payload(a)["netWorth"],
                     "wins": total_wins, "blackjacks": int(a.get("blackjacks", 0)), "rouletteWins": int(a.get("roulette_wins", 0)),
                     "winRate": round((total_wins / total_games * 100), 1) if total_games else 0,
                     "streak": int(a.get("best_win_streak", 0)), "games": total_games,
                     "level": level, "levelTitle": title})
    def top(key): return sorted(rows, key=lambda x: (x[key], x["username"].lower()), reverse=True)[:20]
    return {"balance": top("balance"), "netWorth": top("netWorth"), "wins": top("wins"), "blackjacks": top("blackjacks"),
            "winRate": top("winRate"), "streak": top("streak"), "games": top("games")}

def challenge_defs():
    return [
        {"id": "play10", "title": "TABLE REGULAR", "desc": "Play 10 hands today.", "target": 10, "reward": 250},
        {"id": "win3", "title": "WINNER'S RUN", "desc": "Win 3 hands today.", "target": 3, "reward": 300},
        {"id": "blackjack1", "title": "NATURAL", "desc": "Get a Blackjack today.", "target": 1, "reward": 400},
        {"id": "poker1", "title": "POKER FACE", "desc": "Win a Poker hand today.", "target": 1, "reward": 400},
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
    raw = int(amount)
    if raw > 0 and vip_active(account):
        raw = int(round(raw * VIP_XP_MULTIPLIER))
    account["xp"] = max(0, int(account.get("xp", 0)) + raw)


def get_room(code: str, public=False, game="blackjack", max_players=None) -> dict:
    if code not in rooms:
        try:
            mp = int(max_players) if max_players is not None else (POKER_MAX_PLAYERS if game == "poker" else MAX_PLAYERS_DEFAULT)
        except (TypeError, ValueError):
            mp = POKER_MAX_PLAYERS if game == "poker" else MAX_PLAYERS_DEFAULT
        hard = POKER_MAX_PLAYERS if game == "poker" else MAX_PLAYERS_HARD_CAP
        mp = max(2, min(hard, mp))
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
            "forced_cards": {},
            "forced_dealer_cards": [],
            "dealer_preview_active": False,
            "dealer_preview_cards": [],
            "double_cash": False,
            # Poker state
            "poker_phase": "WAITING",
            "poker_community": [],
            "poker_pot": 0,
            "poker_side_pots": [],
            "poker_current_bet": 0,
            "poker_min_raise": 0,
            "poker_dealer_idx": 0,
            "poker_sb_idx": 0,
            "poker_bb_idx": 0,
            "poker_action_idx": 0,
            "poker_last_raiser": None,
            "poker_hand_num": 0,
            "poker_winners": [],
            "poker_buyin": POKER_DEFAULT_BUYIN,
            "poker_small_blind": POKER_SMALL_BLIND,
            "poker_big_blind": POKER_BIG_BLIND,
            "poker_deck": [],
            "poker_task": None,
            # asyncio task handles for cancellation
            "_ready_task": None,
            "_round_task": None,
            # Feature extras
            "pin": None,  # optional 4-digit PIN for private tables
            "hand_history": [],  # last 5 hands
            "bounties": {},  # username_key -> bounty amount
            "spectator_bets": {},  # spectator_player_id -> {targetId, amount}
            "announcement": None,  # {text, expires_at}
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
        bots = [p for p in players if p.get("is_bot")]
        host = find_player(room, room.get("host_id")) if room.get("host_id") else None
        max_p = int(room.get("max_players", MAX_PLAYERS_DEFAULT))
        rows.append({
            "code": room["code"], "game": room.get("game", "blackjack"), "players": len(players), "maxPlayers": max_p,
            "spectators": len(spectators), "bots": len(bots),
            "host": host.get("username") if host else "—",
            "phase": room.get("poker_phase") if room.get("game")=="poker" else room.get("phase", "LOBBY"),
            "buyIn": int(room.get("poker_buyin", 0)) if room.get("game")=="poker" else None,
            "canJoin": len(players) < max_p,
            "canSpectate": True,
            "doubleCash": bool(room.get("double_cash")),
            "locked": bool(room.get("pin")),
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
        "locked": bool(room.get("pin")),
        "announcement": room.get("announcement"),
        "bounties": {p.get("username"): int(room.get("bounties", {}).get(p.get("username_key"), 0) or 0)
                     for p in room.get("players", []) if room.get("bounties", {}).get(p.get("username_key"))},
        "handHistoryCount": len(room.get("hand_history") or []),
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
                "isAdmin": bool(p.get("is_admin")),
                "splitUsed": bool(p.get("split_used")),
                "hands": p.get("hands"),
                "handBets": p.get("hand_bets"),
                "handStatus": p.get("hand_status"),
                "handResults": p.get("hand_results"),
                "activeHand": p.get("active_hand", 0),
                "canSplit": (
                    room.get("phase") == "PLAYING"
                    and not p.get("split_used")
                    and isinstance(p.get("hand"), list)
                    and len(p.get("hand") or []) == 2
                    and str((p.get("hand") or [{}])[0].get("rank","")).upper()
                        == str((p.get("hand") or [{},{}])[1].get("rank","")).upper()
                    and int(p.get("money", 0)) >= int(p.get("bet", 0) or 0)
                    and int(p.get("bet", 0) or 0) > 0
                ),
            }
            for p in room["players"] if not p.get("spectator")
        ],
        "spectators": [
            {
                "id": p["id"],
                "username": p.get("username"),
                "name": p.get("name") or p.get("username"),
                "avatar": p.get("avatar"),
                "avatarColor": p.get("avatar_color"),
            }
            for p in room["players"] if p.get("spectator") and p.get("connected")
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
    # game:"all" so clients split BJ vs Poker lists instead of dumping everything into one lobby
    payload = json.dumps({"type": "public_tables", "game": "all", "tables": public_tables_payload()})
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
    await websocket.send(json.dumps({"type": "public_tables", "game": "all", "tables": public_tables_payload()}))


def push_hand_history(room, entry):
    """Keep last 5 hands in room state."""
    hist = room.setdefault("hand_history", [])
    hist.append(entry)
    if len(hist) > 5:
        del hist[0:len(hist)-5]

def compute_poker_side_pots(room):
    """Build simple side-pot list from all-in contribution levels for UI display.
    Returns list of {amount, eligible: [usernames]}."""
    seated = [p for p in poker_seated(room) if p.get("poker_in_hand") or int(p.get("poker_bet", 0)) > 0]
    # Total committed this hand = street bets are already in pot; use total contribution tracking if available
    # Fallback: show main pot only split conceptually when multiple all-ins
    allins = [p for p in seated if p.get("poker_status") == "allin"]
    if len(allins) < 1:
        room["poker_side_pots"] = []
        return
    # Approximate: each all-in creates a side layer at their total bet level
    levels = sorted(set(int(p.get("poker_bet", 0)) + int(p.get("poker_chips", 0)) for p in allins if int(p.get("poker_bet", 0)) > 0))
    # Simpler display: list each all-in player's locked amount as a side pot layer for UI
    pots = []
    main = int(room.get("poker_pot", 0))
    if main > 0:
        pots.append({"amount": main, "label": "Main", "eligible": [p.get("username") for p in seated if p.get("poker_status") != "folded"]})
    for p in allins:
        pots.append({
            "amount": int(p.get("poker_bet", 0)),
            "label": f"All-in · {p.get('username')}",
            "eligible": [p.get("username")],
        })
    room["poker_side_pots"] = pots[:6]

def try_auto_rebuy(player, room=None):
    """If account has auto_rebuy and is broke at the table, top up from bank or grant.
    On poker tables, rebuy amount = table buy-in (synced with host setting), else settings amount.
    Table stack and bank stay separate — never wipe bank because of all-in.
    """
    acc = ACCOUNTS.get(player.get("username_key"))
    if not acc or player.get("is_bot"):
        return False
    ensure_account_progress(acc)
    if not acc.get("auto_rebuy"):
        return False
    money = int(player.get("money", 0) or 0)
    chips = int(player.get("poker_chips", 0) or 0)
    if room and room.get("game") == "poker":
        # Only rebuy when table stack is empty (e.g. after bust), not mid all-in during a hand
        phase = room.get("poker_phase") or "WAITING"
        if phase in ("PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN") and player.get("poker_in_hand"):
            return False
        if chips > 0:
            return False
        buyin = int(room.get("poker_buyin", 0) or acc.get("auto_rebuy_amount", 1000) or 1000)
        buyin = max(POKER_MIN_BUYIN, min(POKER_MAX_BUYIN, buyin))
        if money >= buyin:
            player["money"] = money - buyin
            player["poker_chips"] = buyin
        elif money >= POKER_MIN_BUYIN:
            player["poker_chips"] = money
            player["money"] = 0
        else:
            # Bank empty — grant settings amount into bank then buy in
            grant = max(100, min(50000, int(acc.get("auto_rebuy_amount", 1000) or 1000)))
            player["money"] = max(0, grant - buyin)
            player["poker_chips"] = min(buyin, grant)
        player["spectator"] = False
        player["poker_status"] = "waiting"
        persist_player_money(player)
        return True
    # Blackjack / general: top up bank when total broke
    if money > 0:
        return False
    amount = max(100, min(50000, int(acc.get("auto_rebuy_amount", 1000) or 1000)))
    player["money"] = amount
    persist_player_money(player)
    return True

def chat_clean(text):
    # Keep emoji / unicode; only collapse whitespace and cap length
    text = " ".join(str(text or "").split())[:280]
    if not text:
        return None
    low = text.lower()
    for word in BANNED_WORDS:
        if word in low:
            return None
    return text

# ---------------------------------------------------------------------------
# Admin helpers
# ---------------------------------------------------------------------------
def admin_payload(room):
    users = [{"username": a["username"], "money": int(a.get("money", 0)),
              "netWorth": int(wealth_payload(a)["netWorth"]), "isAdmin": bool(a.get("is_admin")),
              "vip": vip_payload(a)}
             for a in ACCOUNTS.values()]
    admin_catalog = []
    for category, (catalog, _, _) in STORE_CATALOGS.items():
        for item_id, item in catalog.items():
            admin_catalog.append({"id":item_id,"category":category,"name":item.get("name",item_id),
                                  "price":int(item.get("price",0) or 0),"rarity":item.get("rarity","COMMON"),
                                  "vipOnly":bool(item.get("vip_only")),"adminOnly":bool(item.get("admin_only"))})
    table_players = []
    if room:
        table_players = [{
            "id": p["id"], "username": p["username"], "money": int(p["money"]),
            "lucky": bool(room.get("lucky_players", {}).get(p.get("username_key"), 0)),
            "luckStrength": int(room.get("lucky_players", {}).get(p.get("username_key"), 0) or room.get("roulette_player_luck", {}).get(p.get("username_key"), 0) or 0),
            "isAdmin": bool(p.get("is_admin")),
            "bounty": int(room.get("bounties", {}).get(p.get("username_key"), 0) or 0),
            "connected": p.get("connected", False),
        } for p in room.get("players", [])]
    preview = None
    if room and room.get("dealer_preview_active") and room.get("dealer_preview_cards"):
        preview = [{"rank": c["rank"], "suit": c["suit"], "faceUp": True}
                   for c in room["dealer_preview_cards"]]
    table_luck = room.get("roulette_table_luck", {}) if room else {}
    table_luck_active = bool(table_luck.get("strength", 0) and table_luck.get("expires_at", 0) > time.time())
    return {"users": users, "adminCatalog": admin_catalog, "tablePlayers": table_players, "dealerPreviewActive": bool(room and room.get("dealer_preview_active")), "dealerPreview": preview,
            "tableLuck": {"strength": int(table_luck.get("strength", 0)), "active": table_luck_active},
            "developer": developer_admin_payload()}



def is_authorized_admin(websocket, room, player):
    if room is None or player is None:
        return False
    if not any(p is player and p.get("connected") for p in room.get("players", [])):
        return False
    if websocket in ADMIN_SOCKETS:
        return True
    # Permanent account-level admin
    if player.get("is_admin"):
        return True
    acc = ACCOUNTS.get(player.get("username_key"))
    if acc and acc.get("is_admin"):
        player["is_admin"] = True
        ADMIN_SOCKETS.add(websocket)
        return True
    return False

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
    """Draw a card, optionally biased by admin luck strength (0-100).
    At 100%: always pick the card that gets closest to 21 without busting.
    At 50%: 50% chance of biased draw. At 0%: pure random.
    Also honors forced_cards queue for this player if set by admin card selector.
    """
    # Forced card from admin card selector (specific assigned cards)
    forced_map = room.get("forced_cards") or {}
    pid = player.get("id")
    if pid and forced_map.get(pid):
        queue = forced_map[pid]
        if queue:
            forced_c = queue.pop(0)
            # remove matching card from shoe if present
            for i, c in enumerate(room["deck"]):
                if c.get("rank") == forced_c.get("rank") and c.get("suit") == forced_c.get("suit"):
                    room["deck"].pop(i)
                    break
            return {"rank": forced_c["rank"], "suit": forced_c["suit"]}

    admin_luck = _player_has_admin_luck(player)
    strength = int(room.get("lucky_players", {}).get(player.get("username_key"), 0) or 0)
    if strength <= 0 and not admin_luck:
        return draw_card(room)
    # Cosmetic admin mild luck if no explicit strength
    if strength <= 0 and admin_luck:
        strength = 35
    # strength% chance to bias
    if random.random() * 100 > strength:
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
    # Promote pending spectators into seats between rounds when space allows
    max_p = int(room.get("max_players", MAX_PLAYERS_DEFAULT))
    seated = sum(1 for p in room.get("players", []) if p.get("connected") and not p.get("spectator"))
    for p in list(room.get("players", [])):
        if seated >= max_p:
            break
        if p.get("connected") and p.get("spectator") and p.get("pending_seat"):
            p["spectator"] = False
            p["pending_seat"] = False
            p["status"] = "betting"
            seated += 1
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
        forced_dealer = room.get("forced_dealer_cards") or []
        if forced_dealer and round_num < len(forced_dealer):
            fc = forced_dealer[round_num]
            dealer_card = {"rank": fc["rank"], "suit": fc["suit"]}
            for i, c in enumerate(room["deck"]):
                if c.get("rank") == fc.get("rank") and c.get("suit") == fc.get("suit"):
                    room["deck"].pop(i)
                    break
        elif room.get("dealer_preview_cards") and round_num < len(room["dealer_preview_cards"]):
            dealer_card = room["dealer_preview_cards"][round_num]
        else:
            dealer_card = draw_card(room)
        dealer_card["faceUp"] = (round_num == 0)
        room["dealer_hand"].append(dealer_card)
    room["dealer_preview_cards"] = []
    room["dealer_preview_active"] = False
    room["forced_dealer_cards"] = []

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
        if p["status"] == "spectating":
            continue
        fb = friend_boost_mult(room, p)
        p["friendBoost"] = round((fb - 1) * 100)
        # Split hands: settle each hand separately
        if p.get("hands") and p.get("hand_bets"):
            total_win = 0
            results = []
            for i, hand in enumerate(p["hands"]):
                hb = int(p["hand_bets"][i])
                st = (p.get("hand_status") or [None]*len(p["hands"]))[i]
                if st == "bust" or hand_value(hand) > 21:
                    results.append("bust")
                    continue
                pv = hand_value(hand)
                if dealer_bj:
                    results.append("lose")
                elif dv > 21 or dv < pv:
                    total_win += round(hb * 2 * mult * fb)
                    results.append("win")
                elif dv > pv:
                    results.append("lose")
                else:
                    total_win += hb
                    results.append("push")
            p["money"] += total_win
            p["hand_results"] = results
            if all(r == "bust" for r in results):
                p["result"] = "bust"
                p["consecutive_losses"] = p.get("consecutive_losses", 0) + 1
            elif any(r == "win" for r in results) and not any(r in ("lose", "bust") for r in results):
                p["result"] = "win"
                p["consecutive_losses"] = 0
            elif any(r == "win" for r in results):
                p["result"] = "win"
                p["consecutive_losses"] = 0
            elif all(r == "push" for r in results):
                p["result"] = "push"
                p["consecutive_losses"] = 0
            else:
                p["result"] = "lose"
                p["consecutive_losses"] = p.get("consecutive_losses", 0) + 1
            continue
        if not p.get("hand"):
            continue
        if p["status"] == "bust":
            p["result"] = "bust"
            p["consecutive_losses"] = p.get("consecutive_losses", 0) + 1
        elif p["status"] == "blackjack":
            if dealer_bj:
                p["money"] += p["bet"]
                p["result"] = "push"
                p["consecutive_losses"] = 0
            else:
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
                p["money"] += p["bet"]
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

    # Hand history entry
    try:
        entry = {
            "game": "blackjack",
            "ts": int(time.time()),
            "dealer": hand_display(room.get("dealer_hand") or []) if room.get("dealer_hand") else "—",
            "players": [
                {"username": p.get("username"), "result": p.get("result"), "bet": int(p.get("bet") or 0),
                 "hand": hand_display(p.get("hand") or []) if p.get("hand") else "—"}
                for p in room.get("players", []) if not p.get("spectator") and p.get("result")
            ],
        }
        push_hand_history(room, entry)
    except Exception:
        pass

    # Settle spectator bets: 2x if target won/blackjack, else lose stake
    sbets = room.pop("spectator_bets", {}) or {}
    for sid, bet in sbets.items():
        spec = find_player(room, sid)
        target = find_player(room, bet.get("targetId"))
        if not spec:
            continue
        amt = int(bet.get("amount", 0))
        won = target and target.get("result") in ("win", "blackjack")
        if won:
            spec["money"] = int(spec.get("money", 0)) + amt * 2
            persist_player_money(spec)
            if spec.get("ws"):
                try:
                    await spec["ws"].send(json.dumps({"type":"info","message":f"Spectator bet won +${amt} on {target.get('username')}!"}))
                except Exception:
                    pass
        else:
            if spec.get("ws"):
                try:
                    await spec["ws"].send(json.dumps({"type":"info","message":f"Spectator bet lost (${amt})."}))
                except Exception:
                    pass

    # Bounties: anyone who beat a bounty target in BJ gets the bounty
    bmap = room.get("bounties") or {}
    for p in room.get("players", []):
        if p.get("spectator") or p.get("result") not in ("win", "blackjack"):
            continue
        # pay bounty if any loser had bounty? simpler: if this player had opponents lose with bounty on them
        for other in room.get("players", []):
            if other is p or other.get("spectator"):
                continue
            if other.get("result") in ("lose", "bust") and bmap.get(other.get("username_key")):
                bounty = int(bmap.get(other.get("username_key"), 0))
                if bounty > 0:
                    p["money"] = int(p.get("money", 0)) + bounty
                    persist_player_money(p)
                    bmap[other.get("username_key")] = 0
                    if p.get("ws"):
                        try:
                            await p["ws"].send(json.dumps({"type":"info","message":f"Bounty claimed! +${bounty} for beating {other.get('username')}."}))
                        except Exception:
                            pass

    # Auto-rebuy broke players
    for p in room.get("players", []):
        if try_auto_rebuy(p, room) and p.get("ws"):
            try:
                await p["ws"].send(json.dumps({"type":"info","message":f"Auto-rebuy: +${p.get('money')} chips."}))
                acc = ACCOUNTS.get(p.get("username_key"))
                if acc:
                    await p["ws"].send(json.dumps({"type":"profile","profile":profile_payload(acc)}))
            except Exception:
                pass

    await broadcast(room)
    for p in active_players(room):
        account = ACCOUNTS.get(p.get("username_key"))
        if account and p.get("ws"):
            try:
                await p["ws"].send(json.dumps({"type":"profile", "profile": profile_payload(account), "developer": developer_public_payload()}))
            except Exception:
                pass

    await asyncio.sleep(ROUND_OVER_S)
    await reset_for_betting(room)



# ---------------------------------------------------------------------------
# Poker — Texas Hold'em (server-authoritative)
# ---------------------------------------------------------------------------
RANK_ORDER = {r: i for i, r in enumerate(["2","3","4","5","6","7","8","9","10","J","Q","K","A"], start=2)}
HAND_NAMES = {
    9: "Royal Flush", 8: "Straight Flush", 7: "Four of a Kind", 6: "Full House",
    5: "Flush", 4: "Straight", 3: "Three of a Kind", 2: "Two Pair", 1: "One Pair", 0: "High Card"
}

def poker_fresh_deck():
    cards = [{"rank": r, "suit": s} for s in SUITS for r in RANKS]
    random.shuffle(cards)
    return cards

def _eval_5(cards):
    """Evaluate exactly 5 cards. Returns (rank_tier, tiebreakers...)."""
    ranks = sorted([RANK_ORDER[c["rank"]] for c in cards], reverse=True)
    suits = [c["suit"] for c in cards]
    is_flush = len(set(suits)) == 1
    uniq = sorted(set(ranks), reverse=True)
    is_straight = False
    straight_high = 0
    if len(uniq) == 5 and uniq[0] - uniq[4] == 4:
        is_straight = True
        straight_high = uniq[0]
    # Wheel: A-5
    if set(ranks) == {14, 5, 4, 3, 2}:
        is_straight = True
        straight_high = 5
    counts = {}
    for r in ranks:
        counts[r] = counts.get(r, 0) + 1
    by_count = sorted(counts.items(), key=lambda x: (x[1], x[0]), reverse=True)
    if is_straight and is_flush:
        if straight_high == 14:
            return (9, 14)
        return (8, straight_high)
    if by_count[0][1] == 4:
        kicker = [r for r in ranks if r != by_count[0][0]][0]
        return (7, by_count[0][0], kicker)
    if by_count[0][1] == 3 and by_count[1][1] == 2:
        return (6, by_count[0][0], by_count[1][0])
    if is_flush:
        return (5,) + tuple(ranks)
    if is_straight:
        return (4, straight_high)
    if by_count[0][1] == 3:
        kickers = sorted([r for r in ranks if r != by_count[0][0]], reverse=True)
        return (3, by_count[0][0]) + tuple(kickers)
    if by_count[0][1] == 2 and by_count[1][1] == 2:
        high_pair = max(by_count[0][0], by_count[1][0])
        low_pair = min(by_count[0][0], by_count[1][0])
        kicker = [r for r in ranks if r != high_pair and r != low_pair][0]
        return (2, high_pair, low_pair, kicker)
    if by_count[0][1] == 2:
        kickers = sorted([r for r in ranks if r != by_count[0][0]], reverse=True)
        return (1, by_count[0][0]) + tuple(kickers)
    return (0,) + tuple(ranks)

def best_poker_hand(hole, community):
    """Best 5-card hand from 2 hole + up to 5 community."""
    from itertools import combinations
    all_cards = list(hole) + list(community)
    if len(all_cards) < 5:
        # pad evaluation with available cards only
        if not all_cards:
            return (0, 0)
        ranks = sorted([RANK_ORDER[c["rank"]] for c in all_cards], reverse=True)
        return (0,) + tuple(ranks)
    best = None
    for combo in combinations(all_cards, 5):
        score = _eval_5(combo)
        if best is None or score > best:
            best = score
    return best

def poker_hand_name(score):
    return HAND_NAMES.get(score[0] if score else 0, "High Card")

def poker_sync_balance(player):
    """Persist bank balance only. Table stack (poker_chips) is separate from bank (money).
    NEVER set money = poker_chips — that was the all-in "left the table" bug.
    """
    if player.get("is_bot"):
        return
    player["poker_chips"] = max(0, int(player.get("poker_chips", 0) or 0))
    player["money"] = max(0, int(player.get("money", 0) or 0))
    persist_player_money(player)

def poker_seat_with_buyin(player, room):
    """Bring table buy-in amount from bank (money) into poker_chips. Returns (ok, err)."""
    if player.get("is_bot"):
        player["spectator"] = False
        player["status"] = "waiting"
        player["poker_status"] = "waiting"
        player["poker_in_hand"] = False
        player["pending_seat"] = False
        return True, "ok"
    buyin = int(room.get("poker_buyin", POKER_DEFAULT_BUYIN) or POKER_DEFAULT_BUYIN)
    buyin = max(POKER_MIN_BUYIN, min(POKER_MAX_BUYIN, buyin))
    money = max(0, int(player.get("money", 0) or 0))
    # Already seated with chips — top-up not here
    if not player.get("spectator") and int(player.get("poker_chips", 0) or 0) > 0:
        return True, "ok"
    if money < POKER_MIN_BUYIN:
        return False, f"Need at least ${POKER_MIN_BUYIN} in your bank to buy in."
    amount = min(buyin, money)  # short-stack allowed if under table buy-in
    player["money"] = money - amount
    player["poker_chips"] = int(player.get("poker_chips", 0) or 0) + amount
    player["spectator"] = False
    player["status"] = "waiting"
    player["poker_status"] = "waiting"
    player["poker_in_hand"] = False
    player["pending_seat"] = False
    player["pending_buyin"] = 0
    persist_player_money(player)
    return True, "ok"

def poker_seat_with_balance(player):
    """Legacy alias — seats with room buy-in when room is unknown; prefers existing chips."""
    # Without room context, sit with whatever is already in poker_chips or a default slice
    money = max(0, int(player.get("money", 0) or 0))
    chips = max(0, int(player.get("poker_chips", 0) or 0))
    if chips <= 0 and money > 0:
        amount = min(POKER_DEFAULT_BUYIN, money)
        player["money"] = money - amount
        player["poker_chips"] = amount
    player["spectator"] = False
    player["status"] = "waiting"
    player["poker_status"] = "waiting"
    player["poker_in_hand"] = False
    player["pending_seat"] = False
    player["pending_buyin"] = 0
    if not player.get("is_bot"):
        persist_player_money(player)

def poker_cashout_to_bank(player):
    """Move table stack back to bank. Player may stay seated with 0 or sit out."""
    chips = max(0, int(player.get("poker_chips", 0) or 0))
    player["money"] = max(0, int(player.get("money", 0) or 0)) + chips
    player["poker_chips"] = 0
    if not player.get("is_bot"):
        persist_player_money(player)

def poker_seated(room):
    """Players at the table. Includes all-in (0 chips) while still in the current hand."""
    phase = room.get("poker_phase") or "WAITING"
    mid_hand = phase in ("PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN")
    out = []
    for p in room.get("players", []):
        if not p.get("connected") or p.get("spectator"):
            continue
        chips = int(p.get("poker_chips", 0) or 0)
        if chips > 0:
            out.append(p)
        elif mid_hand and p.get("poker_in_hand") and p.get("poker_status") in ("allin", "active", "folded"):
            # Still at the table for this hand — all-in is NOT leave/sit-out
            out.append(p)
    return out

def poker_with_chips(room):
    """Players who can start the next hand (must have table chips)."""
    return [p for p in room.get("players", [])
            if p.get("connected") and not p.get("spectator") and int(p.get("poker_chips", 0) or 0) > 0]

def poker_in_hand(room):
    return [p for p in poker_seated(room) if p.get("poker_status") not in ("folded", "sitting_out") and p.get("poker_in_hand")]

def _next_bot_name(room):
    used = {str(p.get("username") or "").lower() for p in room.get("players", [])}
    pool = list(BOT_NAME_POOL)
    random.shuffle(pool)
    for name in pool:
        if name.lower() not in used:
            return name
    return f"Bot{random.randint(100, 999)}"

def create_poker_bot(room):
    """Create a bot player object. Caller decides spectator vs seated."""
    pid = new_id()
    name = _next_bot_name(room)
    stack = POKER_BOT_STARTING_CHIPS
    return {
        "id": pid,
        "ws": None,
        "name": name,
        "username": name,
        "username_key": f"bot_{pid}",
        "money": stack,
        "bet": 0,
        "hand": [],
        "status": "waiting",
        "spectator": False,
        "result": None,
        "connected": True,
        "is_bot": True,
        "pending_seat": False,
        "pending_buyin": 0,
        "consecutive_losses": 0,
        "pity_banner": False,
        "double_used": False,
        "cosmetics": {"theme": "classic", "chip": "classic", "deck": "classic", "table": "classic", "ball": "classic"},
        "avatar": None,
        "avatar_color": random.choice(["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6", "#1abc9c"]),
        "friendBoost": 0,
        "poker_chips": stack,
        "poker_bet": 0,
        "poker_hole": [],
        "poker_status": "waiting",
        "poker_in_hand": False,
        "poker_is_dealer": False,
        "poker_is_sb": False,
        "poker_is_bb": False,
        "poker_acted": False,
        "poker_hand_name": None,
    }

async def promote_pending_poker_players(room):
    """Move pending spectators (humans + bots) into seats between hands when space allows."""
    if room.get("game") != "poker":
        return
    max_p = int(room.get("max_players", POKER_MAX_PLAYERS))
    seated = sum(1 for p in room.get("players", []) if p.get("connected") and not p.get("spectator"))
    for p in list(room.get("players", [])):
        if seated >= max_p:
            break
        if not p.get("connected") or not p.get("spectator"):
            continue
        if not (p.get("pending_seat") or p.get("is_bot")):
            continue
        if p.get("is_bot"):
            if int(p.get("poker_chips", 0)) <= 0:
                p["poker_chips"] = POKER_BOT_STARTING_CHIPS
                p["money"] = POKER_BOT_STARTING_CHIPS
            p["spectator"] = False
            p["status"] = "waiting"
            p["poker_status"] = "waiting"
            p["poker_in_hand"] = False
            p["pending_seat"] = False
            seated += 1
            continue
        # Humans: buy in from bank into table stack
        if int(p.get("money", 0)) <= 0 and int(p.get("poker_chips", 0)) <= 0:
            p["pending_seat"] = False
            continue
        ok, _ = poker_seat_with_buyin(p, room)
        if ok:
            seated += 1
        else:
            p["pending_seat"] = False

def poker_bot_decide(room, player):
    """Simple tight-aggressive-ish bot decision. Returns (action, amount)."""
    to_call = max(0, int(room.get("poker_current_bet", 0)) - int(player.get("poker_bet", 0)))
    chips = int(player.get("poker_chips", 0))
    pot = int(room.get("poker_pot", 0))
    bb = int(room.get("poker_big_blind", POKER_BIG_BLIND))
    min_raise = int(room.get("poker_min_raise", bb))
    hole = player.get("poker_hole") or []
    community = room.get("poker_community") or []
    # crude hand strength 0..1
    strength = 0.35
    try:
        if hole and len(hole) >= 2:
            ranks = [c.get("rank") for c in hole]
            suits = [c.get("suit") for c in hole]
            if ranks[0] == ranks[1]:
                strength = 0.72  # pair
            elif suits[0] == suits[1]:
                strength = 0.48  # suited
            high = {"A": 14, "K": 13, "Q": 12, "J": 11, "10": 10}
            vals = [high.get(r, int(r) if str(r).isdigit() else 7) for r in ranks]
            if max(vals) >= 12:
                strength = max(strength, 0.55)
            if community:
                score = best_poker_hand(hole, community)
                rank_idx = score[0] if score else 0
                strength = min(0.95, 0.35 + rank_idx * 0.08)
    except Exception:
        strength = 0.4
    r = random.random()
    if to_call == 0:
        if strength > 0.55 and r < 0.45 and chips > bb:
            raise_amt = min(chips, max(min_raise, int(pot * 0.5) or bb * 2))
            return ("raise" if int(room.get("poker_current_bet", 0)) > 0 else "bet", raise_amt + int(player.get("poker_bet", 0)))
        return ("check", 0)
    # facing a bet
    pot_odds = to_call / max(1, pot + to_call)
    if to_call >= chips:
        if strength > 0.5 or r < 0.15:
            return ("allin", 0)
        return ("fold", 0)
    if strength < 0.35 and pot_odds > 0.35:
        return ("fold", 0)
    if strength > 0.65 and chips > to_call + min_raise and r < 0.4:
        raise_to = min(chips, to_call + max(min_raise, int(pot * 0.6)))
        return ("raise", int(player.get("poker_bet", 0)) + raise_to)
    if strength > 0.4 or pot_odds < 0.3:
        return ("call", 0)
    if r < 0.25:
        return ("call", 0)
    return ("fold", 0)

async def poker_bot_act(room, bot_id):
    """Delayed bot action for the active bot player."""
    try:
        await asyncio.sleep(random.uniform(*POKER_BOT_ACTION_DELAY))
        if room.get("game") != "poker":
            return
        if room.get("active_player_id") != bot_id:
            return
        player = find_player(room, bot_id)
        if not player or not player.get("is_bot"):
            return
        action, amount = poker_bot_decide(room, player)
        ok, _ = await poker_handle_action(room, player, action, amount)
        if not ok and action != "fold":
            # fallback
            to_call = max(0, int(room.get("poker_current_bet", 0)) - int(player.get("poker_bet", 0)))
            if to_call == 0:
                await poker_handle_action(room, player, "check", 0)
            else:
                await poker_handle_action(room, player, "fold", 0)
        # schedule next bot if still a bot's turn
        active = find_player(room, room.get("active_player_id"))
        if active and active.get("is_bot") and room.get("poker_phase") in ("PREFLOP", "FLOP", "TURN", "RIVER"):
            asyncio.create_task(poker_bot_act(room, active["id"]))
    except Exception:
        pass

def schedule_bot_if_needed(room):
    """Schedule bot AI or human action timeout (auto-fold) for the active player."""
    active = find_player(room, room.get("active_player_id"))
    if not active or room.get("poker_phase") not in ("PREFLOP", "FLOP", "TURN", "RIVER"):
        room["poker_action_deadline"] = None
        return
    # Deadline for UI + auto-fold (unix seconds)
    room["poker_action_deadline"] = time.time() + POKER_ACTION_TIMEOUT_S
    room["poker_action_token"] = id(active)  # invalidate stale timers
    token = room["poker_action_token"]
    if active.get("is_bot"):
        asyncio.create_task(poker_bot_act(room, active["id"]))
    else:
        asyncio.create_task(poker_action_timeout(room, active["id"], token))

async def poker_action_timeout(room, player_id, token):
    """Auto-fold (or check if free) when a human runs out of time — Gambit-style."""
    try:
        await asyncio.sleep(POKER_ACTION_TIMEOUT_S)
        if room.get("poker_action_token") != token:
            return
        if room.get("active_player_id") != player_id:
            return
        if room.get("poker_phase") not in ("PREFLOP", "FLOP", "TURN", "RIVER"):
            return
        player = find_player(room, player_id)
        if not player or player.get("is_bot"):
            return
        to_call = max(0, int(room.get("poker_current_bet", 0)) - int(player.get("poker_bet", 0)))
        action = "check" if to_call == 0 else "fold"
        await poker_handle_action(room, player, action, 0)
    except Exception:
        pass

def poker_serialise(room, viewer_id=None):
    phase = room.get("poker_phase", "WAITING")
    community = room.get("poker_community", [])
    players_out = []
    spectators_out = []
    for p in room.get("players", []):
        if p.get("spectator"):
            spectators_out.append({
                "id": p["id"],
                "username": p.get("username"),
                "name": p.get("name") or p.get("username"),
                "avatar": p.get("avatar"),
                "avatarColor": p.get("avatar_color"),
                "isBot": bool(p.get("is_bot")),
            })
            continue
        show_cards = False
        if phase in ("SHOWDOWN", "HAND_OVER"):
            show_cards = (p.get("poker_in_hand") and p.get("poker_status") != "folded") or bool(p.get("poker_show_hole"))
        elif viewer_id and p["id"] == viewer_id:
            show_cards = True
        elif p.get("poker_show_hole"):
            show_cards = True
        hole = p.get("poker_hole", []) or []
        active_street = phase in ("PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN", "HAND_OVER")
        in_hand = p.get("poker_in_hand") and p.get("poker_status") != "folded"
        if show_cards and hole:
            cards = [{"rank": c["rank"], "suit": c["suit"], "faceUp": True} for c in hole]
        elif in_hand and active_street:
            # Always show two face-down backs for opponents during a live hand
            n = max(len(hole), 2)
            cards = [{"faceUp": False} for _ in range(n)]
        else:
            cards = []
        players_out.append({
            "id": p["id"],
            "name": p.get("name") or p.get("username"),
            "username": p.get("username"),
            "isHost": p["id"] == room.get("host_id"),
            "chips": int(p.get("poker_chips", 0)),
            "bet": int(p.get("poker_bet", 0)),
            "status": p.get("poker_status", "waiting"),
            "hole": cards,
            "connected": p.get("connected", False),
            "isDealer": p.get("poker_is_dealer", False),
            "isSB": p.get("poker_is_sb", False),
            "isBB": p.get("poker_is_bb", False),
            "isTurn": p["id"] == room.get("active_player_id"),
            "handName": p.get("poker_hand_name"),
            "cosmetics": p.get("cosmetics", {}),
            "avatar": p.get("avatar"),
            "avatarColor": p.get("avatar_color"),
            "money": int(p.get("money", 0)),
            "isBot": bool(p.get("is_bot")),
            "isAdmin": bool(p.get("is_admin")),
            "showHole": bool(p.get("poker_show_hole")),
        })
    return {
        "code": room["code"],
        "game": "poker",
        "phase": phase,
        "community": [{"rank": c["rank"], "suit": c["suit"]} for c in community],
        "pot": int(room.get("poker_pot", 0)),
        "sidePots": list(room.get("poker_side_pots") or []),
        "locked": bool(room.get("pin")),
        "announcement": room.get("announcement"),
        "bounties": {p.get("username"): int(room.get("bounties", {}).get(p.get("username_key"), 0) or 0)
                     for p in room.get("players", []) if room.get("bounties", {}).get(p.get("username_key"))},
        "handHistoryCount": len(room.get("hand_history") or []),
        "currentBet": int(room.get("poker_current_bet", 0)),
        "minRaise": int(room.get("poker_min_raise", room.get("poker_big_blind", POKER_BIG_BLIND))),
        "activePlayerId": room.get("active_player_id"),
        "actionDeadline": room.get("poker_action_deadline"),
        "actionTimeout": POKER_ACTION_TIMEOUT_S,
        "hostId": room.get("host_id"),
        "maxPlayers": int(room.get("max_players", POKER_MAX_PLAYERS)),
        "buyIn": int(room.get("poker_buyin", POKER_DEFAULT_BUYIN)),
        "smallBlind": int(room.get("poker_small_blind", POKER_SMALL_BLIND)),
        "bigBlind": int(room.get("poker_big_blind", POKER_BIG_BLIND)),
        "handNum": int(room.get("poker_hand_num", 0)),
        "winners": room.get("poker_winners", []),
        "players": players_out,
        "spectators": spectators_out,
        "street": room.get("poker_street", "PREFLOP"),
        "seatedCount": len(players_out),
        "spectatorCount": len(spectators_out),
    }

async def poker_broadcast(room):
    for p in room.get("players", []):
        if not p.get("ws"):
            continue
        try:
            state = poker_serialise(room, viewer_id=p["id"])
            await p["ws"].send(json.dumps({"type": "poker_state", "state": state}))
        except Exception:
            pass

def poker_next_idx(room, start_idx, players=None):
    players = players or poker_seated(room)
    if not players:
        return None
    n = len(players)
    for i in range(1, n + 1):
        idx = (start_idx + i) % n
        p = players[idx]
        if p.get("poker_in_hand") and p.get("poker_status") not in ("folded", "allin"):
            return idx
    return None

def poker_active_list(room):
    return [p for p in poker_seated(room) if p.get("poker_in_hand") and p.get("poker_status") != "folded"]


async def _poker_autostart(room):
    """Deprecated: host must click START HAND. Kept as no-op so old callers are safe."""
    return

async def poker_start_hand(room):
    players = poker_with_chips(room)
    if len(players) < POKER_MIN_PLAYERS:
        room["poker_phase"] = "WAITING"
        room["active_player_id"] = None
        await poker_broadcast(room)
        return
    room["poker_hand_num"] = int(room.get("poker_hand_num", 0)) + 1
    room["poker_deck"] = poker_fresh_deck()
    room["poker_community"] = []
    room["poker_pot"] = 0
    room["poker_side_pots"] = []
    room["poker_current_bet"] = 0
    room["poker_winners"] = []
    room["poker_street"] = "PREFLOP"
    room["poker_phase"] = "PREFLOP"
    # rotate dealer
    n = len(players)
    room["poker_dealer_idx"] = (int(room.get("poker_dealer_idx", 0)) + 1) % n
    d_idx = room["poker_dealer_idx"]
    if n == 2:
        sb_idx = d_idx
        bb_idx = (d_idx + 1) % n
    else:
        sb_idx = (d_idx + 1) % n
        bb_idx = (d_idx + 2) % n
    room["poker_sb_idx"] = sb_idx
    room["poker_bb_idx"] = bb_idx
    sb_amt = int(room.get("poker_small_blind", POKER_SMALL_BLIND))
    bb_amt = int(room.get("poker_big_blind", POKER_BIG_BLIND))
    for i, p in enumerate(players):
        p["poker_hole"] = []
        p["poker_bet"] = 0
        p["poker_status"] = "active"
        p["poker_in_hand"] = True
        p["poker_is_dealer"] = (i == d_idx)
        p["poker_is_sb"] = (i == sb_idx)
        p["poker_is_bb"] = (i == bb_idx)
        p["poker_hand_name"] = None
        p["poker_acted"] = False
    # post blinds
    def post_blind(p, amount):
        chips = int(p.get("poker_chips", 0))
        pay = min(chips, amount)
        p["poker_chips"] = chips - pay
        p["poker_bet"] = pay
        room["poker_pot"] = int(room.get("poker_pot", 0)) + pay
        if p["poker_chips"] == 0:
            p["poker_status"] = "allin"
        poker_sync_balance(p)
        return pay
    post_blind(players[sb_idx], sb_amt)
    post_blind(players[bb_idx], bb_amt)
    room["poker_current_bet"] = max(players[sb_idx]["poker_bet"], players[bb_idx]["poker_bet"])
    room["poker_min_raise"] = bb_amt
    room["poker_last_raiser"] = players[bb_idx]["id"]
    # deal 2 hole cards each
    for _ in range(2):
        for p in players:
            if room["poker_deck"]:
                p["poker_hole"].append(room["poker_deck"].pop())
    # first to act: left of BB (or SB in heads-up)
    if n == 2:
        act_idx = sb_idx
    else:
        act_idx = (bb_idx + 1) % n
    # skip all-in players
    for _ in range(n):
        p = players[act_idx]
        if p.get("poker_status") != "allin" and p.get("poker_in_hand"):
            break
        act_idx = (act_idx + 1) % n
    room["poker_action_idx"] = act_idx
    room["active_player_id"] = players[act_idx]["id"]
    await poker_broadcast(room)
    schedule_bot_if_needed(room)

def poker_betting_complete(room):
    players = poker_active_list(room)
    if len(players) <= 1:
        return True
    cur = int(room.get("poker_current_bet", 0))
    for p in players:
        if p.get("poker_status") == "allin":
            continue
        if not p.get("poker_acted"):
            return False
        if int(p.get("poker_bet", 0)) != cur and p.get("poker_status") != "allin":
            return False
    return True

async def poker_advance_street(room):
    # reset bets for next street
    for p in poker_seated(room):
        p["poker_bet"] = 0
        p["poker_acted"] = False
        if p.get("poker_status") == "active":
            pass
    room["poker_current_bet"] = 0
    room["poker_min_raise"] = int(room.get("poker_big_blind", POKER_BIG_BLIND))
    room["poker_last_raiser"] = None
    street = room.get("poker_street", "PREFLOP")
    deck = room.get("poker_deck", [])
    if street == "PREFLOP":
        # burn + flop
        if deck: deck.pop()
        for _ in range(3):
            if deck:
                room["poker_community"].append(deck.pop())
        room["poker_street"] = "FLOP"
        room["poker_phase"] = "FLOP"
    elif street == "FLOP":
        if deck: deck.pop()
        if deck:
            room["poker_community"].append(deck.pop())
        room["poker_street"] = "TURN"
        room["poker_phase"] = "TURN"
    elif street == "TURN":
        if deck: deck.pop()
        if deck:
            room["poker_community"].append(deck.pop())
        room["poker_street"] = "RIVER"
        room["poker_phase"] = "RIVER"
    elif street == "RIVER":
        await poker_showdown(room)
        return
    # set first actor: left of dealer
    players = poker_seated(room)
    n = len(players)
    d_idx = int(room.get("poker_dealer_idx", 0))
    act_idx = (d_idx + 1) % n
    for _ in range(n):
        p = players[act_idx]
        if p.get("poker_in_hand") and p.get("poker_status") not in ("folded", "allin"):
            room["poker_action_idx"] = act_idx
            room["active_player_id"] = p["id"]
            await poker_broadcast(room)
            schedule_bot_if_needed(room)
            return
        act_idx = (act_idx + 1) % n
    # everyone all-in — run out
    await poker_runout(room)

async def poker_runout(room):
    """Deal remaining community cards when all remaining players are all-in."""
    deck = room.get("poker_deck", [])
    while len(room.get("poker_community", [])) < 5 and deck:
        if len(room["poker_community"]) in (0, 3, 4):
            if deck: deck.pop()  # burn
        if deck:
            room["poker_community"].append(deck.pop())
    room["poker_street"] = "RIVER"
    room["poker_phase"] = "RIVER"
    await poker_broadcast(room)
    await asyncio.sleep(1.0)
    await poker_showdown(room)

async def poker_showdown(room):
    room["poker_phase"] = "SHOWDOWN"
    room["active_player_id"] = None
    community = room.get("poker_community", [])
    contenders = [p for p in poker_seated(room) if p.get("poker_in_hand") and p.get("poker_status") != "folded"]
    for p in contenders:
        score = best_poker_hand(p.get("poker_hole", []), community)
        p["poker_score"] = score
        p["poker_hand_name"] = poker_hand_name(score)
    if not contenders:
        room["poker_phase"] = "HAND_OVER"
        await poker_broadcast(room)
        await asyncio.sleep(POKER_BETWEEN_HANDS_S)
        room["poker_phase"] = "WAITING"
        room["active_player_id"] = None
        await poker_broadcast(room)
        return
    best = max(p["poker_score"] for p in contenders)
    winners = [p for p in contenders if p["poker_score"] == best]
    pot = int(room.get("poker_pot", 0))
    share = pot // len(winners) if winners else 0
    remainder = pot - share * len(winners)
    winner_info = []
    for i, w in enumerate(winners):
        award = share + (remainder if i == 0 else 0)
        w["poker_chips"] = int(w.get("poker_chips", 0)) + award
        poker_sync_balance(w)
        winner_info.append({
            "id": w["id"], "username": w.get("username"),
            "amount": award, "handName": w.get("poker_hand_name"),
            "hole": [{"rank": c["rank"], "suit": c["suit"]} for c in w.get("poker_hole", [])],
        })
        account = ACCOUNTS.get(w.get("username_key"))
        if account is not None:
            ensure_account_progress(account)
            account["poker_wins"] = int(account.get("poker_wins", 0)) + 1
            account["wins"] = int(account.get("wins", 0)) + 1
            account["games_played"] = int(account.get("games_played", 0)) + 1
            add_xp(account, 25)
            account["season_xp"] = int(account.get("season_xp", 0)) + 25
            update_daily_progress(account, "win")
            gs = account.setdefault("game_stats", {}).setdefault("poker", {"games": 0, "wins": 0})
            gs["wins"] = account["poker_wins"]
            gs["games"] = int(gs.get("games", 0)) + 1
    # mark losers stats
    for p in contenders:
        if p not in winners:
            account = ACCOUNTS.get(p.get("username_key"))
            if account is not None:
                ensure_account_progress(account)
                account["losses"] = int(account.get("losses", 0)) + 1
                account["games_played"] = int(account.get("games_played", 0)) + 1
                add_xp(account, 8)
                account["season_xp"] = int(account.get("season_xp", 0)) + 8
                update_daily_progress(account, "lose")
                gs = account.setdefault("game_stats", {}).setdefault("poker", {"games": 0, "wins": 0})
                gs["games"] = int(gs.get("games", 0)) + 1
    room["poker_pot"] = 0
    room["poker_winners"] = winner_info
    room["poker_phase"] = "HAND_OVER"
    save_accounts()

    # Hand history
    try:
        push_hand_history(room, {
            "game": "poker",
            "ts": int(time.time()),
            "pot": sum(w.get("amount", 0) for w in winner_info),
            "community": [{"rank": c["rank"], "suit": c["suit"]} for c in community],
            "winners": [{"username": w.get("username"), "amount": w.get("amount"), "hand": w.get("handName")} for w in winner_info],
            "players": [
                {"username": p.get("username"), "status": p.get("poker_status"),
                 "hole": [{"rank": c["rank"], "suit": c["suit"]} for c in (p.get("poker_hole") or [])] if p.get("poker_status") != "folded" else []}
                for p in poker_seated(room) if p.get("poker_in_hand")
            ],
        })
    except Exception:
        pass

    # Bounty: winners who knocked out (zeroed) a bounty target
    bmap = room.get("bounties") or {}
    for w in winners:
        for other in contenders:
            if other in winners:
                continue
            bkey = other.get("username_key")
            bounty = int(bmap.get(bkey, 0) or 0)
            if bounty > 0 and int(other.get("poker_chips", 0)) == 0:
                w["poker_chips"] = int(w.get("poker_chips", 0)) + bounty
                poker_sync_balance(w)
                bmap[bkey] = 0
                if w.get("ws"):
                    try:
                        await w["ws"].send(json.dumps({"type":"info","message":f"Bounty claimed! +${bounty} for knocking out {other.get('username')}."}))
                    except Exception:
                        pass

    # Spectator bets on poker winner
    sbets = room.pop("spectator_bets", {}) or {}
    winner_ids = {w["id"] for w in winners}
    for sid, bet in sbets.items():
        spec = find_player(room, sid)
        if not spec:
            continue
        amt = int(bet.get("amount", 0))
        if bet.get("targetId") in winner_ids:
            spec["money"] = int(spec.get("money", 0)) + amt * 2
            persist_player_money(spec)
            if spec.get("ws"):
                try:
                    await spec["ws"].send(json.dumps({"type":"info","message":f"Spectator bet won +${amt}!"}))
                except Exception:
                    pass
        else:
            if spec.get("ws"):
                try:
                    await spec["ws"].send(json.dumps({"type":"info","message":f"Spectator bet lost (${amt})."}))
                except Exception:
                    pass

    for p in room.get("players", []):
        if try_auto_rebuy(p, room) and p.get("ws"):
            try:
                await p["ws"].send(json.dumps({"type":"info","message":f"Auto-rebuy: +${p.get('money')} chips."}))
            except Exception:
                pass

    room["poker_side_pots"] = []
    await poker_broadcast(room)
    # Interval after each hand — host must click START HAND for the next round
    await asyncio.sleep(POKER_BETWEEN_HANDS_S)
    await promote_pending_poker_players(room)
    room["poker_phase"] = "WAITING"
    room["active_player_id"] = None
    await poker_broadcast(room)
    await broadcast_public_tables()

async def poker_handle_action(room, player, action, amount=0):
    if room.get("game") != "poker":
        return False, "Not a poker table."
    if room.get("active_player_id") != player["id"]:
        return False, "Not your turn."
    phase = room.get("poker_phase", "WAITING")
    if phase not in ("PREFLOP", "FLOP", "TURN", "RIVER"):
        return False, "Betting is closed."
    if player.get("poker_status") in ("folded", "allin"):
        return False, "You cannot act."
    action = (action or "").lower().strip()
    cur_bet = int(room.get("poker_current_bet", 0))
    my_bet = int(player.get("poker_bet", 0))
    chips = int(player.get("poker_chips", 0))
    to_call = cur_bet - my_bet
    min_raise = int(room.get("poker_min_raise", room.get("poker_big_blind", POKER_BIG_BLIND)))

    if action == "fold":
        player["poker_status"] = "folded"
        player["poker_acted"] = True
        player["poker_in_hand"] = True  # still "in hand" for tracking but folded
        # actually mark folded
        active = [p for p in poker_seated(room) if p.get("poker_status") != "folded" and p.get("poker_in_hand")]
        if len(active) <= 1:
            # award pot to last remaining
            if active:
                w = active[0]
                pot = int(room.get("poker_pot", 0))
                w["poker_chips"] = int(w.get("poker_chips", 0)) + pot
                poker_sync_balance(w)
                room["poker_pot"] = 0
                room["poker_winners"] = [{"id": w["id"], "username": w.get("username"), "amount": pot, "handName": "Last standing", "hole": []}]
                room["poker_phase"] = "HAND_OVER"
                room["active_player_id"] = None
                await poker_broadcast(room)
                await asyncio.sleep(POKER_BETWEEN_HANDS_S)
                await promote_pending_poker_players(room)
                room["poker_phase"] = "WAITING"
                await poker_broadcast(room)
            return True, "ok"
    elif action == "check":
        if to_call > 0:
            return False, "Cannot check — there is a bet to call."
        player["poker_acted"] = True
    elif action == "call":
        pay = min(chips, to_call)
        if pay <= 0 and to_call > 0:
            return False, "Nothing to call."
        if to_call <= 0:
            player["poker_acted"] = True
        else:
            player["poker_chips"] = chips - pay
            player["poker_bet"] = my_bet + pay
            room["poker_pot"] = int(room.get("poker_pot", 0)) + pay
            player["poker_acted"] = True
            poker_sync_balance(player)
            if player["poker_chips"] == 0:
                player["poker_status"] = "allin"
    elif action in ("bet", "raise"):
        try:
            amount = int(amount)
        except (TypeError, ValueError):
            amount = 0
        if amount <= 0:
            return False, "Invalid amount."
        # amount is the total bet for this street (raise-to)
        if action == "bet" and cur_bet > 0:
            action = "raise"
        if action == "bet":
            if cur_bet > 0:
                return False, "Use raise when there is already a bet."
            if amount < min_raise and amount < chips:
                return False, f"Minimum bet is {min_raise}."
            pay = min(chips, amount)
            player["poker_chips"] = chips - pay
            player["poker_bet"] = my_bet + pay
            room["poker_pot"] = int(room.get("poker_pot", 0)) + pay
            room["poker_current_bet"] = player["poker_bet"]
            room["poker_min_raise"] = pay
            room["poker_last_raiser"] = player["id"]
            player["poker_acted"] = True
            # reset acted for others
            for op in poker_seated(room):
                if op["id"] != player["id"] and op.get("poker_status") not in ("folded", "allin"):
                    op["poker_acted"] = False
            poker_sync_balance(player)
            if player["poker_chips"] == 0:
                player["poker_status"] = "allin"
        else:  # raise
            # amount = total bet level to raise TO
            raise_to = amount
            if raise_to < cur_bet + min_raise and raise_to - my_bet < chips:
                return False, f"Minimum raise is to {cur_bet + min_raise}."
            pay = min(chips, raise_to - my_bet)
            if pay <= 0:
                return False, "Invalid raise."
            player["poker_chips"] = chips - pay
            player["poker_bet"] = my_bet + pay
            room["poker_pot"] = int(room.get("poker_pot", 0)) + pay
            raise_size = player["poker_bet"] - cur_bet
            room["poker_current_bet"] = player["poker_bet"]
            if raise_size > 0:
                room["poker_min_raise"] = raise_size
            room["poker_last_raiser"] = player["id"]
            player["poker_acted"] = True
            for op in poker_seated(room):
                if op["id"] != player["id"] and op.get("poker_status") not in ("folded", "allin"):
                    op["poker_acted"] = False
            poker_sync_balance(player)
            if player["poker_chips"] == 0:
                player["poker_status"] = "allin"
    elif action == "allin":
        pay = chips
        if pay <= 0:
            return False, "No chips left."
        player["poker_chips"] = 0
        player["poker_bet"] = my_bet + pay
        room["poker_pot"] = int(room.get("poker_pot", 0)) + pay
        player["poker_status"] = "allin"
        player["poker_acted"] = True
        poker_sync_balance(player)
        if player["poker_bet"] > cur_bet:
            raise_size = player["poker_bet"] - cur_bet
            room["poker_current_bet"] = player["poker_bet"]
            if raise_size >= min_raise:
                room["poker_min_raise"] = raise_size
                room["poker_last_raiser"] = player["id"]
                for op in poker_seated(room):
                    if op["id"] != player["id"] and op.get("poker_status") not in ("folded", "allin"):
                        op["poker_acted"] = False
    else:
        return False, "Unknown action."

    # check if only one left
    active = [p for p in poker_seated(room) if p.get("poker_status") != "folded" and p.get("poker_in_hand")]
    if len(active) <= 1:
        if active:
            w = active[0]
            pot = int(room.get("poker_pot", 0))
            w["poker_chips"] = int(w.get("poker_chips", 0)) + pot
            poker_sync_balance(w)
            room["poker_pot"] = 0
            room["poker_winners"] = [{"id": w["id"], "username": w.get("username"), "amount": pot, "handName": "Last standing", "hole": []}]
            room["poker_phase"] = "HAND_OVER"
            room["active_player_id"] = None
            await poker_broadcast(room)
            await asyncio.sleep(POKER_BETWEEN_HANDS_S)
            await promote_pending_poker_players(room)
            room["poker_phase"] = "WAITING"
            await poker_broadcast(room)
            await broadcast_public_tables()
        return True, "ok"

    try:
        compute_poker_side_pots(room)
    except Exception:
        pass
    if poker_betting_complete(room):
        # if all remaining are all-in or only one can act, run out
        can_act = [p for p in active if p.get("poker_status") != "allin"]
        if len(can_act) <= 1 and len(room.get("poker_community", [])) < 5:
            await poker_broadcast(room)
            await asyncio.sleep(0.6)
            await poker_runout(room)
        else:
            await poker_broadcast(room)
            await asyncio.sleep(0.4)
            await poker_advance_street(room)
    else:
        # next player
        players = poker_seated(room)
        n = len(players)
        idx = int(room.get("poker_action_idx", 0))
        for _ in range(n):
            idx = (idx + 1) % n
            p = players[idx]
            if p.get("poker_in_hand") and p.get("poker_status") not in ("folded", "allin"):
                room["poker_action_idx"] = idx
                room["active_player_id"] = p["id"]
                break
        await poker_broadcast(room)
        schedule_bot_if_needed(room)
    return True, "ok"

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
            try:
                asyncio.create_task(broadcast_presence())
            except Exception:
                pass
            save_accounts()
            await websocket.send(json.dumps({"type": "auth_ok", "mode": "signup", "username": username, "balance": STARTING_MONEY, "token": token, "profile": profile_payload(ACCOUNTS[key]), "developer": developer_public_payload()}))
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
            await websocket.send(json.dumps({"type": "auth_ok", "mode": "login", "username": account["username"], "balance": account["money"], "token": token, "profile": profile_payload(account), "developer": developer_public_payload()}))
            continue

        if kind == "resume":
            token = msg.get("token")
            key = TOKENS.get(token)
            if key in ACCOUNTS and ACCOUNTS[key].get("session_token") == token:
                account = ACCOUNTS[key]
                ensure_account_progress(account)
                USER_SOCKETS[key] = websocket
                await websocket.send(json.dumps({"type": "auth_ok", "mode": "resume", "username": account["username"], "balance": account.get("money",0), "token": token, "profile": profile_payload(account), "developer": developer_public_payload()}))
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
            if game in ("blackjack","poker"): tables=[t for t in tables if t.get("game")==game]
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
            if game not in ("blackjack", "poker"): game = "blackjack"
            max_players = msg.get("maxPlayers", POKER_MAX_PLAYERS if game == "poker" else MAX_PLAYERS_DEFAULT)
            # Optional 4-digit PIN — if set, table is private (not listed) and join requires pin
            pin_raw = str(msg.get("pin") or msg.get("password") or "").strip()
            pin = None
            if pin_raw:
                if not (pin_raw.isdigit() and len(pin_raw) == 4):
                    await websocket.send(json.dumps({"type":"error","message":"Table PIN must be exactly 4 digits."}))
                    continue
                pin = pin_raw
            is_public = not bool(pin)
            room = get_room(code, public=is_public, game=game, max_players=max_players)
            room["pin"] = pin
            if game == "poker":
                try:
                    buyin = int(msg.get("buyIn", POKER_DEFAULT_BUYIN))
                except (TypeError, ValueError):
                    buyin = POKER_DEFAULT_BUYIN
                room["poker_buyin"] = max(POKER_MIN_BUYIN, min(POKER_MAX_BUYIN, buyin))
                room["poker_phase"] = "WAITING"
                room["phase"] = "WAITING"
            created_msg = {"type":"public_created","code":code,"game":game,"maxPlayers":rooms[code].get("max_players", MAX_PLAYERS_DEFAULT),"locked":bool(pin),"pin":pin if pin else None}
            if game == "poker":
                created_msg["buyIn"] = room.get("poker_buyin")
            await websocket.send(json.dumps(created_msg))
            await send_public_tables(websocket)
            continue

        if kind == "presence":
            key = TOKENS.get(msg.get("token"))
            if key:
                bump_play_time(key, 20)
            await websocket.send(json.dumps(presence_payload()))
            continue

        if kind == "leaderboard_playtime":
            await websocket.send(json.dumps({"type": "leaderboard_playtime", "leaderboard": leaderboard_playtime_payload()}))
            continue

        if kind == "friends":
            key = TOKENS.get(msg.get("token"))
            if key in ACCOUNTS:
                acc = ACCOUNTS[key]
                acc.setdefault("friend_requests", [])
                acc.setdefault("friend_outgoing", [])
                await websocket.send(json.dumps({
                    "type":"friends",
                    "friends":friends_payload(acc),
                    "requests":friend_requests_payload(acc),
                    "outgoing":friend_outgoing_payload(acc),
                }))
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
            me = ACCOUNTS[key]
            target = ACCOUNTS[target_key]
            me.setdefault("friends", []); me.setdefault("friend_requests", []); me.setdefault("friend_outgoing", [])
            target.setdefault("friends", []); target.setdefault("friend_requests", []); target.setdefault("friend_outgoing", [])
            if target_key in set(me.get("friends", [])):
                await websocket.send(json.dumps({"type":"error","scope":"friends","message":"Already friends."}))
                continue
            # If they already requested us → auto-accept
            if target_key in set(me.get("friend_requests", [])):
                me["friends"] = sorted(set(me.get("friends", [])) | {target_key})
                target["friends"] = sorted(set(target.get("friends", [])) | {key})
                me["friend_requests"] = [x for x in me.get("friend_requests", []) if x != target_key]
                target["friend_outgoing"] = [x for x in target.get("friend_outgoing", []) if x != key]
                me["friend_outgoing"] = [x for x in me.get("friend_outgoing", []) if x != target_key]
                target["friend_requests"] = [x for x in target.get("friend_requests", []) if x != key]
                save_accounts()
                await websocket.send(json.dumps({"type":"friends","friends":friends_payload(me),"requests":friend_requests_payload(me),"outgoing":friend_outgoing_payload(me)}))
                tws = USER_SOCKETS.get(target_key)
                if tws:
                    try:
                        await tws.send(json.dumps({"type":"friends","friends":friends_payload(target),"requests":friend_requests_payload(target),"outgoing":friend_outgoing_payload(target)}))
                        await tws.send(json.dumps({"type":"friend_event","event":"accepted","username":me.get("username")}))
                    except Exception:
                        pass
                continue
            if target_key in set(me.get("friend_outgoing", [])):
                await websocket.send(json.dumps({"type":"error","scope":"friends","message":"Request already sent."}))
                continue
            # Send request
            me["friend_outgoing"] = sorted(set(me.get("friend_outgoing", [])) | {target_key})
            target["friend_requests"] = sorted(set(target.get("friend_requests", [])) | {key})
            save_accounts()
            await websocket.send(json.dumps({"type":"friends","friends":friends_payload(me),"requests":friend_requests_payload(me),"outgoing":friend_outgoing_payload(me)}))
            tws = USER_SOCKETS.get(target_key)
            if tws:
                try:
                    await tws.send(json.dumps({"type":"friends","friends":friends_payload(target),"requests":friend_requests_payload(target),"outgoing":friend_outgoing_payload(target)}))
                    await tws.send(json.dumps({"type":"friend_event","event":"request","username":me.get("username")}))
                except Exception:
                    pass
            continue

        if kind == "accept_friend":
            key = TOKENS.get(msg.get("token"))
            target_key = username_key(msg.get("username"))
            if key not in ACCOUNTS or target_key not in ACCOUNTS:
                await websocket.send(json.dumps({"type":"error","scope":"friends","message":"Player not found."}))
                continue
            me = ACCOUNTS[key]; target = ACCOUNTS[target_key]
            me.setdefault("friend_requests", []); me.setdefault("friends", [])
            target.setdefault("friend_outgoing", []); target.setdefault("friends", [])
            if target_key not in set(me.get("friend_requests", [])):
                await websocket.send(json.dumps({"type":"error","scope":"friends","message":"No pending request from that player."}))
                continue
            me["friends"] = sorted(set(me.get("friends", [])) | {target_key})
            target["friends"] = sorted(set(target.get("friends", [])) | {key})
            me["friend_requests"] = [x for x in me.get("friend_requests", []) if x != target_key]
            target["friend_outgoing"] = [x for x in target.get("friend_outgoing", []) if x != key]
            save_accounts()
            await websocket.send(json.dumps({"type":"friends","friends":friends_payload(me),"requests":friend_requests_payload(me),"outgoing":friend_outgoing_payload(me)}))
            tws = USER_SOCKETS.get(target_key)
            if tws:
                try:
                    await tws.send(json.dumps({"type":"friends","friends":friends_payload(target),"requests":friend_requests_payload(target),"outgoing":friend_outgoing_payload(target)}))
                    await tws.send(json.dumps({"type":"friend_event","event":"accepted","username":me.get("username")}))
                except Exception:
                    pass
            continue

        if kind == "decline_friend":
            key = TOKENS.get(msg.get("token"))
            target_key = username_key(msg.get("username"))
            if key in ACCOUNTS:
                me = ACCOUNTS[key]
                me["friend_requests"] = [x for x in me.get("friend_requests", []) if x != target_key]
                if target_key in ACCOUNTS:
                    ACCOUNTS[target_key]["friend_outgoing"] = [x for x in ACCOUNTS[target_key].get("friend_outgoing", []) if x != key]
                save_accounts()
                await websocket.send(json.dumps({"type":"friends","friends":friends_payload(me),"requests":friend_requests_payload(me),"outgoing":friend_outgoing_payload(me)}))
            continue

        if kind == "remove_friend":
            key = TOKENS.get(msg.get("token"))
            target_key = username_key(msg.get("username"))
            if key in ACCOUNTS:
                ACCOUNTS[key]["friends"] = [x for x in ACCOUNTS[key].get("friends", []) if x != target_key]
                if target_key in ACCOUNTS:
                    ACCOUNTS[target_key]["friends"] = [x for x in ACCOUNTS[target_key].get("friends", []) if x != key]
                save_accounts()
                acc = ACCOUNTS[key]
                await websocket.send(json.dumps({"type":"friends","friends":friends_payload(acc),"requests":friend_requests_payload(acc),"outgoing":friend_outgoing_payload(acc)}))
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


        if kind == "reaction":
            # Quick emoji float above a seat — zero persistent load
            if room is None or player is None:
                continue
            emoji = str(msg.get("emoji") or "")[:4]
            allowed = {"👏", "🔥", "💀", "😂", "❤️", "😮", "👍", "🎉"}
            if emoji not in allowed:
                continue
            target_id = msg.get("targetId") or player["id"]
            payload = json.dumps({
                "type": "reaction",
                "emoji": emoji,
                "fromId": player["id"],
                "fromName": player.get("username"),
                "targetId": target_id,
                "ts": int(time.time() * 1000),
            })
            for rp in room.get("players", []):
                if rp.get("ws"):
                    try:
                        await rp["ws"].send(payload)
                    except Exception:
                        pass
            continue

        if kind == "hand_history":
            if room is None:
                continue
            await websocket.send(json.dumps({
                "type": "hand_history",
                "history": list(room.get("hand_history") or []),
            }))
            continue

        if kind == "set_auto_rebuy":
            key = TOKENS.get(msg.get("token")) or (player.get("username_key") if player else None)
            if key not in ACCOUNTS:
                continue
            acc = ACCOUNTS[key]
            ensure_account_progress(acc)
            acc["auto_rebuy"] = bool(msg.get("enabled"))
            try:
                amt = int(msg.get("amount", acc.get("auto_rebuy_amount", 1000)))
            except (TypeError, ValueError):
                amt = 1000
            acc["auto_rebuy_amount"] = max(100, min(50000, amt))
            save_accounts()
            await websocket.send(json.dumps({"type": "profile", "profile": profile_payload(acc)}))
            await websocket.send(json.dumps({"type": "info", "message": f"Auto-rebuy {'ON' if acc['auto_rebuy'] else 'OFF'} (${acc['auto_rebuy_amount']})."}))
            continue

        if kind == "admin_announce":
            if not is_authorized_admin(websocket, room, player):
                continue
            text_msg = " ".join(str(msg.get("text") or "").split())[:120]
            if not text_msg:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Announcement text required."}))
                continue
            room["announcement"] = {"text": text_msg, "expires_at": time.time() + 8, "from": player.get("username")}
            payload = json.dumps({"type": "announcement", "text": text_msg, "from": player.get("username")})
            for rp in room.get("players", []):
                if rp.get("ws"):
                    try:
                        await rp["ws"].send(payload)
                    except Exception:
                        pass
            await websocket.send(json.dumps({"type":"admin_ok","message":"Announcement sent."}))
            continue

        if kind == "admin_set_bounty":
            if not is_authorized_admin(websocket, room, player):
                continue
            target = find_player(room, msg.get("targetId"))
            try:
                amount = int(msg.get("amount", 0))
            except (TypeError, ValueError):
                amount = 0
            if not target or amount < 0 or amount > 1_000_000:
                continue
            key = target.get("username_key")
            bmap = room.setdefault("bounties", {})
            if amount == 0:
                bmap.pop(key, None)
            else:
                bmap[key] = amount
            if room.get("game") == "poker":
                await poker_broadcast(room)
            else:
                await broadcast(room)
            await websocket.send(json.dumps({"type":"admin_ok","message":f"Bounty on {target.get('username')}: ${amount}."}))
            await send_admin_data(websocket, room)
            continue

        if kind == "spectator_bet":
            if room is None or player is None:
                continue
            if not player.get("spectator"):
                await websocket.send(json.dumps({"type":"error","message":"Only spectators can place spectator bets."}))
                continue
            target = find_player(room, msg.get("targetId"))
            try:
                amount = int(msg.get("amount", 0))
            except (TypeError, ValueError):
                amount = 0
            if not target or target.get("spectator") or amount < 10 or amount > 50000:
                await websocket.send(json.dumps({"type":"error","message":"Invalid spectator bet."}))
                continue
            if int(player.get("money", 0)) < amount:
                await websocket.send(json.dumps({"type":"error","message":"Not enough chips."}))
                continue
            # one open bet per spectator
            sbet = room.setdefault("spectator_bets", {})
            if player["id"] in sbet:
                await websocket.send(json.dumps({"type":"error","message":"You already have a spectator bet this round."}))
                continue
            player["money"] = int(player["money"]) - amount
            persist_player_money(player)
            sbet[player["id"]] = {"targetId": target["id"], "amount": amount, "spectatorId": player["id"]}
            await websocket.send(json.dumps({"type":"info","message":f"Spectator bet ${amount} on {target.get('username')}."}))
            continue

        if kind == "profile":
            key = TOKENS.get(msg.get("token"))
            if key: bump_play_time(key)

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
                    base_reward = 250
                    vip_bonus = VIP_DAILY_BONUS if vip_active(account) else 0
                    total_reward = base_reward + vip_bonus
                    account["money"] = int(account.get("money", 0)) + total_reward
                    account["daily_claim"] = today_key()
                    add_xp(account, 25)
                    unlock_achievements(account)
                    save_accounts()
                    await websocket.send(json.dumps({"type":"daily_claimed", "amount":total_reward, "vipBonus":vip_bonus, "profile":profile_payload(account)}))
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

        if kind == "buy_vip":
            key=TOKENS.get(msg.get("token")); account=ACCOUNTS.get(key)
            if account is None:
                continue
            ensure_account_progress(account); ensure_wealth_progress(account)
            price = current_vip_price()
            if int(account.get("money", 0)) < price:
                await websocket.send(json.dumps({"type":"error","scope":"store","message":f"VIP costs ${price:,} in-game chips for {VIP_DURATION_DAYS} days."}))
                continue
            now = time.time()
            base = max(now, float(account.get("vip_until", 0) or 0))
            account["vip_until"] = base + VIP_DURATION_DAYS * 86400
            account["vip_purchases"] = int(account.get("vip_purchases", 0) or 0) + 1
            for owned_key, item_id in (("owned_profile_frames","vip_crown"),("owned_profile_backgrounds","vip_private"),("owned_profile_titles","vip_member"),("owned_casino_items","room_vip_private")):
                account[owned_key] = sorted(set(account.get(owned_key, [])) | {item_id})
            account["money"] = int(account.get("money", 0)) - price
            save_accounts()
            await websocket.send(json.dumps({"type":"vip_purchased","vip":vip_payload(account),"store":store_payload(account),"profile":profile_payload(account)}))
            await websocket.send(json.dumps({"type":"balance","balance":int(account.get("money",0))}))
            continue

        if kind == "buy_cosmetic":
            key=TOKENS.get(msg.get("token")); account=ACCOUNTS.get(key); category=str(msg.get("category","")); item_id=str(msg.get("id",""))
            meta=STORE_CATALOGS.get(category)
            if account is not None and meta:
                catalog, owned_key, equipped_key = meta
                ensure_wealth_progress(account)
                if item_id not in catalog:
                    await websocket.send(json.dumps({"type":"error","scope":"store","message":"That item does not exist."}))
                    continue
                item=catalog[item_id]
                owned=set(account.get(owned_key,[]))
                if item_id in owned:
                    await websocket.send(json.dumps({"type":"store","store":store_payload(account)}))
                elif item.get("admin_only"):
                    await websocket.send(json.dumps({"type":"error","scope":"store","message":"That item can only be granted by an authorized admin."}))
                elif item.get("limited"):
                    await websocket.send(json.dumps({"type":"error","scope":"store","message":"Limited items are earned through the active season."}))
                elif item.get("vip_only") and not vip_active(account):
                    await websocket.send(json.dumps({"type":"error","scope":"store","message":"That item is reserved for active VIP members."}))
                elif int(account.get("money",0)) < int(item.get("price",0)):
                    await websocket.send(json.dumps({"type":"error","scope":"store","message":"Not enough chips for that purchase."}))
                else:
                    account["money"] = int(account.get("money",0)) - int(item.get("price",0))
                    owned.add(item_id); account[owned_key]=sorted(owned)
                    save_accounts()
                    await websocket.send(json.dumps({"type":"store","store":store_payload(account),"purchased":item_id}))
                    await websocket.send(json.dumps({"type":"profile","profile":profile_payload(account)}))
                    await websocket.send(json.dumps({"type":"balance","balance":int(account.get("money",0))}))
            continue

        if kind == "equip_cosmetic":
            key=TOKENS.get(msg.get("token")); account=ACCOUNTS.get(key); category=str(msg.get("category","")); item_id=str(msg.get("id",""))
            meta=STORE_CATALOGS.get(category)
            if account is not None and meta:
                catalog, owned_key, equipped_key = meta
                ensure_wealth_progress(account)
                if item_id not in catalog or item_id not in set(account.get(owned_key,[])):
                    continue
                if category == "casino":
                    slot = catalog[item_id].get("slot", "feature")
                    equipped = dict(account.get(equipped_key, {})); equipped[slot] = item_id; account[equipped_key] = equipped
                else:
                    account[equipped_key] = item_id
                save_accounts()
                for r in rooms.values():
                    for p in r.get("players",[]):
                        if p.get("username_key")==key:
                            p.setdefault("cosmetics",{})[category]=item_id
                await websocket.send(json.dumps({"type":"store","store":store_payload(account),"equipped":item_id}))
                await websocket.send(json.dumps({"type":"profile","profile":profile_payload(account)}))
                for r in rooms.values():
                    if any(p.get("username_key")==key for p in r.get("players",[])):
                        await (poker_broadcast(r) if r.get("game")=="poker" else broadcast(r))
            continue

        if kind == "claim_season":
            key = TOKENS.get(msg.get("token")); account = ACCOUNTS.get(key)
            tier_id = str(msg.get("tier"))
            if account is not None:
                ensure_account_progress(account)
                # Keep season_id aligned so payload does not wipe XP mid-claim
                if int(account.get("season_id", 0) or 0) != int(SEASON["id"]):
                    account["season_id"] = int(SEASON["id"])
                match = next((t for t in SEASON["tiers"] if str(t["tier"])==tier_id), None)
                claimed=set(str(x) for x in account.get("season_claimed",[]))
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
                    claimed.add(tier_id); account["season_claimed"]=sorted(claimed, key=lambda x: int(x) if str(x).isdigit() else 0); save_accounts()
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
            if game not in ("blackjack", "poker"):
                game = "blackjack"
            spectate = bool(msg.get("spectate"))
            if spectate and code not in rooms:
                await websocket.send(json.dumps({"type":"error","message":"That table does not exist."}))
                room = None
                continue
            # Existing locked table: validate PIN before creating empty room via get_room
            if code in rooms and rooms[code].get("pin"):
                supplied = str(msg.get("pin") or msg.get("password") or "").strip()
                if not hmac.compare_digest(supplied, str(rooms[code]["pin"])):
                    await websocket.send(json.dumps({"type":"error","scope":"table","message":"Incorrect table PIN.","code":"bad_pin"}))
                    room = None
                    continue
            room = get_room(code, game=game)
            if room.get("game") != game:
                await websocket.send(json.dumps({"type":"error","scope":"table","message":"That table belongs to another game."})); room=None; continue
            # PIN check again for rooms that just got created without pin in msg (join private by code)
            if room.get("pin"):
                supplied = str(msg.get("pin") or msg.get("password") or "").strip()
                if not hmac.compare_digest(supplied, str(room["pin"])):
                    await websocket.send(json.dumps({"type":"error","scope":"table","message":"Incorrect table PIN.","code":"bad_pin"}))
                    # if we just created an empty room by mistake, drop it
                    if not room.get("players"):
                        rooms.pop(code, None)
                    room = None
                    continue
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
            auto_spec = False
            if not spectate and connected_count >= max_p:
                await websocket.send(json.dumps({
                    "type": "error",
                    "code": "table_full",
                    "scope": "table",
                    "message": "Table full — Spectate instead?",
                    "room": code,
                    "game": room.get("game", "blackjack"),
                }))
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
                        if was_active_old and r_old.get("game") != "poker":
                            r_old["active_player_id"] = None
                            try:
                                await move_to_next_or_dealer(r_old)
                            except Exception:
                                pass
                        else:
                            await (poker_broadcast(r_old) if r_old.get("game") == "poker" else broadcast(r_old))

            player = {
                "id": pid,
                "ws": websocket,
                "name": account["username"],
                "username": account["username"],
                "username_key": account_key,
                "money": int(account.get("money", STARTING_MONEY)),
                "is_admin": bool(account.get("is_admin")),
                "bet": 0,
                "hand": [],
                "status": "betting",
                "spectator": False,
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
                "poker_chips": 0,
                "poker_bet": 0,
                "poker_hole": [],
                "poker_status": "waiting",
                "poker_in_hand": False,
                "poker_is_dealer": False,
                "poker_is_sb": False,
                "poker_is_bb": False,
                "poker_acted": False,
                "poker_hand_name": None,
            }
            # Seating rules
            is_poker = room.get("game") == "poker"
            seated_now = sum(1 for p in room["players"] if p.get("connected") and not p.get("spectator"))
            player["pending_seat"] = False
            if spectate or seated_now >= max_p:
                player["spectator"] = True
                player["status"] = "spectating"
            elif is_poker:
                poker_phase = room.get("poker_phase") or "WAITING"
                mid_hand = poker_phase in ("PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN")
                if mid_hand:
                    # Join mid-hand as spectator; auto-seat when the hand ends
                    player["spectator"] = True
                    player["status"] = "spectating"
                    player["pending_seat"] = True
                elif int(player.get("money", 0)) >= POKER_MIN_BUYIN:
                    ok, _ = poker_seat_with_buyin(player, room)
                    if not ok:
                        player["spectator"] = True
                        player["status"] = "spectating"
                        player["pending_seat"] = True
                else:
                    player["spectator"] = True
                    player["status"] = "spectating"
            else:
                # Blackjack: can only sit during lobby/betting; otherwise spectate mid-hand
                if room["phase"] not in ("LOBBY", "BETTING"):
                    player["spectator"] = True
                    player["status"] = "spectating"
                    player["pending_seat"] = True
                else:
                    player["spectator"] = False
                    player["status"] = "betting"
            if room.get("host_id") is None:
                room["host_id"] = pid
            room["players"].append(player)
            invalidate_dealer_preview(room)
            if room["phase"] == "LOBBY" and room.get("game") != "poker":
                room["phase"] = "BETTING"
            if room.get("game") == "poker":
                room["phase"] = "WAITING"
                room["poker_phase"] = room.get("poker_phase") or "WAITING"

            await websocket.send(json.dumps({
                "type": "joined", "id": pid, "room": code, "game": room.get("game","blackjack"),
                "username": account["username"], "balance": player["money"], "isHost": room["host_id"] == pid,
                "spectator": bool(player.get("spectator")),
            }))
            if room.get("game") == "poker":
                await poker_broadcast(room)
                # Host must click START HAND — no auto-start
            else:
                await broadcast(room)
            await broadcast_public_tables()
            continue


        
        
        if kind == "admin_grant_item":
            if websocket not in ADMIN_SOCKETS:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Admin only."}))
                continue
            target_key = username_key(msg.get("username") or "")
            category = str(msg.get("category") or "").lower()
            item_id = str(msg.get("id") or "")
            catalogs = {"theme": COSMETIC_THEMES, "chip": COSMETIC_CHIPS, "deck": COSMETIC_DECKS, "table": COSMETIC_TABLES, "ball": COSMETIC_BALLS}
            cat = catalogs.get(category)
            if not cat or item_id not in cat or target_key not in ACCOUNTS:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Invalid item or player."}))
                continue
            account = ACCOUNTS[target_key]
            ensure_account_progress(account)
            key_map = {"theme":"owned_themes","chip":"owned_chips","deck":"owned_decks","table":"owned_tables","ball":"owned_balls"}
            own_key = key_map[category]
            owned = set(account.get(own_key, []))
            owned.add(item_id)
            account[own_key] = sorted(owned)
            save_accounts()
            await websocket.send(json.dumps({"type":"admin_ok","message":f"Granted {item_id} to {account.get('username')}"}))
            # notify target if online
            ws = USER_SOCKETS.get(target_key)
            if ws:
                try:
                    await ws.send(json.dumps({"type":"store","store":store_payload(account)}))
                    await ws.send(json.dumps({"type":"profile","profile":profile_payload(account)}))
                except Exception:
                    pass
            continue


        if kind == "change_password":
            key = TOKENS.get(msg.get("token"))
            account = ACCOUNTS.get(key)
            if not account:
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "Not logged in."}))
                continue
            current = str(msg.get("currentPassword") or "")
            new_pass = str(msg.get("newPassword") or "")
            if not verify_password(current, account["salt"], account["password"]):
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "Current password is incorrect."}))
                continue
            if len(new_pass) < 8:
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "New password must be at least 8 characters."}))
                continue
            salt, digest = hash_password(new_pass)
            account["salt"] = salt
            account["password"] = digest
            save_accounts()
            await websocket.send(json.dumps({"type": "profile_ok", "message": "Password updated."}))
            continue

        if kind == "change_username":
            key = TOKENS.get(msg.get("token"))
            account = ACCOUNTS.get(key)
            if not account:
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "Not logged in."}))
                continue
            current = str(msg.get("password") or "")
            new_name = (msg.get("newUsername") or "").strip()
            if not verify_password(current, account["salt"], account["password"]):
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "Password is incorrect."}))
                continue
            if len(new_name) < 3 or len(new_name) > 16 or not new_name.replace("_","").isalnum():
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "Username must be 3–16 letters, numbers, or underscores."}))
                continue
            new_key = new_name.lower()
            if new_key != key and new_key in ACCOUNTS:
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "That username is taken."}))
                continue
            old_user = account.get("username")
            account["username"] = new_name
            if new_key != key:
                # migrate account key
                ACCOUNTS[new_key] = account
                del ACCOUNTS[key]
                # re-map tokens
                for tok, k in list(TOKENS.items()):
                    if k == key:
                        TOKENS[tok] = new_key
                # update in rooms
                for r in rooms.values():
                    for p in r.get("players", []):
                        if p.get("username_key") == key:
                            p["username_key"] = new_key
                            p["username"] = new_name
                            p["name"] = new_name
            else:
                for r in rooms.values():
                    for p in r.get("players", []):
                        if p.get("username_key") == key:
                            p["username"] = new_name
                            p["name"] = new_name
            save_accounts()
            await websocket.send(json.dumps({
                "type": "profile_ok",
                "message": "Username changed.",
                "username": new_name,
                "profile": profile_payload(ACCOUNTS[new_key if new_key in ACCOUNTS else key]),
            }))
            continue

        if kind == "delete_account":
            key = TOKENS.get(msg.get("token"))
            account = ACCOUNTS.get(key)
            if not account:
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "Not logged in."}))
                continue
            current = str(msg.get("password") or "")
            if not verify_password(current, account["salt"], account["password"]):
                await websocket.send(json.dumps({"type": "error", "scope": "profile", "message": "Password is incorrect."}))
                continue
            # remove from rooms
            for code, r in list(rooms.items()):
                r["players"] = [p for p in r.get("players", []) if p.get("username_key") != key]
            for tok, k in list(TOKENS.items()):
                if k == key:
                    TOKENS.pop(tok, None)
            ACCOUNTS.pop(key, None)
            save_accounts()
            await websocket.send(json.dumps({"type": "account_deleted", "message": "Account deleted."}))
            continue

        if kind == "admin_login":
            password = msg.get("password") or ""
            if not room or not player:
                await websocket.send(json.dumps({"type": "error", "scope": "admin", "message": "Admin controls are only available inside a game table."}))
                continue
            if ADMIN_PASSWORD and hmac.compare_digest(password, ADMIN_PASSWORD):
                ADMIN_SOCKETS.add(websocket)
                # Permanent admin flag on account
                acc = ACCOUNTS.get(player.get("username_key"))
                if acc is not None:
                    ensure_account_progress(acc)
                    acc["is_admin"] = True
                    player["is_admin"] = True
                    save_accounts()
                await websocket.send(json.dumps({"type": "admin_ok", "isAdmin": True}))
                # refresh profile so client sees permanent flag
                if acc is not None:
                    try:
                        await websocket.send(json.dumps({"type": "profile", "profile": profile_payload(acc)}))
                    except Exception:
                        pass
                await send_admin_data(websocket, room)
                # broadcast so others see gold name
                if room.get("game") == "poker":
                    await poker_broadcast(room)
                else:
                    await broadcast(room)
            else:
                await websocket.send(json.dumps({"type": "error", "scope": "admin", "message": "Incorrect admin password."}))
            continue


        if kind == "poker_state":
            if room and player and room.get("game") == "poker":
                try:
                    await websocket.send(json.dumps({"type": "poker_state", "state": poker_serialise(room, viewer_id=player["id"])}))
                except Exception:
                    pass
            continue

        if kind == "add_bot":
            if not room or not player:
                await websocket.send(json.dumps({"type": "error", "message": "Join a table first."}))
                continue
            if room.get("game") != "poker":
                await websocket.send(json.dumps({"type": "error", "message": "Bots are available at Poker tables only."}))
                continue
            if room.get("host_id") != player.get("id"):
                await websocket.send(json.dumps({"type": "error", "message": "Only the host can add bots."}))
                continue
            try:
                count = int(msg.get("count", 1))
            except (TypeError, ValueError):
                count = 1
            count = max(1, min(5, count))
            added = 0
            for _ in range(count):
                max_p = int(room.get("max_players", POKER_MAX_PLAYERS))
                seated = sum(1 for p in room["players"] if p.get("connected") and not p.get("spectator"))
                total = sum(1 for p in room["players"] if p.get("connected"))
                if total >= max_p + 4:
                    break
                bot = create_poker_bot(room)
                # Bots use table buy-in as their stack
                buyin = int(room.get("poker_buyin", POKER_DEFAULT_BUYIN) or POKER_DEFAULT_BUYIN)
                bot["poker_chips"] = buyin
                bot["money"] = buyin
                phase = room.get("poker_phase") or "WAITING"
                mid_hand = phase in ("PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN")
                if mid_hand or seated >= max_p:
                    bot["spectator"] = True
                    bot["status"] = "spectating"
                    bot["pending_seat"] = True
                else:
                    bot["spectator"] = False
                    bot["status"] = "waiting"
                    bot["poker_status"] = "waiting"
                room["players"].append(bot)
                added += 1
            if added:
                await poker_broadcast(room)
                await broadcast_public_tables()
                await websocket.send(json.dumps({"type": "info", "message": f"Added {added} bot{'s' if added != 1 else ''}."}))
            else:
                await websocket.send(json.dumps({"type": "error", "message": "No room for more bots."}))
            continue

        if kind == "poker_action":
            if not room or not player or room.get("game") != "poker":
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "Not at a poker table."}))
                continue
            ok, err = await poker_handle_action(room, player, msg.get("action"), msg.get("amount", 0))
            if not ok:
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": err}))
            continue

        if kind == "poker_start":
            if not room or not player or room.get("game") != "poker":
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "You are not at a poker table."}))
                continue
            # If host left, promote current requester as host so the table is not stuck
            if room.get("host_id") not in {p.get("id") for p in room.get("players", []) if p.get("connected")}:
                room["host_id"] = player.get("id")
            if room.get("host_id") != player.get("id"):
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "Only the table host can start the hand."}))
                continue
            phase = room.get("poker_phase") or "WAITING"
            if phase not in ("WAITING", "HAND_OVER", "LOBBY"):
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": f"Hand already in progress ({phase})."}))
                continue
            seated = poker_with_chips(room)
            if len(seated) < POKER_MIN_PLAYERS:
                await websocket.send(json.dumps({
                    "type": "error",
                    "scope": "poker",
                    "message": f"Need at least {POKER_MIN_PLAYERS} players with chips to start (currently {len(seated)})."
                }))
                await poker_broadcast(room)
                continue
            await poker_start_hand(room)
            continue

        if kind == "poker_buyin":
            if not room or not player or room.get("game") != "poker":
                continue
            if room.get("poker_phase") in ("PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN"):
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "Wait for the current hand to finish."}))
                continue
            if player.get("spectator"):
                seated_now = sum(1 for p in room["players"] if p.get("connected") and not p.get("spectator"))
                max_p = int(room.get("max_players", POKER_MAX_PLAYERS))
                if seated_now >= max_p:
                    await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "No open seats."}))
                    continue
            ok, err = poker_seat_with_buyin(player, room)
            if not ok:
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": err}))
                continue
            await poker_broadcast(room)
            await websocket.send(json.dumps({"type": "info", "message": f"Bought in for ${int(player.get('poker_chips', 0))} (bank ${int(player.get('money', 0))})."}))
            continue

        if kind == "poker_set_buyin":
            if not room or not player or room.get("game") != "poker":
                continue
            if room.get("host_id") != player.get("id"):
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "Only the host can set the buy-in."}))
                continue
            try:
                amount = int(msg.get("amount", room.get("poker_buyin", POKER_DEFAULT_BUYIN)))
            except (TypeError, ValueError):
                amount = POKER_DEFAULT_BUYIN
            amount = max(POKER_MIN_BUYIN, min(POKER_MAX_BUYIN, amount))
            room["poker_buyin"] = amount
            await poker_broadcast(room)
            await websocket.send(json.dumps({"type": "info", "message": f"Table buy-in set to ${amount}."}))
            await broadcast_public_tables()
            continue

        if kind == "poker_cashout":
            if not room or not player or room.get("game") != "poker":
                continue
            if room.get("poker_phase") in ("PREFLOP", "FLOP", "TURN", "RIVER") and player.get("poker_in_hand") and player.get("poker_status") not in ("folded", "allin"):
                # All-in players are already done acting — allow cashout only after hand
                if player.get("poker_status") != "allin":
                    await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "Cannot sit out during a hand."}))
                    continue
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "Wait for the hand to finish."}))
                continue
            if room.get("poker_phase") in ("PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN") and player.get("poker_in_hand"):
                await websocket.send(json.dumps({"type": "error", "scope": "poker", "message": "Wait for the hand to finish."}))
                continue
            poker_cashout_to_bank(player)
            player["poker_status"] = "sitting_out"
            player["poker_in_hand"] = False
            player["spectator"] = True
            player["status"] = "spectating"
            await poker_broadcast(room)
            continue


        if kind == "sit_down":
            # Spectator takes a seat when one is free
            if not room or not player:
                continue
            if not player.get("spectator"):
                await websocket.send(json.dumps({"type":"error","message":"You are already seated."}))
                continue
            seated_now = sum(1 for p in room["players"] if p.get("connected") and not p.get("spectator") and p.get("id") != player.get("id"))
            max_p = int(room.get("max_players", MAX_PLAYERS_DEFAULT))
            if seated_now >= max_p:
                await websocket.send(json.dumps({"type":"error","message":"No open seats yet. Stay as spectator."}))
                continue
            if room.get("game") == "poker":
                if int(player.get("money", 0)) <= 0 and int(player.get("poker_chips", 0)) <= 0:
                    await websocket.send(json.dumps({"type":"error","scope":"poker","message":"No chips to play with."}))
                    continue
                if room.get("poker_phase") in ("PREFLOP","FLOP","TURN","RIVER","SHOWDOWN"):
                    await websocket.send(json.dumps({"type":"error","scope":"poker","message":"Wait for the current hand to finish."}))
                    continue
                ok, err = poker_seat_with_buyin(player, room)
                if not ok:
                    await websocket.send(json.dumps({"type":"error","scope":"poker","message":err}))
                    continue
                await poker_broadcast(room)
                # Host must click START HAND — no auto-start
            else:
                # Blackjack
                if room["phase"] not in ("LOBBY", "BETTING"):
                    await websocket.send(json.dumps({"type":"error","message":"Wait for the next betting round to sit."}))
                    continue
                player["spectator"] = False
                player["status"] = "betting"
                player["bet"] = 0
                player["hand"] = []
                player["result"] = None
                await broadcast(room)
            continue

        if kind == "leave_table":
            if room and player and room.get("game") == "poker":
                poker_cashout_to_bank(player)
            ADMIN_SOCKETS.discard(websocket)
            leave_balance = None
            leave_key = None
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
                leave_balance = int(player.get("money", 0))
                leave_key = player.get("username_key")
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
                        if room.get("game") != "poker":
                            await move_to_next_or_dealer(room)
                    await broadcast(room)
            # Prefer persisted account balance after cash-out / chip return
            if leave_key and leave_key in ACCOUNTS:
                leave_balance = int(ACCOUNTS[leave_key].get("money", leave_balance or 0))
            await broadcast_public_tables()
            payload = {"type": "left_table"}
            if leave_balance is not None:
                payload["balance"] = leave_balance
            await websocket.send(json.dumps(payload))
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
                    if target.get("is_bot"):
                        room["players"] = [p for p in room["players"] if p.get("id") != target.get("id")]
                        if room.get("game") == "poker":
                            await poker_broadcast(room)
                        else:
                            await broadcast(room)
                        await broadcast_public_tables()
                    else:
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
            player["split_used"] = False
            player["hands"] = None
            player["hand_bets"] = None
            player["hand_status"] = None
            player["hand_results"] = None
            player["active_hand"] = 0
            await broadcast(room)
            await maybe_start_round(room)

        # ---- play actions ----
        elif kind == "hit":
            if room["phase"] != "PLAYING" or room["active_player_id"] != player["id"]: continue
            if player.get("hands"):
                ah = int(player.get("active_hand", 0))
                hand = player["hands"][ah]
                card = lucky_card(room, player, hand); card["faceUp"] = True; hand.append(card)
                player["hand"] = hand
                if hand_value(hand) > 21:
                    player["hand_status"][ah] = "bust"
                    player["hand_results"][ah] = "bust"
                    if ah + 1 < len(player["hands"]):
                        player["active_hand"] = ah + 1
                        player["hand_status"][ah + 1] = "playing"
                        player["hand"] = player["hands"][ah + 1]
                        player["status"] = "playing"
                    else:
                        player["status"] = "bust"
                        player["result"] = "bust"
                        await move_to_next_or_dealer(room)
            else:
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
            if player.get("hands"):
                ah = int(player.get("active_hand", 0))
                player["hand_status"][ah] = "stood"
                if ah + 1 < len(player["hands"]):
                    player["active_hand"] = ah + 1
                    player["hand_status"][ah + 1] = "playing"
                    player["hand"] = player["hands"][ah + 1]
                    player["status"] = "playing"
                else:
                    player["status"] = "stood"
                    await move_to_next_or_dealer(room)
            else:
                player["status"] = "stood"
                await move_to_next_or_dealer(room)
            await broadcast(room)

        elif kind == "split":
            if room["phase"] != "PLAYING" or room["active_player_id"] != player["id"]: continue
            if player.get("spectator"): continue
            if player.get("split_used"): continue
            hand = player.get("hand") or []
            if len(hand) != 2: continue
            # Same rank (A,A or 8,8 etc.) — face cards: compare rank field
            r0 = str(hand[0].get("rank", "")).upper()
            r1 = str(hand[1].get("rank", "")).upper()
            # 10/J/Q/K all split together as tens optionally — stick to exact rank match
            if r0 != r1: continue
            bet = int(player.get("bet", 0))
            if bet <= 0 or int(player.get("money", 0)) < bet: continue
            player["money"] -= bet
            persist_player_money(player)
            player["split_used"] = True
            c0, c1 = hand[0], hand[1]
            # Two hands from the pair
            h0 = [c0]
            h1 = [c1]
            # Deal one card to each
            n0 = lucky_card(room, player, h0); n0["faceUp"] = True; h0.append(n0)
            n1 = lucky_card(room, player, h1); n1["faceUp"] = True; h1.append(n1)
            player["hands"] = [h0, h1]
            player["hand_bets"] = [bet, bet]
            player["hand_status"] = ["playing", "waiting"]
            player["hand_results"] = [None, None]
            player["active_hand"] = 0
            player["hand"] = h0
            player["bet"] = bet * 2  # total risk for UI
            player["status"] = "playing"
            # Ace split: often one card only — auto-stand both if aces
            if r0 in ("A", "ACE", "1"):
                player["hand_status"] = ["stood", "stood"]
                player["status"] = "stood"
                player["hand"] = h0
                await move_to_next_or_dealer(room)
            await broadcast(room)

        elif kind == "double":
            if room["phase"] != "PLAYING" or room["active_player_id"] != player["id"]: continue
            if player.get("hands"):
                ah = int(player.get("active_hand", 0))
                hand = player["hands"][ah]
                hb = int(player["hand_bets"][ah])
                if len(hand) != 2 or int(player.get("money", 0)) < hb: continue
                player["money"] -= hb
                persist_player_money(player)
                player["hand_bets"][ah] = hb * 2
                player["bet"] = sum(int(x) for x in player["hand_bets"])
                card = lucky_card(room, player, hand); card["faceUp"] = True; hand.append(card)
                player["hand"] = hand
                if hand_value(hand) > 21:
                    player["hand_status"][ah] = "bust"
                    player["hand_results"][ah] = "bust"
                else:
                    player["hand_status"][ah] = "stood"
                if ah + 1 < len(player["hands"]):
                    player["active_hand"] = ah + 1
                    player["hand_status"][ah + 1] = "playing"
                    player["hand"] = player["hands"][ah + 1]
                    player["status"] = "playing"
                else:
                    player["status"] = "stood" if player["hand_status"][ah] != "bust" else "bust"
                    await move_to_next_or_dealer(room)
            else:
                if player.get("double_used") or len(player.get("hand") or []) != 2 or player["money"] < player["bet"]: continue
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
            if target.get("is_bot"):
                room["players"] = [p for p in room["players"] if p.get("id") != target.get("id")]
                if room.get("game") == "poker":
                    await poker_broadcast(room)
                else:
                    await broadcast(room)
                await broadcast_public_tables()
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
            try:
                strength = int(msg.get("strength", 50 if enabled else 0))
            except (TypeError, ValueError):
                strength = 50 if enabled else 0
            strength = max(0, min(100, strength))
            key = target.get("username_key")
            luck_map = room.setdefault("lucky_players", {})
            if enabled and strength > 0:
                luck_map[key] = strength
            else:
                luck_map.pop(key, None)
            if room.get("game") == "poker":
                await poker_broadcast(room)
            else:
                await broadcast(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_set_player_luck":
            if not is_authorized_admin(websocket, room, player):
                continue
            target = find_player(room, msg.get("targetId"))
            if not target:
                continue
            try:
                strength = int(msg.get("strength", 0))
            except (TypeError, ValueError):
                strength = -1
            if strength < 0 or strength > 100:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Luck strength must be 0–100."}))
                continue
            key = target.get("username_key")
            luck_map = room.setdefault("lucky_players", {})
            if strength > 0:
                luck_map[key] = strength
            else:
                luck_map.pop(key, None)
            # also keep roulette map in sync when relevant
            room.setdefault("roulette_player_luck", {})[key] = strength
            if room.get("game") == "poker":
                await poker_broadcast(room)
            else:
                await broadcast(room)
            await send_admin_data(websocket, room)

        elif kind == "admin_set_forced_cards":
            if not is_authorized_admin(websocket, room, player):
                continue
            # payload: { assignments: { playerId: [{rank,suit}, ...], "dealer": [...] } }
            assignments = msg.get("assignments") or {}
            forced = room.setdefault("forced_cards", {})
            dealer_list = assignments.get("dealer") or assignments.get("__dealer__") or []
            clean_dealer = []
            for c in dealer_list:
                if isinstance(c, dict) and c.get("rank") and c.get("suit"):
                    clean_dealer.append({"rank": str(c["rank"]).upper(), "suit": str(c["suit"]).upper()[0]})
            room["forced_dealer_cards"] = clean_dealer
            for pid, cards in assignments.items():
                if pid in ("dealer", "__dealer__"):
                    continue
                if not isinstance(cards, list):
                    continue
                clean = []
                for c in cards:
                    if isinstance(c, dict) and c.get("rank") and c.get("suit"):
                        clean.append({"rank": str(c["rank"]).upper(), "suit": str(c["suit"]).upper()[0]})
                if clean:
                    forced[pid] = clean
                elif pid in forced:
                    forced.pop(pid, None)
            await websocket.send(json.dumps({"type":"admin_ok","message":"Forced cards set for next deal."}))
            await send_admin_data(websocket, room)

        elif kind == "admin_clear_forced_cards":
            if not is_authorized_admin(websocket, room, player):
                continue
            room["forced_cards"] = {}
            room["forced_dealer_cards"] = []
            await websocket.send(json.dumps({"type":"admin_ok","message":"Forced cards cleared."}))
            await send_admin_data(websocket, room)

        elif kind == "player_profile_peek":
            # Public stats peek for any seated player
            target = None
            tid = msg.get("playerId") or msg.get("targetId")
            if room and tid:
                target = find_player(room, tid)
            if not target:
                await websocket.send(json.dumps({"type":"error","message":"Player not found."}))
                continue
            acc = ACCOUNTS.get(target.get("username_key"))
            if not acc:
                # bot or missing
                payload = {
                    "id": target["id"],
                    "username": target.get("username") or target.get("name"),
                    "level": 1,
                    "levelTitle": "Rookie",
                    "winRate": 0,
                    "biggestWin": 0,
                    "playSeconds": 0,
                    "gamesPlayed": 0,
                    "isAdmin": bool(target.get("is_admin")),
                    "avatar": target.get("avatar"),
                    "avatarColor": target.get("avatar_color"),
                    "isBot": bool(target.get("is_bot")),
                    "wealth": {"cash":0,"collectionValue":0,"netWorth":0,"rank":"ROOKIE","nextThreshold":10000,"ownedItems":0},
                    "vip": {"active":False,"price":VIP_PRICE,"durationDays":VIP_DURATION_DAYS,"until":0,"daysLeft":0,"dailyBonus":VIP_DAILY_BONUS,"xpMultiplier":VIP_XP_MULTIPLIER},
                    "cosmetics": {"profileFrame":"classic","profileBackground":"classic","title":"rookie"},
                    "casino": {"equipped":{"room":"room_lounge","floor":"classic_floor","wall":"classic_wall","feature":"feature_none"},"owned":["room_lounge","classic_floor","classic_wall","feature_none"]},
                    "achievementsCount": 0, "collectionCount": 1, "isSelf": False,
                }
            else:
                ensure_account_progress(acc)
                ensure_wealth_progress(acc)
                level, title = account_level(int(acc.get("xp", 0)))
                games = int(acc.get("games_played", 0))
                wins = int(acc.get("wins", 0))
                payload = {
                    "id": target["id"],
                    "username": acc.get("username"),
                    "level": level,
                    "levelTitle": title,
                    "winRate": round((wins / games * 100), 1) if games else 0,
                    "biggestWin": int(acc.get("biggest_win", 0)),
                    "playSeconds": int(acc.get("play_seconds", 0) or 0),
                    "gamesPlayed": games,
                    "isAdmin": bool(acc.get("is_admin")),
                    "avatar": acc.get("avatar") or target.get("avatar"),
                    "avatarColor": acc.get("avatar_color") or target.get("avatar_color"),
                    "isBot": False,
                    "wealth": wealth_payload(acc),
                    "vip": vip_payload(acc),
                    "cosmetics": {"profileFrame":acc.get("equipped_profile_frame","classic"),"profileBackground":acc.get("equipped_profile_background","classic"),"title":acc.get("equipped_profile_title","rookie")},
                    "casino": {"equipped":dict(acc.get("equipped_casino_items",{})),"owned":list(acc.get("owned_casino_items",[]))},
                    "achievementsCount": len(acc.get("achievements",[])),
                    "collectionCount": len({item for _, (_, key, _) in STORE_CATALOGS.items() for item in set(acc.get(key,[]))}),
                    "isSelf": bool(player and player.get("username_key") == target.get("username_key")),
                }
            # Extra fields for admins viewing
            if is_authorized_admin(websocket, room, player) or (player and ACCOUNTS.get(player.get("username_key"), {}).get("is_admin")):
                payload["money"] = int(target.get("money", 0))
                payload["lucky"] = bool(room.get("lucky_players", {}).get(target.get("username_key"), 0)) if room else False
                payload["luckStrength"] = int(room.get("lucky_players", {}).get(target.get("username_key"), 0) or 0) if room else 0
                payload["adminView"] = True
            else:
                payload["adminView"] = False
            await websocket.send(json.dumps({"type": "player_profile_peek", "profile": payload}))
            continue

        elif kind == "poker_show_cards":
            if not room or not player or room.get("game") != "poker":
                continue
            phase = room.get("poker_phase", "WAITING")
            if phase not in ("SHOWDOWN", "HAND_OVER"):
                await websocket.send(json.dumps({"type":"error","scope":"poker","message":"Can only show cards during showdown."}))
                continue
            player["poker_show_hole"] = True
            await poker_broadcast(room)
            continue

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
            target = find_player(room, msg.get("targetId")) if msg.get("targetId") else None
            target_username = str(msg.get("targetUsername") or "").strip()
            target_key = target.get("username_key") if target else username_key(target_username)
            account = ACCOUNTS.get(target_key)
            category = str(msg.get("category") or "").strip()
            item_id = str(msg.get("itemId") or "").strip()
            legacy = {"admin_star": "theme", "admin_blackout": "theme", "founder": "theme", "admin_chip": "chip"}
            if (not category or category not in STORE_CATALOGS) and item_id in legacy:
                category = legacy[item_id]
            meta = STORE_CATALOGS.get(category)
            if not account or not meta:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Invalid player or item category."}))
                continue
            catalog, owned_key, _ = meta
            if item_id not in catalog:
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"That item does not exist in the selected category."}))
                continue
            ensure_account_progress(account); ensure_wealth_progress(account)
            account[owned_key] = sorted(set(account.get(owned_key, [])) | {item_id})
            save_accounts()
            item_name = catalog[item_id].get("name", item_id)
            await websocket.send(json.dumps({"type":"admin_ok","message":f"Granted {item_name} to {account.get('username')}"}))
            target_ws = (target.get("ws") if target else None) or USER_SOCKETS.get(target_key)
            if target_ws:
                try:
                    await target_ws.send(json.dumps({"type":"store","store":store_payload(account),"granted":item_id}))
                    await target_ws.send(json.dumps({"type":"profile","profile":profile_payload(account)}))
                except Exception:
                    pass
            await send_admin_data(websocket, room)

        elif kind == "admin_grant_vip":
            if not is_authorized_admin(websocket, room, player):
                continue
            target = find_player(room, msg.get("targetId")) if msg.get("targetId") else None
            target_username = str(msg.get("targetUsername") or "").strip()
            target_key = target.get("username_key") if target else username_key(target_username)
            account = ACCOUNTS.get(target_key)
            try:
                days = int(msg.get("days", VIP_DURATION_DAYS))
            except (TypeError, ValueError):
                days = VIP_DURATION_DAYS
            if not account or days not in (30,90,365,36500):
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Invalid player or VIP duration."}))
                continue
            ensure_account_progress(account); ensure_wealth_progress(account)
            base = max(time.time(), float(account.get("vip_until", 0) or 0))
            account["vip_until"] = base + days * 86400
            for owned_key, item_id in (("owned_profile_frames","vip_crown"),("owned_profile_backgrounds","vip_private"),("owned_profile_titles","vip_member"),("owned_casino_items","room_vip_private")):
                account[owned_key] = sorted(set(account.get(owned_key, [])) | {item_id})
            save_accounts()
            await websocket.send(json.dumps({"type":"admin_ok","message":f"Granted VIP ({days} days) to {account.get('username')}"}))
            target_ws = (target.get("ws") if target else None) or USER_SOCKETS.get(target_key)
            if target_ws:
                try:
                    await target_ws.send(json.dumps({"type":"vip_granted","vip":vip_payload(account),"profile":profile_payload(account),"store":store_payload(account)}))
                except Exception:
                    pass
            await send_admin_data(websocket, room)

        elif kind == "admin_dev_item":
            if not is_authorized_admin(websocket, room, player):
                continue
            category = str(msg.get("category") or "").strip()
            item_id = str(msg.get("itemId") or "").strip()
            patch = msg.get("patch") if isinstance(msg.get("patch"), dict) else {}
            if not apply_catalog_override(category, item_id, patch):
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Invalid developer item or category."}))
                continue
            DEVELOPER_SETTINGS.setdefault("catalog_overrides", {})[f"{category}:{item_id}"] = {k:v for k,v in patch.items() if k in {"name","price","desc","rarity","admin_only","vip_only","limited","season"}}
            save_developer_settings()
            await websocket.send(json.dumps({"type":"admin_dev_ok","message":f"Updated {item_id}.","developer":developer_admin_payload()}))
            continue

        elif kind == "admin_dev_vip":
            if not is_authorized_admin(websocket, room, player):
                continue
            try: price = max(1_000_000, int(msg.get("price", VIP_PRICE)))
            except Exception: price = VIP_PRICE
            DEVELOPER_SETTINGS["vip_price"] = price
            save_developer_settings()
            await websocket.send(json.dumps({"type":"admin_dev_ok","message":f"VIP price set to ${price:,} for 30 days.","developer":developer_admin_payload()}))
            continue

        elif kind == "admin_dev_layout":
            if not is_authorized_admin(websocket, room, player):
                continue
            target = str(msg.get("target") or "").strip()
            mode = str(msg.get("mode") or "desktop").lower()
            if target not in DEV_UI_TARGETS or mode not in ("desktop","mobile"):
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Invalid UI target or mode."}))
                continue
            try: x=max(-1200,min(1200,float(msg.get("x",0))))
            except Exception: x=0
            try: y=max(-1200,min(1200,float(msg.get("y",0))))
            except Exception: y=0
            try: scale=max(0.5,min(1.8,float(msg.get("scale",1))))
            except Exception: scale=1
            DEVELOPER_SETTINGS.setdefault("ui_layout", {}).setdefault(target,{})[mode] = {"x":x,"y":y,"scale":scale}
            save_developer_settings()
            payload=json.dumps({"type":"developer_ui","developer":developer_public_payload()})
            for key, ws in list(USER_SOCKETS.items()):
                try: await ws.send(payload)
                except Exception: pass
            await websocket.send(json.dumps({"type":"admin_dev_ok","message":f"{target} {mode} position saved.","developer":developer_admin_payload()}))
            continue

        elif kind == "admin_dev_custom_layout":
            if not is_authorized_admin(websocket, room, player):
                continue
            selector = str(msg.get("selector") or "").strip()[:100]
            if not selector or not (selector.startswith("#") or selector.startswith(".")) or any(ch in selector for ch in "<>;{}()[]="):
                await websocket.send(json.dumps({"type":"error","scope":"admin","message":"Use a safe CSS #id or .class selector."}))
                continue
            mode = str(msg.get("mode") or "desktop").lower()
            if mode not in ("desktop","mobile"):
                mode = "desktop"
            try: x=max(-1200,min(1200,float(msg.get("x",0))))
            except Exception: x=0
            try: y=max(-1200,min(1200,float(msg.get("y",0))))
            except Exception: y=0
            try: scale=max(0.5,min(1.8,float(msg.get("scale",1))))
            except Exception: scale=1
            DEVELOPER_SETTINGS.setdefault("custom_ui", {}).setdefault(selector,{})[mode]={"x":x,"y":y,"scale":scale}
            save_developer_settings()
            payload=json.dumps({"type":"developer_ui","developer":developer_public_payload()})
            for ws in list(USER_SOCKETS.values()):
                try: await ws.send(payload)
                except Exception: pass
            await websocket.send(json.dumps({"type":"admin_dev_ok","message":f"Custom {selector} {mode} position saved.","developer":developer_admin_payload()}))
            continue

        elif kind == "admin_dev_reset_layout":
            if not is_authorized_admin(websocket, room, player):
                continue
            DEVELOPER_SETTINGS["ui_layout"] = json.loads(json.dumps(DEFAULT_DEVELOPER_SETTINGS["ui_layout"]))
            DEVELOPER_SETTINGS["custom_ui"] = {}
            save_developer_settings()
            payload=json.dumps({"type":"developer_ui","developer":developer_public_payload()})
            for key, ws in list(USER_SOCKETS.items()):
                try: await ws.send(payload)
                except Exception: pass
            await websocket.send(json.dumps({"type":"admin_dev_ok","message":"UI positions reset to safe defaults.","developer":developer_admin_payload()}))
            continue

        elif kind == "admin_dev_flag":
            if not is_authorized_admin(websocket, room, player):
                continue
            flag = str(msg.get("flag") or "").strip()
            if flag not in DEFAULT_DEVELOPER_SETTINGS["feature_flags"]:
                continue
            DEVELOPER_SETTINGS.setdefault("feature_flags", {})[flag] = bool(msg.get("enabled"))
            save_developer_settings()
            payload=json.dumps({"type":"developer_ui","developer":developer_public_payload()})
            for key, ws in list(USER_SOCKETS.items()):
                try: await ws.send(payload)
                except Exception: pass
            await websocket.send(json.dumps({"type":"admin_dev_ok","message":f"{flag}: {'ON' if msg.get('enabled') else 'OFF'}","developer":developer_admin_payload()}))
            continue

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
                pass
                banner = "RED BIAS 2 MIN"
            elif action == "clear_luck":
                pass
                room.pop("force_next_number", None)
                room["lucky_players"] = {}
                pass
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
                if room.get("game") == "poker":
                    await poker_broadcast(room)
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
                if room.get("game") != "poker":
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
    """
    Handle ordinary HTTP requests on the same port as WebSockets.

    IMPORTANT: WebSocket upgrade requests must return None so the websockets
    library can complete the 101 Switching Protocols handshake. Normal browser
    requests are served from the public/ directory.
    """
    # A WebSocket handshake is still an HTTP request at this stage. Never serve
    # index.html (or any static file) for an upgrade request. Returning None
    # hands the request back to websockets for the WebSocket handshake.
    upgrade = ""
    try:
        upgrade = request.headers.get("Upgrade") or request.headers.get("upgrade") or ""
    except Exception:
        upgrade = ""
    if str(upgrade).lower() == "websocket":
        return None

    path = request.path.split("?", 1)[0]

    if path == "/health":
        body = b"ok"
        return Response(200, "OK", Headers({
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": str(len(body)),
            "Cache-Control": "no-cache",
        }), body)

    if path == "/ads.txt":
        body = b"google.com, pub-4526604443102763, DIRECT, f08c47fec0942fa0\n"
        return Response(200, "OK", Headers({
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": str(len(body)),
        }), body)

    if path == "/manifest.json":
        manifest = (PUBLIC_DIR / "manifest.json").resolve()
        body = manifest.read_bytes()
        return Response(200, "OK", Headers({
            "Content-Type": "application/manifest+json; charset=utf-8",
            "Content-Length": str(len(body)),
            "Cache-Control": "no-cache",
        }), body)

    if path == "/service-worker.js":
        sw = (PUBLIC_DIR / "service-worker.js").resolve()
        body = sw.read_bytes()
        return Response(200, "OK", Headers({
            "Content-Type": "application/javascript; charset=utf-8",
            "Content-Length": str(len(body)),
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/",
        }), body)

    if path == "/googleff4f65bc0fb8bc95.html":
        body = b"google-site-verification: googleff4f65bc0fb8bc95.html\n"
        return Response(200, "OK", Headers({
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": str(len(body)),
        }), body)

    if path == "/robots.txt":
        body = b"User-agent: *\nAllow: /\nSitemap: https://blackjack-multiplayer-u38p.onrender.com/sitemap.xml\n"
        return Response(200, "OK", Headers({
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": str(len(body)),
        }), body)

    if path == "/sitemap.xml":
        body = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://blackjack-multiplayer-u38p.onrender.com/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>"""
        return Response(200, "OK", Headers({
            "Content-Type": "application/xml; charset=utf-8",
            "Content-Length": str(len(body)),
        }), body)

    # The browser's normal HTTP request to the Render URL should load the game.
    if path == "/":
        path = "/index.html"

    # Prevent path traversal outside public/.
    try:
        requested = (PUBLIC_DIR / path.lstrip("/")).resolve()
        public_root = PUBLIC_DIR.resolve()
        requested.relative_to(public_root)
    except ValueError:
        return Response(403, "Forbidden", Headers({
            "Content-Type": "text/plain; charset=utf-8"
        }), b"Forbidden")

    if not requested.is_file():
        page_404 = (PUBLIC_DIR / "404.html").resolve()
        if page_404.is_file():
            body_404 = page_404.read_bytes()
            return Response(404, "Not Found", Headers({
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": str(len(body_404)),
            }), body_404)
        return Response(404, "Not Found", Headers({
            "Content-Type": "text/plain; charset=utf-8"
        }), b"Not Found")

    body = requested.read_bytes()
    content_type = CONTENT_TYPES.get(
        requested.suffix.lower(),
        "application/octet-stream"
    )
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
