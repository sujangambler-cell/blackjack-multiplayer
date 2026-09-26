// ============================================================================
// Blackjack client — connects to the authoritative server over WebSocket,
// renders whatever state it's given, and layers on juice (wobble/glow/
// confetti/sfx) purely as local presentation. No game logic lives here.
// ============================================================================

const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RED_SUITS = new Set(["H", "D"]);
const CHIP_AMOUNTS = [5, 25, 100, 500, 1000];
const CHIP_COLORS = { 5: "#d7465a", 25: "#4664d2", 100: "#3cb482", 500: "#3c374a", 1000: "#d7a52d" };

let ws = null;
let myId = null;
let myRoom = null;
let lastState = null;
let sfxVolume = 0.6;
let soundEnabled = true;
let uiScale = 100;
let authToken = null;
let loggedUsername = null;
let authMode = "login";
let isAdmin = false;
let myProfile = null;
let myBalance = 0;
let leaderboardData = null;
let activeRank = "balance";
let publicTables = [];
let pokerTables = [];
let pokerState = null;
let pokerBetAmount = 100;
let currentGame = "blackjack";
let friendsData = [];

let presenceData = { online: 0, playing: 0 };
let playtimeBoard = [];
function formatPlayTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}
function renderPresence() {
  const el = $("#live-presence");
  if (!el) return;
  const o = Number(presenceData.online || 0);
  const p = Number(presenceData.playing || 0);
  const prev = Number(el.dataset.prevOnline || 0);
  el.innerHTML = `<div class="presence-glow"></div>
    <div class="presence-row"><span class="presence-dot"></span><strong class="presence-count" id="presence-online">${o}</strong><span>online</span></div>
    <div class="presence-row sub"><strong id="presence-playing">${p}</strong><span>in tables</span></div>`;
  if (o > prev) {
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }
  el.dataset.prevOnline = String(o);
}
function renderPlaytimeBoard() {
  const box = $("#playtime-board");
  if (!box) return;
  box.innerHTML = (playtimeBoard || []).length
    ? playtimeBoard.map((r,i) => `<div class="pt-row"><span class="pt-rank">#${i+1}</span><span class="pt-name">${escapeHtml(r.username)}</span><span class="pt-time">${formatPlayTime(r.playSeconds)}</span></div>`).join("")
    : '<div class="admin-empty">No playtime data yet.</div>';
}

let friendRequests = [];
let friendOutgoing = [];
let chatMuted = localStorage.getItem("bj_chat_muted") === "1";
let storeData = null;
let developerData = null;
let pendingStorePurchase = null;
let seasonData = null;
let appearanceData = null;
let pokerAnimationTimer = null;
let prevPokerPhase = null;
let pokerResultPlayedKey = null;
const POKER_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

function updatePokerChipPile(pot) {
  const pile = $("#poker-chip-pile");
  if (!pile) return;
  const amount = Number(pot || 0);
  if (amount <= 0) {
    pile.innerHTML = "";
    pile.className = "poker-chip-pile";
    return;
  }
  // 1–3 chips for small pots, up to 5 for large
  let n = 1;
  if (amount >= 50) n = 2;
  if (amount >= 150) n = 3;
  if (amount >= 400) n = 4;
  if (amount >= 1000) n = 5;
  const key = String(n) + ":" + Math.floor(amount / 50);
  if (pile.dataset.chipKey === key) return;
  pile.dataset.chipKey = key;
  let html = "";
  for (let i = 0; i < n; i++) html += '<span class="chip-disc"></span>';
  pile.innerHTML = html;
  pile.className = "poker-chip-pile has-chips" + (n >= 4 ? " tier-2" : "") + (n >= 5 ? " tier-3" : "");
}

function triggerPokerResult(state, me) {
  const phase = state.phase || "";
  if (phase !== "HAND_OVER" && phase !== "SHOWDOWN") return;
  const winners = state.winners || [];
  if (!winners.length) return;
  // One-shot per hand (use pot+winner names as key)
  const key = (state.code || "") + "|" + winners.map(w => (w.username || "") + (w.amount || 0)).join(",");
  if (pokerResultPlayedKey === key) return;
  pokerResultPlayedKey = key;

  const felt = $("#poker-felt");
  const pile = $("#poker-chip-pile");
  const iWon = me && winners.some(w =>
    (w.id != null && w.id === myId) ||
    (w.username && me.username && String(w.username).toLowerCase() === String(me.username).toLowerCase())
  );
  const wasInHand = me && !me.spectator && me.status !== "folded";

  // Clear old banner
  const oldBanner = felt?.querySelector(".poker-result-banner");
  if (oldBanner) oldBanner.remove();

  if (iWon) {
    play("win");
    try { flash("win"); } catch (_) {}
    try { burstConfetti(); } catch (_) {}
    if (felt) {
      felt.classList.remove("poker-loss-shake", "poker-win-pulse");
      void felt.offsetWidth;
      felt.classList.add("poker-win-pulse");
    }
    if (pile) {
      pile.classList.remove("win-burst");
      void pile.offsetWidth;
      pile.classList.add("win-burst");
    }
    const banner = document.createElement("div");
    banner.className = "poker-result-banner win";
    const amt = winners.find(w =>
      (w.id != null && w.id === myId) ||
      (w.username && me.username && String(w.username).toLowerCase() === String(me.username).toLowerCase())
    );
    banner.textContent = amt ? `YOU WIN $${Number(amt.amount || 0).toLocaleString()}!` : "YOU WIN!";
    felt?.appendChild(banner);
    setTimeout(() => banner.remove(), 2300);
    setTimeout(() => felt?.classList.remove("poker-win-pulse"), 1200);
  } else if (wasInHand) {
    play("lose");
    try { flash("lose"); } catch (_) {}
    try { shakeTable(); } catch (_) {}
    if (felt) {
      felt.classList.remove("poker-win-pulse", "poker-loss-shake");
      void felt.offsetWidth;
      felt.classList.add("poker-loss-shake");
    }
    const banner = document.createElement("div");
    banner.className = "poker-result-banner lose";
    banner.textContent = "YOU LOSE";
    felt?.appendChild(banner);
    setTimeout(() => banner.remove(), 2300);
    setTimeout(() => felt?.classList.remove("poker-loss-shake"), 800);
  }
}

// ---------------------------------------------------------------------------
// Update Log — versioned changelog shown once per account after update
// ---------------------------------------------------------------------------
const UPDATE_LOG_VERSION = 8;
const UPDATE_LOG_ENTRIES = [
  { icon:"👑", title:"VIP Membership", body:"A new VIP membership costs $250,000,000 in-game chips for 30 days. VIP unlocks exclusive profile looks, the VIP lounge, a daily VIP cash bonus, a VIP badge, and 1.25× XP." },
  { icon:"🎁", title:"Admins Can Gift Anything", body:"Authorized admins can now grant money, profile frames, backgrounds, titles, Casino items, luxury cosmetics, and VIP membership to any account — even when that player is offline." },
  { icon:"📰", title:"What’s New Opens Once", body:"After this update, the What’s New notebook opens automatically once for each account/browser. Close it with GOT IT and reopen it any time from the Update Log button." },
  { icon:"💰", title:"Wealth & Flex Update", body:"Money is now the main long-term grind. New profile cosmetics, luxury items, wealth value, VIP ranks, a net-worth leaderboard, and a personal Casino showcase give your chips a reason to matter." },
  { icon:"🏠", title:"My Casino", body:"Build your own room with high-end rooms, floors, walls and luxury features. Your equipped room appears when other players visit your profile." },
  { icon:"👑", title:"Profile Flex", body:"Buy and equip profile frames, backgrounds and titles. Player profiles now show off wealth, collection size, achievements and your equipped look." },
  {
    title: "Table Features Pack",
    body: "Reactions, hand history, PIN-locked private tables, poker side pots, player bounties, spectator betting, auto-rebuy, and admin announcement banners — all mobile-safe."
  },
  {
    title: "Admin Overhaul & Player Profiles",
    body: "Permanent admin accounts with gold name + crown badge. Click any player for a profile popup. Luck strength 0–100 for Blackjack, card selector for forced deals, and poker show-cards + last-standing fixes."
  },

  {
    icon: "♠",
    title: "Larger poker table",
    body: "The poker felt is bigger with roomier seats and clearer community cards."
  },
  {
    icon: "🎨",
    title: "Seasonal menu styling",
    body: "Profile, Store, Season, Friends, and other home buttons pick up the Crimson Royale look."
  },
  {
    icon: "☀️",
    title: "Light mode + season fix",
    body: "Seasonal UI no longer turns the lobby beige in light mode — Crimson Royale stays deep and readable."
  },

  {
    icon: "👑",
    title: "Crimson Royale season polish",
    body: "Season 2 theme now covers the full backdrop, panels, and table felt with a deeper royal crimson glow."
  },
  {
    icon: "♠",
    title: "Poker table layout",
    body: "Poker seats sit along the bottom like Blackjack, with + open seats to invite friends."
  },
  {
    icon: "⚙",
    title: "Settings text fix",
    body: "Seasonal UI no longer washes out settings labels and help text."
  },
  {
    icon: "📱",
    title: "Mobile mode overhaul",
    body: "Larger touch targets, better card sizing, less squashed docks, and cleaner side notifications on phones."
  },
  {
    icon: "🤝",
    title: "Friend requests",
    body: "Adding a friend now sends a request they must accept. Online/offline status is accurate, including lobby."
  },

  {
    icon: "♠",
    title: "Blackjack tables refined",
    body: "Roomier felt, clearer OPEN seats, and a shoe that always stays in view — play without the UI feeling squashed."
  },
  {
    icon: "📓",
    title: "Update Log",
    body: "A notebook on the main menu tracks every release. Opens once after each update so you never miss what’s new."
  },
  {
    icon: "🎩",
    title: "Season 1 · 1927 pass",
    body: "Art-deco season pass with golden rail progress. Reach a tier and a slide-in tells you to claim it from the main menu."
  },
  {
    icon: "📱",
    title: "Phone-ready slide-ins",
    body: "Friend invites, lobby invites, and season level-ups slide in cleanly on mobile without covering the action."
  },
  {
    icon: "✨",
    title: "Logo polish",
    body: "CASINO X glow stays on the title — no more light leaking across the lobby, and the name stays fully readable on phones."
  }
];

function updateLogStorageKey() {
  const u = (loggedUsername || localStorage.getItem("bj_username_hint") || "guest").toLowerCase();
  return `cx_update_log_seen_v${UPDATE_LOG_VERSION}_${u}`;
}

function hasSeenUpdateLog() {
  try { return localStorage.getItem(updateLogStorageKey()) === "1"; } catch (e) { return false; }
}

function markUpdateLogSeen() {
  try { localStorage.setItem(updateLogStorageKey(), "1"); } catch (e) {}
  const btn = $("#btn-update-log");
  if (btn) btn.classList.add("seen");
}

function renderUpdateLogBody() {
  const body = $("#update-log-body");
  if (!body) return;
  body.innerHTML = UPDATE_LOG_ENTRIES.map(e => `
    <div class="ul-entry">
      <div class="ul-illust" aria-hidden="true">${e.icon || "✦"}</div>
      <div>
        <strong>${escapeHtml(e.title)}</strong>
        <p>${escapeHtml(e.body)}</p>
      </div>
    </div>`).join("");
  const ver = $("#update-log-version");
  if (ver) ver.textContent = String(UPDATE_LOG_VERSION);
  const badge = $("#update-log-badge");
  if (badge) badge.textContent = String(UPDATE_LOG_VERSION);
}

function openUpdateLog(force) {
  renderUpdateLogBody();
  const ov = $("#update-log-overlay");
  if (!ov) return;
  ov.classList.add("open");
  if (!force) markUpdateLogSeen();
}

function closeUpdateLog() {
  $("#update-log-overlay")?.classList.remove("open");
  markUpdateLogSeen();
}

function maybeShowUpdateLogAfterAuth() {
  // Once per player per version: after login/signup (or resume) on main menu
  if (hasSeenUpdateLog()) {
    $("#btn-update-log")?.classList.add("seen");
    return;
  }
  // slight delay so menu paints first
  setTimeout(() => {
    if (!hasSeenUpdateLog()) openUpdateLog(false);
  }, 550);
}

// ---------------------------------------------------------------------------
// Side notifications (season level, friend-style, invites)
// ---------------------------------------------------------------------------
function pushSideNotif({ icon = "✦", title, body, kind = "info", actions = [], ttl = 12000 }) {
  const stack = $("#side-notif-stack");
  if (!stack) return null;
  const eln = document.createElement("div");
  eln.className = "side-notif " + (kind || "");
  const actionsHtml = (actions || []).map((a, i) =>
    `<button type="button" class="btn ${a.primary ? "good" : "secondary"}" data-ni="${i}">${escapeHtml(a.label)}</button>`
  ).join("");
  eln.innerHTML = `
    <div class="side-notif-icon">${icon}</div>
    <div class="side-notif-copy"><strong>${escapeHtml(title || "")}</strong><span>${escapeHtml(body || "")}</span></div>
    <div class="side-notif-actions">${actionsHtml || `<button type="button" class="btn secondary" data-ni="dismiss">OK</button>`}</div>`;
  stack.appendChild(eln);
  const dismiss = () => {
    if (eln.classList.contains("leaving")) return;
    eln.classList.add("leaving");
    setTimeout(() => eln.remove(), 280);
  };
  eln.querySelectorAll("[data-ni]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = btn.getAttribute("data-ni");
      if (idx === "dismiss") { dismiss(); return; }
      const act = actions[Number(idx)];
      try { act && act.onClick && act.onClick(); } catch (e) {}
      dismiss();
    });
  });
  if (ttl > 0) setTimeout(dismiss, ttl);
  return eln;
}

function showSeasonLevelToast(level) {
  pushSideNotif({
    icon: "🎩",
    kind: "season",
    title: `You reached level ${level}`,
    body: "Claim it in the main menu — open Season 2 for your pass rewards.",
    actions: [
      {
        label: "CLAIM",
        primary: true,
        onClick: () => {
          showMainMenu();
          openProgress("#season-overlay");
          send({ type: "season", token: authToken });
        }
      },
      { label: "LATER", onClick: () => {} }
    ],
    ttl: 16000
  });
  play("blackjack");
}

let _lastSeasonTierUnlocked = null;
function checkSeasonLevelUps(prevXp, nextPayload) {
  if (!nextPayload) return;
  const tiers = nextPayload.tiers || [];
  const xp = Number(nextPayload.xp || 0);
  const unlocked = tiers.filter(t => xp >= Number(t.xp || 0) && !t.claimed);
  if (!unlocked.length) return;
  // notify for the highest newly unlocked unclaimed tier
  const top = unlocked[unlocked.length - 1];
  const key = String(top.tier ?? top.level ?? top.xp);
  if (_lastSeasonTierUnlocked === key) return;
  // only toast if we crossed a threshold this session (or first load with unclaimed)
  const prev = Number(prevXp);
  if (!Number.isFinite(prev) || xp > prev) {
    _lastSeasonTierUnlocked = key;
    const levelLabel = top.tier ?? top.level ?? key;
    showSeasonLevelToast(levelLabel);
  }
}


// ---------------------------------------------------------------------------
// Audio — synthesized SFX (no asset files needed)
// ---------------------------------------------------------------------------
const actx = new (window.AudioContext || window.webkitAudioContext)();

function ensureAudio() {
  if (actx.state === "suspended") {
    actx.resume().catch(() => {});
  }
}

function tone(freq, duration, kind = "sine", sweep = 0, vol = 0.5) {
  ensureAudio();
  try {
    const t0 = actx.currentTime;
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = kind;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.linearRampToValueAtTime(Math.max(40, freq + sweep), t0 + duration);
    const v = Math.max(0.0001, vol * sfxVolume);
    gain.gain.setValueAtTime(v, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(actx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  } catch (e) { /* ignore */ }
}

function chord(notes, duration = 0.2, kind = "sine", vol = 0.25) {
  notes.forEach((f, i) => setTimeout(() => tone(f, duration, kind, 0, vol), i * 30));
}

const SFX = {
  click: () => { tone(820, 0.05, "square", -40, 0.28); tone(420, 0.04, "sine", 0, 0.12); },
  hover: () => tone(640, 0.025, "sine", 30, 0.08),
  chip: () => { tone(1100, 0.04, "triangle", -300, 0.28); tone(700, 0.06, "sine", -100, 0.15); },
  deal: () => { tone(280, 0.07, "triangle", 200, 0.3); tone(480, 0.05, "sine", 0, 0.12); },
  flip: () => tone(520, 0.06, "triangle", 180, 0.28),
  hit: () => { tone(400, 0.08, "triangle", 120, 0.3); tone(260, 0.05, "sine", 0, 0.12); },
  stand: () => tone(240, 0.12, "triangle", -30, 0.26),
  blackjack: () => { chord([523, 659, 784, 1046], 0.18, "sine", 0.28); },
  join: () => chord([440, 554, 659], 0.1, "sine", 0.22),
  leave: () => tone(280, 0.14, "sine", -90, 0.22),
  win: () => { chord([523, 659, 784], 0.22, "sine", 0.32); setTimeout(() => tone(1046, 0.35, "sine", 0, 0.28), 120); },
  lose: () => { tone(200, 0.25, "sawtooth", -60, 0.22); tone(140, 0.35, "sine", -40, 0.3); },
  bust: () => { tone(120, 0.3, "square", -40, 0.3); tone(90, 0.2, "sine", 0, 0.2); },
  push: () => { tone(360, 0.12, "sine", 0, 0.22); tone(360, 0.12, "sine", 0, 0.15); },
  pity: () => { tone(500, 0.12, "sine", 80, 0.3); setTimeout(() => tone(720, 0.2, "sine", 100, 0.28), 100); },
  toggle: () => tone(900, 0.04, "square", -100, 0.2),
};
function play(name) {
  if (!soundEnabled || sfxVolume <= 0) return;
  try { ensureAudio(); SFX[name] && SFX[name](); } catch (e) { /* audio may not be unlocked yet */ }
}
// unlock audio on any user gesture (browsers block autoplay)
["pointerdown", "keydown", "touchstart"].forEach(ev => {
  document.addEventListener(ev, () => ensureAudio(), { passive: true });
});
// Hover + click SFX for interactive UI (delegated, low cost)
let _lastHover = 0;
document.addEventListener("pointerover", (e) => {
  const t = e.target.closest?.(".btn, .icon-btn, .chip, .game-card, .toggle, .auth-tab, .seat-plus, .poker-number, .poker-bet");
  if (!t) return;
  const now = performance.now();
  if (now - _lastHover < 40) return;
  _lastHover = now;
  play("hover");
}, { passive: true });
document.addEventListener("click", (e) => {
  const t = e.target.closest?.(".btn, .icon-btn, .toggle, .auth-tab, .seat-plus");
  if (t) play("click");
}, { passive: true });

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
function $(sel) { return document.querySelector(sel); }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function clearTableClientState() {
  myId = null;
  myRoom = null;
  lastState = null;
  pokerState = null;
  prevPokerPhase = null;
  pokerResultPlayedKey = null;
  isAdmin = false;
  $("#settings-overlay")?.classList.remove("open");
  $("#host-overlay")?.classList.remove("open");
  $("#claim-overlay")?.classList.remove("open");
  $("#admin-overlay")?.classList.remove("open");
  $("#invite-toast")?.classList.add("hidden");
  $("#friend-boost-hud")?.classList.add("hidden");
  $("#double-cash-banner")?.remove();
  $("#poker-admin")?.classList.add("hidden");
  $("#btn-admin-table")?.classList.add("hidden");
  $("#btn-host")?.classList.add("hidden");
  $("#poker-host")?.classList.add("hidden");
  // Clear any leftover seat DOM so re-entering doesn't flash old seats
  const seats = $("#seats-row");
  if (seats) seats.innerHTML = "";
  const dealer = $("#dealer-hand");
  if (dealer) dealer.innerHTML = "";
  const dval = $("#dealer-value");
  if (dval) dval.textContent = "";
  toggleChat?.(false);
}

function requestPresence() {
  if (authToken) {
    send({ type: "presence", token: authToken });
    send({ type: "leaderboard_playtime", token: authToken });
  }
}
function showMainMenu() {
  clearTableClientState();
  document.querySelector("#screen-join .auth-card")?.classList.add("main-menu-mode");
  $("#auth-form")?.classList.add("hidden");
  $("#room-form")?.classList.remove("hidden");
  $("#room-error") && ($("#room-error").textContent = "");
  // Restore real account balance (never leave $0 from table UI)
  if (myProfile?.balance != null) setMenuBalance(myProfile.balance);
  else if (myBalance) setMenuBalance(myBalance);
  showScreen("#screen-join");
  // Mobile: always land at top so logo / name / XP are visible
  requestAnimationFrame(() => {
    const card = document.querySelector("#screen-join .auth-card.main-menu-mode");
    if (card) card.scrollTop = 0;
    const home = document.querySelector(".casino-home");
    if (home) home.scrollTop = 0;
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
}
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
}

function addRipple(btnEl, evt) {
  const rect = btnEl.getBoundingClientRect();
  const x = (evt.clientX ?? rect.left + rect.width / 2) - rect.left;
  const y = (evt.clientY ?? rect.top + rect.height / 2) - rect.top;
  const r = el("span", "ripple");
  r.style.left = x + "px";
  r.style.top = y + "px";
  btnEl.style.position = btnEl.style.position || "relative";
  btnEl.style.overflow = "hidden";
  btnEl.appendChild(r);
  setTimeout(() => r.remove(), 480);
}

function wireButton(elm, handler) {
  if (!elm) return;
  elm.addEventListener("pointerenter", () => { if (!elm.disabled) play("hover"); });
  elm.addEventListener("click", (e) => {
    if (elm.disabled) return;
    play("click");
    addRipple(elm, e);
    handler();
  });
}

// ---------------------------------------------------------------------------
// Premium animated background
// ---------------------------------------------------------------------------
const bgCanvas = document.getElementById("bg-canvas");
const bgCtx = bgCanvas.getContext("2d");
let bgStars = [];
let bgShapes = [];

function initBackground() {
  const count = Math.min(180, Math.max(85, Math.floor(innerWidth * innerHeight / 10000)));
  bgStars = Array.from({length: count}, () => ({
    x: Math.random(), y: Math.random(), z: Math.random(),
    speed: 0.00008 + Math.random() * 0.00028,
    twinkle: Math.random() * Math.PI * 2
  }));
  bgShapes = Array.from({length: 24}, (_, i) => ({
    x: Math.random(), y: Math.random(),
    size: 24 + Math.random() * 28,
    speed: 0.00022 + Math.random() * 0.00038,
    drift: 10 + Math.random() * 24,
    phase: Math.random() * Math.PI * 2,
    rot: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.0008,
    type: i % 3
  }));
}

function resizeBackground() {
  const d = Math.max(1, devicePixelRatio || 1);
  bgCanvas.width = Math.floor(innerWidth * d);
  bgCanvas.height = Math.floor(innerHeight * d);
  bgCanvas.style.width = innerWidth + "px";
  bgCanvas.style.height = innerHeight + "px";
  bgCtx.setTransform(d, 0, 0, d, 0, 0);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawFloatingCard(o, x, y, dark) {
  const s = o.size;
  const ctx = bgCtx;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(o.rot);
  ctx.globalAlpha = dark ? 0.28 : 0.34;
  ctx.shadowColor = dark ? "rgba(255,255,255,.45)" : "rgba(40,25,20,.28)";
  ctx.shadowBlur = 18;
  ctx.fillStyle = dark ? "rgba(245,245,245,.94)" : "rgba(255,252,247,.92)";
  ctx.strokeStyle = dark ? "rgba(255,255,255,.78)" : "rgba(40,25,20,.35)";
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, -s * .48, -s * .68, s * .96, s * 1.36, s * .12);
  ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = (Math.floor(o.phase * 10) % 2) ? "#b91c2d" : "#151515";
  ctx.font = `700 ${Math.max(18, s * .42)}px Georgia, serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText((Math.floor(o.phase * 10) % 2) ? "♦" : "♠", 0, 0);
  ctx.restore();
}

function drawFloatingChip(o, x, y, dark) {
  const s = o.size * .72;
  const ctx = bgCtx;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(o.rot);
  ctx.globalAlpha = dark ? 0.30 : 0.34;
  ctx.shadowColor = dark ? "rgba(255,255,255,.42)" : "rgba(30,20,15,.25)";
  ctx.shadowBlur = 16;
  ctx.fillStyle = dark ? "rgba(18,18,20,.96)" : "rgba(245,245,245,.94)";
  ctx.strokeStyle = dark ? "rgba(255,255,255,.8)" : "rgba(35,35,35,.4)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.setLineDash([4, 5]);
  ctx.beginPath(); ctx.arc(0, 0, s * .76, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `700 ${Math.max(12, s * .58)}px Inter, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = dark ? "#fff" : "#111";
  ctx.fillText("$", 0, 1);
  ctx.restore();
}

function drawFloatingMoney(o, x, y, dark) {
  const s = o.size * 1.12;
  const ctx = bgCtx;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(o.rot * .55);
  ctx.globalAlpha = dark ? 0.23 : 0.28;
  ctx.shadowColor = dark ? "rgba(255,255,255,.28)" : "rgba(20,40,20,.18)";
  ctx.shadowBlur = 15;
  ctx.fillStyle = dark ? "rgba(205,205,205,.9)" : "rgba(220,238,222,.92)";
  ctx.strokeStyle = dark ? "rgba(255,255,255,.55)" : "rgba(35,70,40,.35)";
  ctx.lineWidth = 1.2;
  roundRectPath(ctx, -s * .72, -s * .36, s * 1.44, s * .72, s * .08);
  ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(0, 0, s * .2, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `700 ${Math.max(12, s * .34)}px Inter, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = dark ? "#111" : "#214b2a";
  ctx.fillText("$", 0, 1);
  ctx.restore();
}

function drawBackground(t) {
  // Mobile mode: skip animated backdrop for performance
  if (document.documentElement.getAttribute("data-mobile") === "1") {
    if (bgCanvas) {
      bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    }
    return;
  }
  const w = innerWidth, h = innerHeight;
  const seasonal = document.documentElement.classList.contains("season-crimson") || document.documentElement.classList.contains("season-1927");
  const dark = seasonal || document.documentElement.getAttribute("data-theme") === "dark";
  bgCtx.clearRect(0, 0, w, h);
  const grad = bgCtx.createRadialGradient(w*.5, h*.45, 0, w*.5, h*.5, Math.max(w,h)*.78);
  grad.addColorStop(0, dark ? "rgba(22,22,28,.98)" : "rgba(255,238,220,.98)");
  grad.addColorStop(1, dark ? "rgba(1,1,3,.99)" : "rgba(246,205,180,.99)");
  bgCtx.fillStyle = grad; bgCtx.fillRect(0, 0, w, h);

  bgStars.forEach(st => {
    st.y -= st.speed;
    if (st.y < -0.02) { st.y = 1.02; st.x = Math.random(); }
    const x = st.x * w, y = st.y * h;
    const a = (0.20 + st.z * 0.62) * (0.72 + 0.28 * Math.sin(t * .001 + st.twinkle));
    bgCtx.globalAlpha = a;
    bgCtx.fillStyle = dark ? "#fff" : "#fffdf8";
    const r = 0.65 + st.z * 1.55;
    bgCtx.beginPath(); bgCtx.arc(x, y, r, 0, Math.PI * 2); bgCtx.fill();
  });

  const accountScreen = $("#screen-join").classList.contains("active") || $("#screen-lobby").classList.contains("active");
  if (accountScreen) {
    bgShapes.forEach(o => {
      o.y -= o.speed;
      if (o.y < -0.16) { o.y = 1.16; o.x = Math.random(); }
      o.rot += o.spin;
      const x = o.x * w + Math.sin(t * .00035 + o.phase) * o.drift;
      const y = o.y * h;
      if (o.type === 0) drawFloatingCard(o, x, y, dark);
      else if (o.type === 1) drawFloatingChip(o, x, y, dark);
      else drawFloatingMoney(o, x, y, dark);
    });
  }
  bgCtx.globalAlpha = 1;
  requestAnimationFrame(drawBackground);
}

initBackground();
resizeBackground();
window.addEventListener("resize", resizeBackground);
requestAnimationFrame(drawBackground);

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------
function buildCard(card, small = false) {
  const faceUp = card.faceUp === true;
  const wrap = el("div", "card deck-" + (myProfile?.cosmetics?.deck||"classic") + (faceUp ? "" : " face-down"));
  const tilt = (Math.random() * 8 - 4).toFixed(1);
  wrap.style.setProperty("--tilt", tilt + "deg");

  const back = el("div", "card-back");
  if (!faceUp) {
    // The server deliberately omits rank/suit for the dealer hole card.
    // Do not try to render or infer any hidden card data on the client.
    wrap.appendChild(el("div", "card-face black"));
    wrap.appendChild(back);
    return wrap;
  }

  const face = el("div", "card-face " + (RED_SUITS.has(card.suit) ? "red" : "black"));
  const topRank = el("div", null, card.rank);
  const bottomRank = el("div", null, card.rank);
  bottomRank.style.alignSelf = "flex-end";
  bottomRank.style.transform = "rotate(180deg)";
  const pipBig = el("div", "pip-big", SUIT_SYMBOL[card.suit]);
  face.appendChild(topRank);
  face.appendChild(pipBig);
  face.appendChild(bottomRank);

  wrap.appendChild(face);
  wrap.appendChild(back);
  return wrap;
}

function renderHand(container, cards, small = false) {
  const oldHidden = Array.from(container.querySelectorAll(".card.face-down")).length;
  const wasCount = container.childElementCount;
  container.innerHTML = "";
  cards.forEach((c) => container.appendChild(buildCard(c, small)));
  if (cards.length > wasCount) play("deal");
  if (oldHidden > 0 && cards.some(c => c.faceUp === true) && cards.length === wasCount) play("flip");
}

// ---------------------------------------------------------------------------
// Effects: confetti, flash, shake, banners
// ---------------------------------------------------------------------------
const fxCanvas = $("#fx-canvas");
const fxCtx = fxCanvas.getContext("2d");
let particles = [];
function resizeCanvas() {
  fxCanvas.width = fxCanvas.clientWidth * devicePixelRatio;
  fxCanvas.height = fxCanvas.clientHeight * devicePixelRatio;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

const CONFETTI_COLORS = ["#ff6b85", "#ffc13b", "#2ecc87", "#5a8cff", "#c77dff"];
function burstConfetti() {
  const cx = fxCanvas.width / 2, cy = fxCanvas.height * 0.35;
  for (let i = 0; i < 90; i++) {
    const ang = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 7;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(ang) * speed * devicePixelRatio,
      vy: Math.sin(ang) * speed * devicePixelRatio - 2 * devicePixelRatio,
      life: 1, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      size: (4 + Math.random() * 4) * devicePixelRatio,
      rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 0.3,
    });
  }
}
function stepParticles() {
  if (document.documentElement.getAttribute("data-mobile") === "1") {
    particles = [];
    if (fxCanvas && fxCanvas.getContext) {
      const c = fxCanvas.getContext("2d");
      if (c) c.clearRect(0, 0, fxCanvas.width || 0, fxCanvas.height || 0);
    }
    requestAnimationFrame(stepParticles);
    return;
  }
  fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.vy += 0.12 * devicePixelRatio;
    p.x += p.vx; p.y += p.vy; p.rot += p.vrot;
    p.life -= 0.012;
    fxCtx.save();
    fxCtx.translate(p.x, p.y);
    fxCtx.rotate(p.rot);
    fxCtx.globalAlpha = Math.max(0, p.life);
    fxCtx.fillStyle = p.color;
    fxCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    fxCtx.restore();
  }
  requestAnimationFrame(stepParticles);
}
requestAnimationFrame(stepParticles);

function flash(kind) {
  if (document.documentElement.getAttribute("data-mobile") === "1") return;
  const f = $("#flash");
  if (!f) return;
  f.className = "";
  void f.offsetWidth; // restart animation
  f.classList.add(kind, "flash-" + kind);
}
function shakeTable() {
  if (document.documentElement.getAttribute("data-mobile") === "1") return;
  const tw = $("#table-wrap");
  tw.classList.remove("shake");
  void tw.offsetWidth;
  tw.classList.add("shake");
}
function centerBanner(text, kind) {
  if (document.documentElement.getAttribute("data-mobile") === "1") {
    const slot = $("#turn-banner-slot") || $("#flash");
    if (slot) {
      slot.textContent = text || "";
      slot.className = "mobile-turn-banner " + (kind || "");
      clearTimeout(window._mobileBannerT);
      window._mobileBannerT = setTimeout(() => { slot.textContent = ""; }, 1600);
    }
    return;
  }
  const slot = $("#turn-banner-slot");
  slot.innerHTML = "";
  const b = el("div", "center-banner " + (kind || ""), text);
  slot.appendChild(b);
  setTimeout(() => { if (slot.contains(b)) b.remove(); }, 1800);
}
function pityBanner() {
  const slot = $("#turn-banner-slot");
  const b = el("div", "pity-banner", "💰 COMEBACK BONUS +$100");
  slot.appendChild(b);
  play("pity");
  setTimeout(() => { if (slot.contains(b)) b.remove(); }, 2600);
}

// ---------------------------------------------------------------------------
// Chip row (built once)
// ---------------------------------------------------------------------------
function buildChipRow() {
  const row = $("#chip-row");
  row.innerHTML = "";
  CHIP_AMOUNTS.forEach((amount) => {
    const btn = el("button", "chip", "$" + amount);
    btn.style.setProperty("--chip-color", CHIP_COLORS[amount]);
    wireButton(btn, () => { play("chip"); send({ type: "chip", amount }); });
    row.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  console.warn("WS not open; message dropped", obj && obj.type);
  if (obj && (obj.type === "create_public" || obj.type === "join" || obj.type === "public_tables")) {
    const err = currentGame === "poker" ? $("#poker-room-error") : $("#room-error");
    if (err) err.textContent = "Not connected to server. Reconnecting…";
    connect();
  }
  return false;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener("open", () => {
    const saved = localStorage.getItem("bj_session_token");
    if (saved && !authToken) {
      authToken = saved;
      send({ type: "resume", token: saved });
    } else if (authMode === "login") {
      send({ type: "login", username: $("#auth-username").value.trim(), password: $("#auth-password").value });
    } else {
      send({ type: "signup", username: $("#auth-username").value.trim(), password: $("#auth-password").value });
    }
  });
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "auth_ok") {
      authToken = msg.token;
      if (msg.token) localStorage.setItem("bj_session_token", msg.token);
      loggedUsername = msg.username;
      $("#welcome-user").textContent = `Welcome, ${loggedUsername}`;
      $("#auth-form").classList.add("hidden");
      $("#room-form").classList.remove("hidden");
      setMenuBalance(msg.balance);
      $("#join-error").textContent = "";
      showMainMenu();
      if (msg.profile) updateProfileUI(msg.profile);
      if (msg.developer) { developerData = msg.developer; applyDeveloperUI(developerData); }
      // Load season pass so theme + UI work immediately after login
      try { send({ type: "season", token: authToken }); } catch (e) {}
      localStorage.setItem("bj_username_hint", loggedUsername);
      maybeShowUpdateLogAfterAuth();
      return;
    }
    if (msg.type === "session_invalid") {
      authToken = null;
      localStorage.removeItem("bj_session_token");
      showScreen("#screen-join");
      return;
    }
    if (msg.type === "public_tables") {
      const tables = msg.tables || [];
      // Broadcasts often omit game and include every table — always split by game.
      if (msg.game === "poker") {
        pokerTables = tables.filter(t => (t.game || "") === "poker");
        renderPokerTables();
      } else if (msg.game === "blackjack") {
        publicTables = tables.filter(t => (t.game || "blackjack") === "blackjack");
        renderPublicTables();
      } else {
        publicTables = tables.filter(t => (t.game || "blackjack") === "blackjack");
        pokerTables = tables.filter(t => (t.game || "") === "poker");
        renderPublicTables();
        renderPokerTables();
      }
      return;
    }
    if (msg.type === "public_created") {
      const pin = msg.pin || undefined;
      if (msg.locked && pin) {
        // toast code+pin for host
        try { centerBanner("TABLE " + msg.code + " · PIN " + pin, "win"); } catch(e) {}
      }
      if (msg.game === "poker") {
        const inp = $("#poker-room");
        if (inp) { inp.value = msg.code; inp.dataset.keep = "1"; }
        const err = $("#poker-room-error");
        if (err) err.textContent = msg.locked ? ("Private table " + msg.code + " — PIN set") : "";
        send({type:"join", token:authToken, room:msg.code, game:"poker", pin});
      } else {
        $("#input-room").value = msg.code;
        send({type:"join", token:authToken, room:msg.code, game:"blackjack", pin});
      }
      return;
    }
    if (msg.type === "presence") {
      presenceData = { online: msg.online || 0, playing: msg.playing || 0 };
      renderPresence();
      return;
    }
    if (msg.type === "leaderboard_playtime") {
      playtimeBoard = msg.leaderboard || [];
      renderPlaytimeBoard();
      return;
    }
    if (msg.type === "friends") {
      friendsData = msg.friends || [];
      friendRequests = msg.requests || [];
      friendOutgoing = msg.outgoing || [];
      renderFriends();
      renderProfileFriends();
      return;
    }
    if (msg.type === "friend_event") {
      const u = msg.username || "Someone";
      if (msg.event === "request") {
        pushSideNotif({ icon: "👤", kind: "friend", title: "Friend request", body: `${u} wants to be friends.`, actions: [
          { label: "ACCEPT", primary: true, onClick: () => send({ type: "accept_friend", token: authToken, username: u }) },
          { label: "DECLINE", onClick: () => send({ type: "decline_friend", token: authToken, username: u }) },
        ], ttl: 20000 });
      } else if (msg.event === "accepted") {
        pushSideNotif({ icon: "✅", kind: "friend", title: "Friend added", body: `${u} is now your friend.`, ttl: 8000 });
      }
      send({ type: "friends", token: authToken });
      return;
    }
    if (msg.type === "chat") {
      appendChat(msg.username, msg.text);
      return;
    }
    if (msg.type === "table_invite") {
      showInviteToast(msg.from, msg.room, msg.game || "blackjack");
      return;
    }
    if (msg.type === "joined") {
      if (msg.spectator) {
        pushSideNotif({
          icon: "👁",
          kind: "info",
          title: msg.tableFull ? "Table full — spectating" : "Spectating",
          body: "You are watching this table. Take a seat when one opens.",
          ttl: 8000
        });
      }

      myId = msg.id;
      myRoom = msg.room;
      currentGame = msg.game || "blackjack";
      $("#room-chip").textContent = "TABLE " + myRoom;
      $("#profile-name").textContent = msg.username || loggedUsername || "PLAYER";
      setMenuBalance(msg.balance);
      $("#btn-admin-float").classList.add("hidden"); $("#btn-admin-table").classList.remove("hidden");
      $("#chat-messages").innerHTML = "";
      toggleChat(false);
      if (currentGame === "poker") {
        $("#poker-profile-name").textContent = msg.username || loggedUsername || "PLAYER";
        $("#poker-balance").textContent = "$" + Number(msg.balance||0).toLocaleString();
        $("#poker-room-chip").textContent = "POKER " + myRoom;
        $("#poker-admin").classList.remove("hidden");
        setChipAvatar($("#poker-profile-avatar"), {username: msg.username || loggedUsername, avatar: myProfile?.avatar, avatarColor: myProfile?.avatarColor});
        showScreen("#screen-poker");
        maybeShowFirstHelp("poker");
        send({type:"poker_state"});
      } else {
        setChipAvatar($("#table-profile-avatar"), {username: msg.username || loggedUsername, avatar: myProfile?.avatar, avatarColor: myProfile?.avatarColor});
        showScreen("#screen-table");
        maybeShowFirstHelp("blackjack");
      }
      play("join");
      return;
    }
    if (msg.type === "left_table") {
      clearTableClientState();
      $("#btn-admin-float")?.classList.add("hidden");
      if (msg.balance != null) setMenuBalance(msg.balance);
      else if (myProfile?.balance != null) setMenuBalance(myProfile.balance);
      else if (myBalance) setMenuBalance(myBalance);
      showMainMenu();
      // Refresh profile so menu balance is always accurate after cash-out
      if (authToken) send({ type: "profile", token: authToken });
      play("leave");
      return;
    }
    if (msg.type === "kicked") {
      if (ws) ws.close();
      $("#room-error").textContent = msg.message || "You were kicked.";
      showMainMenu();
      return;
    }
    if (msg.type === "balance") {
      setMenuBalance(msg.balance);
      return;
    }
    if (msg.type === "info") {
      if (msg.message) centerBanner(String(msg.message).replace(/^ADMIN:\s*/i, ""), "win");
      return;
    }
    if (msg.type === "profile") {
      updateProfileUI(msg.profile);
      friendsData = msg.profile?.friends || friendsData;
      renderFriends();
      renderProfileFriends();
      return;
    }
    if (msg.type === "leaderboard") {
      leaderboardData = msg.leaderboard || {};
      renderLeaderboard();
      return;
    }
    if (msg.type === "achievements") {
      renderAchievements(msg.achievements || {}, msg.earned || [], msg.new || []);
      return;
    }
    if (msg.type === "daily") {
      renderDaily(msg.claimed, msg.challenges || []);
      return;
    }
    if (msg.type === "daily_claimed") {
      updateProfileUI(msg.profile);
      SFX.win();
      renderDaily(true, msg.profile.dailyChallenges ? buildChallengeObjects(msg.profile.dailyChallenges) : []);
      const vipNote = Number(msg.vipBonus || 0) > 0 ? ` • VIP +$${Number(msg.vipBonus).toLocaleString()}` : "";
      pushSideNotif({icon:"💰",kind:"vip",title:"DAILY CLAIMED",body:`+$${Number(msg.amount || 0).toLocaleString()} chips${vipNote}`,ttl:7000});
      return;
    }
    if (msg.type === "store") {
      storeData = msg.store || null;
      renderStore();
      if (msg.store && myProfile) {
        myProfile.cosmetics = myProfile.cosmetics || {};
        const themes = [...(msg.store.themes || []), ...(msg.store.adminThemes || [])];
        const chips = [...(msg.store.chips || []), ...(msg.store.adminChips || [])];
        myProfile.cosmetics.theme = themes.find(x => x.equipped)?.id || myProfile.cosmetics.theme || "classic";
        myProfile.cosmetics.chip = chips.find(x => x.equipped)?.id || myProfile.cosmetics.chip || "classic";
        myProfile.cosmetics.deck = msg.store.decks?.find(x => x.equipped)?.id || myProfile.cosmetics.deck || "classic";
        myProfile.cosmetics.table = msg.store.tables?.find(x => x.equipped)?.id || myProfile.cosmetics.table || "classic";
        myProfile.cosmetics.ball = msg.store.balls?.find(x => x.equipped)?.id || myProfile.cosmetics.ball || "classic";
        myProfile.cosmetics.profileFrame = (msg.store.profileFrames||msg.store.profile_frames||[]).find?.(x=>x.equipped)?.id || myProfile.cosmetics.profileFrame || "classic";
        myProfile.cosmetics.profileBackground = (msg.store.profileBackgrounds||msg.store.profile_backgrounds||[]).find?.(x=>x.equipped)?.id || myProfile.cosmetics.profileBackground || "classic";
        myProfile.cosmetics.title = (msg.store.profileTitles||msg.store.profile_titles||[]).find?.(x=>x.equipped)?.id || myProfile.cosmetics.title || "rookie";
        if (msg.store.casino) {
          myProfile.casino = myProfile.casino || {};
          myProfile.casino.equipped = msg.store.casino.equipped || myProfile.casino.equipped;
          myProfile.casino.owned = msg.store.casino.owned || myProfile.casino.owned;
        }
        applyCosmeticTheme(myProfile.cosmetics.theme);
        applyGameCosmetics(myProfile.cosmetics);
      }
      if (msg.purchased) { play("win"); centerBanner("ITEM UNLOCKED", "win"); }
      if (msg.granted) {
        play("win");
        centerBanner("ITEM GRANTED: " + String(msg.granted).replace(/_/g, " ").toUpperCase(), "win");
      }
      if (msg.equipped) {
        play("chip");
        centerBanner("EQUIPPED", "win");
        if (myProfile?.cosmetics) {
          applyCosmeticTheme(myProfile.cosmetics.theme);
          applyGameCosmetics(myProfile.cosmetics);
        }
      }
      renderAppearance();
      return;
    }
    if (msg.type === "profile_ok") {
      const e = $("#profile-account-error"); if (e) e.textContent = "";
      const o = $("#profile-account-ok"); if (o) { o.textContent = msg.message || "Updated."; o.classList.remove("hidden"); }
      if (msg.username) {
        loggedUsername = msg.username;
        $("#welcome-user") && ($("#welcome-user").textContent = "Welcome, " + loggedUsername);
        localStorage.setItem("bj_username_hint", loggedUsername);
      }
      if (msg.profile) updateProfileUI(msg.profile);
      ["profile-cur-password","profile-new-password","profile-new-username","profile-user-password","profile-delete-password"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
      return;
    }
    if (msg.type === "account_deleted") {
      authToken = null;
      localStorage.removeItem("bj_session_token");
      try { centerBanner("Account deleted", "lose"); } catch(e) {}
      location.reload();
      return;
    }
    if (msg.type === "season") {
      const _prevXp = seasonData ? Number(seasonData.xp || 0) : null;
      seasonData = msg.season || null;
      if (msg.profile) updateProfileUI(msg.profile);
      renderSeason();
      checkSeasonLevelUps(_prevXp, seasonData);
      if (msg.claimedTier) { play("win"); centerBanner("SEASON REWARD CLAIMED", "win"); }
      return;
    }
    if (msg.type === "developer_ui") {
      developerData = msg.developer || developerData;
      applyDeveloperUI(developerData);
      if (isAdmin && msg.developer) renderDeveloperControls(msg.developer);
      return;
    }
    if (msg.type === "admin_ok") {
      isAdmin = true;
      $("#admin-login-box").classList.add("hidden");
      $("#admin-dashboard").classList.remove("hidden");
      $("#btn-admin-float").classList.remove("hidden"); $("#btn-admin-table").classList.remove("hidden"); $("#poker-admin").classList.remove("hidden");
      return;
    }
    if (msg.type === "vip_purchased" || msg.type === "vip_granted") {
      if (msg.profile) updateProfileUI(msg.profile);
      if (msg.store) { storeData = msg.store; renderStore(); }
      const days = Number(msg.vip?.daysLeft || 30);
      pushSideNotif({icon:"👑",kind:"vip",title:"VIP ACTIVE",body:`VIP benefits are active for ${days} day${days===1?"":"s"}.`,ttl:9000});
      try { play("win"); } catch(e) {}
      return;
    }
    if (msg.type === "admin_data") {
      renderAdminUsers(msg.users || [], msg.tablePlayers || [], msg.dealerPreviewActive, msg.dealerPreview, msg.tableLuck, msg.adminCatalog || [], msg.developer || null);
      return;
    }
    if (msg.type === "player_profile_peek") {
      showPlayerProfilePopup(msg.profile);
      return;
    }
    if (msg.type === "reaction") {
      showFloatingReaction(msg);
      return;
    }
    if (msg.type === "hand_history") {
      renderHandHistory(msg.history || []);
      return;
    }
    if (msg.type === "announcement") {
      showAnnouncementBanner(msg.text, msg.from);
      return;
    }
    if (msg.type === "poker_state") { renderPokerState(msg.state); return; }
    if (msg.type === "error") {
      if (msg.code === "table_full") {
        const ok = confirm(msg.message || "Table full — Spectate instead?");
        if (ok) {
          send({ type: "join", token: authToken, room: msg.room, game: msg.game || "blackjack", spectate: true });
        }
        return;
      }

      let target = null;
      if (msg.scope === "auth") target = $("#join-error");
      else if (msg.scope === "admin") target = $("#admin-error");
      else if (msg.scope === "season") {
        try { centerBanner(msg.message || "Season reward unavailable", "lose"); } catch(e) {}
        return;
      }
      else if (msg.scope === "profile") {
        const e = $("#profile-account-error");
        if (e) e.textContent = msg.message || "Error";
        const o = $("#profile-account-ok"); if (o) o.classList.add("hidden");
        return;
      }
      else if (msg.scope === "daily") target = $("#daily-reward-box");
      else if (msg.scope === "friends") target = $("#friends-error");
      else if (msg.scope === "poker" || msg.scope === "table") target = currentGame === "poker" ? $("#poker-room-error") : $("#room-error");
      else if (msg.scope === "store") target = $("#store-empty");
      else target = currentGame === "poker" ? $("#poker-room-error") : $("#room-error");
      if (msg.scope === "daily") {
        if (target) target.innerHTML = `<strong>NOT AVAILABLE</strong><span>${msg.message}</span>`;
        return;
      }
      if (msg.scope === "store") {
        if (target) { target.classList.remove("hidden"); target.innerHTML = `<strong>${escapeHtml(msg.message || "Store action unavailable")}</strong><span>Please try again.</span>`; setTimeout(()=>{ if(storeData) renderStore(); }, 1200); }
        return;
      }
      // Poker table errors should show on the table, not only lobby
      if ((msg.scope === "poker" || currentGame === "poker") && $("#screen-poker")?.classList.contains("active")) {
        const tm = $("#poker-table-msg");
        if (tm) { tm.className = "poker-table-msg error"; tm.textContent = msg.message || "Something went wrong."; }
      }
      if (target) target.textContent = msg.message || "Something went wrong.";
      else console.warn("error:", msg.message);
      return;
    }
    if (msg.type === "state") onState(msg.state);
  });
  ws.addEventListener("close", () => {
    const onTable = $("#screen-table")?.classList.contains("active");
    const onPoker = $("#screen-poker")?.classList.contains("active");
    if (!onTable && !onPoker) return;
    if (onPoker) {
      const err = $("#poker-room-error");
      if (err) err.textContent = "Disconnected from server.";
    } else {
      $("#room-error").textContent = "Disconnected from server.";
    }
    if (authToken) showMainMenu();
    else showScreen("#screen-join");
  });
}

function loginOrSignup() {
  const username = $("#auth-username").value.trim();
  const password = $("#auth-password").value;
  const confirm = $("#auth-confirm").value;
  $("#join-error").textContent = "";
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    $("#join-error").textContent = "Username must be 3–16 letters, numbers or underscores.";
    return;
  }
  if (password.length < 8) {
    $("#join-error").textContent = "Password must be at least 8 characters.";
    return;
  }
  if (authMode === "signup" && password !== confirm) {
    $("#join-error").textContent = "Passwords do not match.";
    return;
  }
  if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  connect();
}

function setAuthMode(mode) {
  authMode = mode;
  $("#tab-login").classList.toggle("active", mode === "login");
  $("#tab-signup").classList.toggle("active", mode === "signup");
  $("#confirm-wrap").classList.toggle("hidden", mode !== "signup");
  $("#btn-auth").textContent = mode === "signup" ? "CREATE ACCOUNT" : "LOGIN";
  $("#join-error").textContent = "";
  // Show the "By clicking Sign Up..." line only on the signup tab
  const tosLine = $("#tos-notice");
  if (tosLine) tosLine.classList.toggle("hidden", mode !== "signup");
}

// ---------------------------------------------------------------------------
// Terms of Service modal
// ---------------------------------------------------------------------------
function openTosModal() {
  const modal = $("#tos-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
}

function closeTosModal() {
  const modal = $("#tos-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }
}

// ---------------------------------------------------------------------------
// Rendering the authoritative state
// ---------------------------------------------------------------------------
function onState(state) {
  // Ignore table updates if we've already left (prevents "ghost still seated" UI)
  if (!myId && !myRoom) return;
  const onBj = $("#screen-table")?.classList.contains("active");
  const onPk = $("#screen-poker")?.classList.contains("active");
  if (!onBj && !onPk) {
    // Race: state arrived before screen switch — force BJ table if we joined BJ
    if (currentGame === "poker") showScreen("#screen-poker");
    else showScreen("#screen-table");
  }
  const prev = lastState;
  lastState = state;

  const me = state.players.find((p) => p.id === myId);
  if (me) {
    setMenuBalance(me.money);
    $("#profile-name").textContent = me.username || loggedUsername || me.name;
    setChipAvatar($("#table-profile-avatar"), me);
    applyGameCosmetics(me.cosmetics || myProfile?.cosmetics || {});
    $("#btn-admin-float").classList.add("hidden"); $("#btn-admin-table").classList.remove("hidden");
    $("#btn-host").classList.toggle("hidden", !me.isHost);
    // Double cash indicator
    let dcBanner = document.getElementById("double-cash-banner");
    if (state.doubleCash) {
      if (!dcBanner) {
        dcBanner = document.createElement("div");
        dcBanner.id = "double-cash-banner";
        dcBanner.className = "double-cash-banner";
        dcBanner.textContent = "2× CASH ACTIVE";
        (document.querySelector(".felt-table") || document.querySelector("#screen-table") || document.body).appendChild(dcBanner);
      }
      dcBanner.style.display = "";
    } else if (dcBanner) {
      dcBanner.style.display = "none";
    }
    if (me.canClaim && state.phase === "BETTING") {
      $("#claim-overlay").classList.add("open");
    } else if (!me.canClaim) {
      $("#claim-overlay").classList.remove("open");
    }
  }

  renderHand($("#dealer-hand"), state.dealerHand);
  $("#dealer-value").textContent = state.dealerDisplay || "";

  renderSeats(state, prev);

  // ---- control dock switching ----
  const bettingDock = $("#betting-dock");
  const actionDock = $("#action-dock");
  const waitingDock = $("#waiting-dock");
  function hideDock(d) {
    if (!d) return;
    d.classList.add("hidden");
    d.style.setProperty("display", "none", "important");
  }
  function showDock(d) {
    if (!d) return;
    d.classList.remove("hidden");
    d.style.removeProperty("display");
  }
  hideDock(bettingDock);
  hideDock(actionDock);
  hideDock(waitingDock);

  const myTurn = !!(me && !me.spectator && state.phase === "PLAYING" && (
    state.activePlayerId === me.id || me.status === "playing"
  ));
  const handLen = Array.isArray(me?.hand) ? me.hand.length : (Array.isArray(me?.hands?.[me?.activeHand || 0]) ? me.hands[me.activeHand || 0].length : 0);
  const handBet = me?.handBets ? Number(me.handBets[me.activeHand || 0] || me.bet || 0) : Number(me?.bet || 0);

  if (state.phase === "BETTING" && me && !me.spectator) {
    showDock(bettingDock);
    if ($("#bet-amount")) $("#bet-amount").textContent = "$" + (me.bet || 0);
    if ($("#bet-hint")) $("#bet-hint").style.visibility = !me.bet ? "visible" : "hidden";
    if ($("#btn-ready")) {
      $("#btn-ready").disabled = !me.bet || me.status === "ready";
      $("#btn-ready").textContent = me.status === "ready" ? "WAITING…" : "READY";
    }
    if ($("#btn-clear")) $("#btn-clear").disabled = !me.bet;
    if ($("#btn-allin")) $("#btn-allin").disabled = me.money <= 0 || me.bet === me.money;
    document.querySelectorAll("#chip-row .chip").forEach((c) => (c.disabled = me.bet >= me.money));
  } else if (myTurn && actionDock) {
    showDock(actionDock);
    const canDouble = handLen === 2 && Number(me.money || 0) >= handBet && handBet > 0;
    if ($("#btn-double")) $("#btn-double").disabled = !canDouble;
    if ($("#btn-hit")) $("#btn-hit").disabled = false;
    if ($("#btn-stand")) $("#btn-stand").disabled = false;
    const canSplit = !!(me.canSplit || (
      handLen === 2 && Array.isArray(me.hand) &&
      String(me.hand[0]?.rank || "").toUpperCase() === String(me.hand[1]?.rank || "").toUpperCase() &&
      Number(me.money || 0) >= Number(me.bet || 0) && Number(me.bet || 0) > 0 && !me.splitUsed
    ));
    if ($("#btn-split")) {
      $("#btn-split").disabled = !canSplit;
      $("#btn-split").classList.toggle("hidden", false);
    }
  } else if (waitingDock) {
    showDock(waitingDock);
    const note = $("#waiting-note");
    if (note) {
      if (me && me.spectator) {
        note.textContent = "Spectating — watching this table";
      } else if (state.phase === "PLAYING") {
        const active = state.players.find((p) => p.id === state.activePlayerId);
        note.textContent = active ? ("Waiting for " + (active.username || active.name) + "…") : "Dealer is playing…";
      } else if (state.phase === "ROUND_OVER") {
        note.textContent = "Round over — next hand starting soon";
      } else if (me && me.status === "spectating") {
        note.textContent = "Spectating — you're in next round";
      } else {
        note.textContent = "Waiting for the table…";
      }
    }
  }

  // ---- turn banner for the active player ----
  if (state.phase === "PLAYING" && me && state.activePlayerId === me.id && prev && prev.activePlayerId !== me.id) {
    centerBanner("YOUR TURN", "");
  }

  // ---- one-shot effects on my own result showing up for the first time ----
  if (me && prev) {
    const prevMe = prev.players.find((p) => p.id === myId);
    if (prevMe && prevMe.result !== me.result && me.result) {
      handleResult(me.result);
    }
    if (prevMe && !prevMe.pity && me.pity) {
      pityBanner();
    }
  }
}

function handleResult(result) {
  const table = $("#table-wrap");
  if (table) {
    table.classList.remove("result-kick-win","result-pain-loss","result-push");
    void table.offsetWidth;
  }
  if (result === "win" || result === "blackjack") {
    play(result === "blackjack" ? "blackjack" : "win");
    flash("win");
    burstConfetti();
    table?.classList.add("result-kick-win");
    centerBanner(result === "blackjack" ? "BLACKJACK!" : "YOU WIN!", "win");
  } else if (result === "push") {
    play("push");
    flash("push");
    table?.classList.add("result-push");
    centerBanner("PUSH — SECOND CHANCE", "push");
  } else if (result === "lose") {
    play("lose");
    flash("lose");
    shakeTable();
    table?.classList.add("result-pain-loss");
    centerBanner("DEALER WINS", "lose");
  } else if (result === "bust") {
    play("bust");
    flash("lose");
    shakeTable();
    table?.classList.add("result-pain-loss");
    centerBanner("BUST!", "bust");
  }
  if (table) setTimeout(() => table.classList.remove("result-kick-win","result-pain-loss","result-push"), 1200);
}


function setChipAvatar(el, profile) {
  if (!el) return;
  const p = profile || myProfile || {};
  const name = p.username || loggedUsername || "?";
  const letter = String(name).charAt(0).toUpperCase() || "?";
  const color = p.avatarColor || p.avatar_color || "#6366f1";
  const av = p.avatar;
  el.textContent = letter;
  el.style.background = color;
  el.style.backgroundImage = "";
  if (av && String(av).startsWith("data:")) {
    el.textContent = "";
    el.style.backgroundImage = `url('${av}')`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  } else if (av && String(av).startsWith("preset:")) {
    el.textContent = letter;
  }
}

function avatarHTML(p) {
  const letter = (p.username || p.name || "?").charAt(0).toUpperCase();
  const color = p.avatarColor || p.avatar_color || "#6366f1";
  if (p.avatar && String(p.avatar).startsWith("data:")) {
    return `<div class="seat-avatar" style="background-image:url('${p.avatar}');background-size:cover;background-position:center"></div>`;
  }
  if (p.avatar && String(p.avatar).startsWith("preset:")) {
    return `<div class="seat-avatar preset-${p.avatar.slice(7)}" style="background:${color}">${letter}</div>`;
  }
  return `<div class="seat-avatar" style="background:${color}">${letter}</div>`;
}

function renderSeats(state, prev) {
  const row = $("#seats-row");
  if (!row) return;
  // Keep the viewer in this function's scope. The spectator/seat refactor
  // previously left `me` only inside onState(), causing a ReferenceError
  // after every deal and preventing the action dock from rendering.
  const me = (state.players || []).find((p) => p.id === myId);
  row.innerHTML = "";
  const maxP = Math.max(2, Math.min(10, Number(state.maxPlayers) || 5));
  const seated = (state.players || []).filter(p => p.connected && !p.spectator);
  // Mobile Mode toggle OR narrow phone viewport — PC desktop layout unchanged
  const mobileMode =
    document.documentElement.getAttribute("data-mobile") === "1" ||
    (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px), (max-aspect-ratio: 3/4)").matches);
  // Evenly spaced along lower arc — mobile seats stay in bottom half of felt
  for (let i = 0; i < maxP; i++) {
    const t = maxP === 1 ? 0.5 : i / (maxP - 1); // 0..1 left → right
    let x, y;
    if (mobileMode) {
      x = 10 + t * 80;
      y = 74 + Math.sin(t * Math.PI) * 8; // 74–82% — below dealer
    } else {
      x = 14 + t * 72;
      y = 66 + Math.sin(t * Math.PI) * 8;
    }
    const p = seated[i];
    // Keep empty OPEN seats (+ invite) always visible
    const seat = el("div", "seat-slot" + (p ? (p.id === myId ? " me" : "") : " empty") + (p && state.activePlayerId === p.id ? " active-turn" : ""));
    seat.style.left = x + "%";
    seat.style.top = y + "%";

    if (p) {
      if (p.isAdmin) seat.classList.add("admin-player");
      seat.dataset.pid = p.id;
      // Cards above identity
      const handDiv = el("div", "seat-hand");
      (p.hand || []).forEach((c) => handDiv.appendChild(buildCard(c, true)));
      if ((p.hand || []).length) seat.appendChild(handDiv);
      if (p.display) seat.appendChild(el("div", "seat-value", p.display));
      if (p.bet > 0) seat.appendChild(el("div", "seat-bet", "Bet $" + p.bet));
      const identity = el("div", "seat-identity" + (p.isAdmin ? " admin-glow" : ""));
      identity.innerHTML = avatarHTML(p);
      const nameEl = el("div", "seat-name" + (p.isAdmin ? " admin-name" : ""), p.name + (p.id === myId ? " (you)" : ""));
      if (p.isAdmin) {
        const crown = document.createElement("span");
        crown.className = "admin-crown";
        crown.textContent = "♛";
        crown.title = "Admin";
        nameEl.prepend(crown);
      }
      identity.appendChild(nameEl);
      identity.appendChild(el("div", "seat-money", "$" + Number(p.money).toLocaleString()));
      seat.appendChild(identity);
      seat.style.cursor = "pointer";
      seat.title = "View profile";
      seat.addEventListener("click", (ev) => {
        if (ev.target.closest(".seat-plus")) return;
        send({ type: "player_profile_peek", playerId: p.id });
      });
      if (p.result) {
        const label = { win: "WIN", lose: "LOSE", push: "PUSH", bust: "BUST", blackjack: "BLACKJACK" }[p.result] || "";
        const statusClass = p.result === "blackjack" ? "blackjack" : p.result;
        seat.appendChild(el("div", "seat-status " + statusClass, label));
      }
    } else {
      const plus = el("button", "seat-plus", "+");
      plus.title = "Invite a friend";
      wireButton(plus, () => openSeatInvite());
      seat.appendChild(plus);
      seat.appendChild(el("div", "seat-open-label", "OPEN"));
    }
    row.appendChild(seat);
  }

  // The action dock (including SPLIT) is owned by onState(). Keeping it in
  // one place prevents spectator mode from fighting the normal BJ controls.
  updateFriendBoostHUD(state);
  renderSpectatorPanel(state, "#spectator-list", "#btn-sit-down");
}

function openSeatInvite() {
  // Prefer friends overlay for invite; if at table, prompt username of friend
  const friends = (friendsData && friendsData.length) ? friendsData : (myProfile?.friends || []);
  if (!friends.length) {
    centerBanner("ADD FRIENDS FIRST", "lose");
    openProgress("#friends-overlay");
    send({ type: "friends", token: authToken });
    return;
  }
  const names = friends.map(f => f.username || f).join(", ");
  const pick = prompt("Invite which friend?\n\nYour friends: " + names);
  if (!pick) return;
  send({ type: "invite_friend", token: authToken, username: pick.trim() });
}

function updateFriendBoostHUD(state) {
  const hud = $("#friend-boost-hud");
  if (!hud || !state) return;
  const me = (state.players || []).find(p => p.id === myId);
  const friends = new Set((myProfile?.friends || []).map(f => f.username?.toLowerCase()));
  let count = 0;
  (state.players || []).forEach(p => {
    if (p.id !== myId && p.connected && !p.spectator && friends.has((p.username || p.name || "").toLowerCase())) count++;
  });
  const pct = Math.min(25, count * 5);
  if (count > 0) {
    hud.classList.remove("hidden");
    $("#friend-boost-text").textContent = `FRIEND BOOST +${pct}% (${count} friend${count > 1 ? "s" : ""})`;
  } else {
    hud.classList.add("hidden");
  }
}


function renderHostList() {
  if (!lastState) return;
  const box = $("#host-list");
  if (!box) return;
  box.innerHTML = "";
  const dc = $("#toggle-double-cash");
  if (dc) dc.classList.toggle("on", !!lastState.doubleCash);
  lastState.players.forEach((p) => {
    if (p.spectator) return;
    const row = el("div", "host-player");
    row.appendChild(el("span", null, p.username || p.name));
    if (p.id === myId || p.isHost) {
      row.appendChild(el("span", "host-badge", "HOST"));
    } else {
      const actions = el("div", "host-actions");
      const transferBtn = el("button", "btn secondary kick-btn", "MAKE HOST");
      wireButton(transferBtn, () => {
        if (confirm("Transfer host to " + (p.username || p.name) + "?")) {
          send({ type: "transfer_host", targetId: p.id });
          $("#host-overlay").classList.remove("open");
        }
      });
      const kickBtn = el("button", "kick-btn", "KICK");
      wireButton(kickBtn, () => {
        if (confirm("Kick " + (p.username || p.name) + "?")) {
          send({ type: "kick", targetId: p.id });
        }
      });
      actions.appendChild(transferBtn);
      actions.appendChild(kickBtn);
      row.appendChild(actions);
    }
    box.appendChild(row);
  });
}
function openHostPanel() {
  const wrap = $("#host-poker-buyin-wrap");
  if (wrap) {
    // Buy-in is poker-only
    wrap.classList.toggle("hidden", currentGame !== "poker");
  }
  if (currentGame === "poker") renderPokerHostList();
  else renderHostList();
  $("#host-overlay")?.classList.add("open");
}


function formatPlayTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

function profileVisualStyle(profile){const c=profile?.cosmetics||{},bg=previewCosmetic("profile_background",c.profileBackground||"classic").split(","),frame=previewCosmetic("profile_frame",c.profileFrame||"classic").split(",");return{bgA:bg[0],bgB:bg[1],frameA:frame[0],frameB:frame[1]};}
function renderFlexProfile(){const p=myProfile;if(!p)return;const wealth=p.wealth||{},c=p.cosmetics||{},frame=previewCosmetic("profile_frame",c.profileFrame||"classic").split(","),bg=previewCosmetic("profile_background",c.profileBackground||"classic").split(","),titleName=(storeData?.profileTitles||[]).find(x=>x.id===(c.title||"rookie"))?.name||String(c.title||"ROOKIE").replace(/_/g," ").toUpperCase();const host=$("#profile-flex-summary");if(host)host.innerHTML=`<div class="flex-profile-card" style="--flex-bg-a:${bg[0]};--flex-bg-b:${bg[1]}"><div class="flex-profile-head"><div class="flex-frame" style="--frame-a:${frame[0]};--frame-b:${frame[1]}"><div class="flex-avatar">${escapeHtml((p.username||"?")[0]?.toUpperCase()||"?")}</div></div><div><strong>${escapeHtml(p.username||"PLAYER")} ${p.vip?.active?'<span class="vip-badge">VIP</span>':''}</strong><span>${escapeHtml(titleName)} • ${escapeHtml(wealth.rank||"ROOKIE")}</span></div></div><div class="flex-profile-money"><span>NET WORTH</span><b>${formatMoney(wealth.netWorth||p.balance)}</b></div><div class="flex-profile-actions"><button class="btn secondary" id="btn-profile-flex-shop">CUSTOMIZE</button><button class="btn" id="btn-profile-flex-casino">VISIT MY CASINO</button></div></div>`;wireButton($("#btn-profile-flex-shop"),()=>{window.storeTab="profile";window.storeOwnedOnly=false;closeProgress("#profile-overlay");openProgress("#store-overlay");send({type:"store",token:authToken});});wireButton($("#btn-profile-flex-casino"),()=>openCasinoViewer(p,true));}
function openCasinoViewer(profile,own=false){
  const ov=$("#casino-viewer-overlay"),view=$("#casino-viewer"); if(!ov||!view||!profile)return;
  const eq=profile.casino?.equipped||{}, wealth=profile.wealth||{};
  let room=eq.room||"room_lounge", floor=eq.floor||"classic_floor", wall=eq.wall||"classic_wall", feature=eq.feature||"feature_none";
  const items=storeData?.casinoItems||storeData?.casino||[];
  const item=id=> (Array.isArray(items)?items:[]).find(x=>x.id===id) || null;
  const roomItem=item(room), featureItem=item(feature);
  const roomName=roomItem?.name||String(room).replace(/_/g," ");
  // Room palettes drive the whole scene so equipping a room is visibly different
  const ROOM_LOOK = {
    room_lounge: {
      wall:["#1a2428","#070b0e"], floor:["#1c1814","#0a0806"],
      table:"#1a4a32", tableEdge:"#5c4030", sky:"#0d2436", badge:"STARTER ROOM", tableLabel:"HOUSE TABLE", accent:"#c9a86c"
    },
    room_suite: {
      wall:["#3a2840","#120914"], floor:["#2a1a28","#0c070c"],
      table:"#3d2a4a", tableEdge:"#8a6a9a", sky:"#2a1535", badge:"SUITE", tableLabel:"SUITE TABLE", accent:"#d4a0e8"
    },
    room_vip: {
      wall:["#4a3218","#120c06"], floor:["#3a2810","#100a04"],
      table:"#6b4a18", tableEdge:"#d4af37", sky:"#2a1808", badge:"VIP LOUNGE", tableLabel:"VIP TABLE", accent:"#f0d78c"
    },
    room_vip_private: {
      wall:["#5c3a12","#1a0e04"], floor:["#4a2e0c","#140a02"],
      table:"#7a5210", tableEdge:"#ffd978", sky:"#3a2008", badge:"VIP PRIVATE", tableLabel:"PRIVATE VIP TABLE", accent:"#ffe29a"
    },
    room_penthouse: {
      wall:["#152838","#050b13"], floor:["#0e1a28","#040810"],
      table:"#1a3a55", tableEdge:"#6a9ab8", sky:"#0a2038", badge:"PENTHOUSE", tableLabel:"SKYLINE TABLE", accent:"#8ec8f0"
    },
    room_royal: {
      wall:["#4a3810","#100b04"], floor:["#3a2a0c","#0c0802"],
      table:"#5a4010", tableEdge:"#e8c860", sky:"#2a1c06", badge:"ROYAL CASINO", tableLabel:"ROYAL TABLE", accent:"#f5e0a0"
    }
  };
  const look = ROOM_LOOK[room] || ROOM_LOOK.room_lounge;
  // Custom floor/wall override room defaults when player bought them
  const floorStyle = (floor && floor !== "classic_floor") ? previewCosmetic("casino", floor).split(",") : look.floor;
  const wallStyle = (wall && wall !== "classic_wall") ? previewCosmetic("casino", wall).split(",") : look.wall;
  const ownedCount=profile.casino?.owned?.length||1;
  const featureClass=feature.replace(/[^a-z0-9_-]/gi,"");
  const emptyBadge = feature === "feature_none" ? look.badge : "";
  view.innerHTML=`<div class="casino-view-card casino-room-v2" data-room="${escapeAttr(room)}" style="--casino-wall-a:${wallStyle[0]};--casino-wall-b:${wallStyle[1]};--casino-floor-a:${floorStyle[0]};--casino-floor-b:${floorStyle[1]};--casino-table:${look.table};--casino-table-edge:${look.tableEdge};--casino-sky:${look.sky};--casino-accent:${look.accent}">
    <div class="casino-view-top">
      <div><span class="store-kicker">CASINO X • PRIVATE PROPERTY</span><h2>${escapeHtml(profile.username||"PLAYER")}’S CASINO</h2><small>${escapeHtml(roomName)} • ${escapeHtml(wealth.rank||"ROOKIE")} • NET WORTH ${formatMoney(wealth.netWorth||0)}</small></div>
      <button class="icon-btn" id="btn-casino-view-close" aria-label="Close">×</button>
    </div>
    <div class="casino-room-scene casino-room-v2-scene room-${escapeAttr(room)} floor-${escapeAttr(floor)} wall-${escapeAttr(wall)} feature-${escapeAttr(featureClass)}">
      <div class="casino-window"><div class="city-sky"></div><div class="city-glow"></div><div class="city-buildings"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="window-frame vertical v1"></div><div class="window-frame vertical v2"></div><div class="window-frame horizontal h1"></div><div class="window-frame horizontal h2"></div></div>
      <div class="room-ceiling-glow"></div>
      <div class="room-art-deco-sign"><span>♛</span> CASINO X <span>♛</span></div>
      <div class="room-plant left"><i></i><b></b></div><div class="room-plant right"><i></i><b></b></div>
      <div class="room-couch couch-left"></div><div class="room-couch couch-right"></div>
      <div class="room-coffee-table"><span>♠</span></div>
      <div class="casino-table-prop"><span>${escapeHtml(look.tableLabel)}</span></div>
      <div class="room-rug"></div>
      <div class="room-feature feature-${escapeAttr(featureClass)}">${feature==="feature_chandelier"?"<div class=\"room-chandelier\"><i></i><b></b><em></em></div>":feature==="feature_statue"?"<div class=\"room-statue\">♛</div>":feature==="feature_bar"?"<div class=\"room-bar\"><i></i><b>DIAMOND BAR</b></div>":feature==="feature_blackjack"?"<div class=\"room-private-table\">PRIVATE<br>BLACKJACK</div>":`<div class="room-feature-empty">${escapeHtml(emptyBadge)}</div>`}</div>
      <div class="room-floor-label">${escapeHtml(roomName)} • ${ownedCount} ITEMS OWNED</div>
    </div>
    <div class="casino-room-footer"><div><span class="casino-footer-kicker">PROPERTY SHOWCASE</span><strong>${escapeHtml(featureItem?.name||roomName||"Showcase")}</strong></div><div class="casino-room-stats"><span>${escapeHtml(wealth.rank||"ROOKIE")}</span><b>${formatMoney(wealth.netWorth||0)}</b></div></div>
    ${own?'<button class="btn casino-edit-btn" id="btn-casino-edit">EDIT CASINO</button>':''}
  </div>`;
  ov.classList.add("open");
  wireButton($("#btn-casino-view-close"),()=>ov.classList.remove("open"));
  wireButton($("#btn-casino-edit"),()=>{ov.classList.remove("open");closeProgress("#profile-overlay");window.storeTab="casino";window.storeOwnedOnly=false;openProgress("#store-overlay");send({type:"store",token:authToken});});
}

// ---------------------------------------------------------------------------
// Developer controls + server-driven safe UI layout
// ---------------------------------------------------------------------------
const DEV_UI_SELECTORS = {
  updateLog:"#btn-update-log", storeButton:"#btn-store", settingsButton:"#btn-settings",
  hostButton:"#btn-host", adminTableButton:"#btn-admin-table", adminFloatButton:"#btn-admin-float",
  pokerAdminButton:"#poker-admin", shoe:"#shoe", mobileModeToggle:"#toggle-mobile",
  chatButton:"#btn-chat-open", historyButton:"#btn-history-open", storeHeroBrowse:"#store-hero-browse-main", storeOwnedToggle:"#store-owned-toggle"
};
function applyDeveloperUI(dev){
  developerData=dev||developerData||{};
  const layout=developerData.uiLayout||developerData.ui_layout||{};
  const mobile=document.documentElement.getAttribute("data-mobile")==="1";
  const mode=mobile?"mobile":"desktop";
  Object.entries(DEV_UI_SELECTORS).forEach(([key,sel])=>{
    const el=document.querySelector(sel); const cfg=layout?.[key]?.[mode]; if(!el||!cfg)return;
    const x=Math.max(-1200,Math.min(1200,Number(cfg.x)||0)),y=Math.max(-1200,Math.min(1200,Number(cfg.y)||0)),scale=Math.max(.5,Math.min(1.8,Number(cfg.scale)||1));
    el.style.setProperty("--dev-x",x+"px"); el.style.setProperty("--dev-y",y+"px"); el.style.setProperty("--dev-scale",String(scale));
    el.classList.add("dev-positioned");
  });
  const custom=developerData.customUi||developerData.custom_ui||{};
  Object.entries(custom).forEach(([selector,modes])=>{
    const cfg=modes?.[mode]; if(!cfg)return; let els=[]; try{els=Array.from(document.querySelectorAll(selector));}catch(e){return;}
    els.forEach(el=>{const x=Math.max(-1200,Math.min(1200,Number(cfg.x)||0)),y=Math.max(-1200,Math.min(1200,Number(cfg.y)||0)),scale=Math.max(.5,Math.min(1.8,Number(cfg.scale)||1));el.style.setProperty("--dev-x",x+"px");el.style.setProperty("--dev-y",y+"px");el.style.setProperty("--dev-scale",String(scale));el.classList.add("dev-positioned");});
  });
}
function renderDeveloperControls(dev, adminCatalog=[]){
  const box=$("#admin-developer-controls"); if(!box)return;
  const d=dev||developerData||{}; developerData=d;
  const overrides=d.catalogOverrides||d.catalog_overrides||{};
  const options=[];
  if(Array.isArray(adminCatalog) && adminCatalog.length){adminCatalog.forEach(x=>options.push({c:x.category,id:x.id,name:x.name,price:x.price,rarity:x.rarity,vipOnly:x.vipOnly,adminOnly:x.adminOnly,desc:x.desc||""}));}
  else {
    (storeData?.themes||[]).forEach(x=>options.push({c:"theme",id:x.id,name:x.name,price:x.price,rarity:x.rarity}));
    (storeData?.chips||[]).forEach(x=>options.push({c:"chip",id:x.id,name:x.name,price:x.price,rarity:x.rarity}));
    (storeData?.decks||[]).forEach(x=>options.push({c:"deck",id:x.id,name:x.name,price:x.price,rarity:x.rarity}));
    (storeData?.tables||[]).forEach(x=>options.push({c:"table",id:x.id,name:x.name,price:x.price,rarity:x.rarity}));
    (storeData?.balls||[]).forEach(x=>options.push({c:"ball",id:x.id,name:x.name,price:x.price,rarity:x.rarity}));
    (storeData?.profileFrames||[]).forEach(x=>options.push({c:"profile_frame",id:x.id,name:x.name,price:x.price,rarity:x.rarity}));
    (storeData?.profileBackgrounds||[]).forEach(x=>options.push({c:"profile_background",id:x.id,name:x.name,price:x.price,rarity:x.rarity}));
    (storeData?.profileTitles||[]).forEach(x=>options.push({c:"profile_title",id:x.id,name:x.name,price:x.price,rarity:x.rarity}));
    (storeData?.casinoItems||[]).forEach(x=>options.push({c:"casino",id:x.id,name:x.name,price:x.price,rarity:x.rarity,desc:x.desc||""}));
  }
  const itemOpts=options.map(x=>`<option value="${escapeAttr(x.c+"|"+x.id)}">${escapeHtml(x.name)} • ${escapeHtml(x.c)}</option>`).join("");
  const targetOpts=Object.entries(DEV_UI_SELECTORS).map(([k])=>`<option value="${escapeAttr(k)}">${escapeHtml(k.replace(/([A-Z])/g," $1").toUpperCase())}</option>`).join("");
  box.innerHTML=`<div class="dev-panel-grid"><section class="dev-box"><div class="admin-section-title">STORE ITEM EDITOR</div><label>ITEM<select id="dev-item">${itemOpts}</select></label><div class="dev-inline-2"><label>PRICE<input id="dev-price" type="number" min="0" step="1"></label><label>RARITY<select id="dev-rarity"><option>COMMON</option><option>UNCOMMON</option><option>RARE</option><option>EPIC</option><option>LEGENDARY</option><option>ULTRA</option><option>ADMIN</option><option>VIP</option></select></label></div><label>NAME<input id="dev-name" maxlength="80"></label><label>DESCRIPTION<input id="dev-desc" maxlength="120"></label><div class="dev-inline-checks"><label><input id="dev-admin-only" type="checkbox"> Admin only</label><label><input id="dev-vip-only" type="checkbox"> VIP only</label><label><input id="dev-hidden" type="checkbox"> Limited/hidden</label></div><button class="btn" id="dev-save-item">SAVE ITEM</button></section><section class="dev-box"><div class="admin-section-title">VIP PRICE</div><p class="settings-help">In-game chips • 30 days • change anytime.</p><label>VIP PRICE<input id="dev-vip-price" type="number" min="1000000" step="1000000" value="${Number(d.vipPrice||250000000)}"></label><button class="btn" id="dev-save-vip">SAVE VIP PRICE</button></section><section class="dev-box"><div class="admin-section-title">SAFE UI POSITIONING</div><p class="settings-help">Move supported icons/buttons separately for PC and Mobile.</p><div class="dev-inline-2"><label>TARGET<select id="dev-ui-target">${targetOpts}</select></label><label>MODE<select id="dev-ui-mode"><option value="desktop">PC / DESKTOP</option><option value="mobile">MOBILE</option></select></label></div><div class="dev-inline-3"><label>X<input id="dev-ui-x" type="number" value="0"></label><label>Y<input id="dev-ui-y" type="number" value="0"></label><label>SCALE<input id="dev-ui-scale" type="number" min="0.5" max="1.8" step="0.05" value="1"></label></div><div class="dev-inline-2"><button class="btn" id="dev-save-ui">SAVE POSITION</button><button class="btn secondary" id="dev-reset-ui">RESET ALL UI</button></div></section><section class="dev-box"><div class="admin-section-title">CUSTOM ELEMENT POSITION</div><p class="settings-help">Use any safe HTML selector such as <b>#some-button</b> or <b>.some-icon</b>. Desktop and Mobile are independent.</p><div class="dev-inline-2"><label>SELECTOR<input id="dev-custom-selector" maxlength="100" placeholder="#element-id or .class"></label><label>MODE<select id="dev-custom-mode"><option value="desktop">PC / DESKTOP</option><option value="mobile">MOBILE</option></select></label></div><div class="dev-inline-3"><label>X<input id="dev-custom-x" type="number" value="0"></label><label>Y<input id="dev-custom-y" type="number" value="0"></label><label>SCALE<input id="dev-custom-scale" type="number" min="0.5" max="1.8" step="0.05" value="1"></label></div><div class="dev-inline-2"><button class="btn secondary" id="dev-preview-custom">PREVIEW</button><button class="btn" id="dev-save-custom">SAVE CUSTOM POSITION</button></div></section><section class="dev-box"><div class="admin-section-title">FEATURE FLAGS</div><label class="dev-switch"><input id="dev-store-redesign" type="checkbox" ${d.featureFlags?.store_redesign!==false?"checked":""}> Store redesign</label><label class="dev-switch"><input id="dev-purchase-preview" type="checkbox" ${d.featureFlags?.store_purchase_preview!==false?"checked":""}> Purchase preview</label></section></div><div class="settings-help dev-status" id="dev-status">Developer changes are server-authoritative.</div>`;
  const selected=()=>{const v=$("#dev-item")?.value||"",[c,id]=v.split("|");return options.find(x=>x.c===c&&x.id===id)||null;};
  const sync=()=>{const it=selected();if(!it)return;const o=overrides[`${it.c}:${it.id}`]||{};$("#dev-price").value=Number(o.price??it.price??0);$("#dev-rarity").value=o.rarity||it.rarity||"COMMON";$("#dev-name").value=o.name||it.name||"";$("#dev-desc").value=o.desc||it.desc||"";$("#dev-admin-only").checked=!!o.admin_only;$("#dev-vip-only").checked=!!o.vip_only;$("#dev-hidden").checked=!!o.limited;};
  $("#dev-item")?.addEventListener("change",sync);sync();
  $("#dev-save-item")?.addEventListener("click",()=>{const it=selected();if(!it)return;send({type:"admin_dev_item",category:it.c,itemId:it.id,patch:{price:Number($("#dev-price").value||0),rarity:$("#dev-rarity").value,name:$("#dev-name").value,desc:$("#dev-desc").value,admin_only:$("#dev-admin-only").checked,vip_only:$("#dev-vip-only").checked,limited:$("#dev-hidden").checked}});});
  $("#dev-save-vip")?.addEventListener("click",()=>send({type:"admin_dev_vip",price:Number($("#dev-vip-price").value||250000000)}));
  const syncPos=()=>{const k=$("#dev-ui-target").value,m=$("#dev-ui-mode").value,c=d.uiLayout?.[k]?.[m]||{x:0,y:0,scale:1};$("#dev-ui-x").value=Number(c.x||0);$("#dev-ui-y").value=Number(c.y||0);$("#dev-ui-scale").value=Number(c.scale||1);};
  $("#dev-ui-target")?.addEventListener("change",syncPos);$("#dev-ui-mode")?.addEventListener("change",syncPos);syncPos();
  $("#dev-save-ui")?.addEventListener("click",()=>send({type:"admin_dev_layout",target:$("#dev-ui-target").value,mode:$("#dev-ui-mode").value,x:Number($("#dev-ui-x").value||0),y:Number($("#dev-ui-y").value||0),scale:Number($("#dev-ui-scale").value||1)}));
  $("#dev-reset-ui")?.addEventListener("click",()=>send({type:"admin_dev_reset_layout"}));
  const customSync=()=>{const s=$("#dev-custom-selector")?.value.trim(),m=$("#dev-custom-mode")?.value,cfg=d.customUi?.[s]?.[m]||{x:0,y:0,scale:1};$("#dev-custom-x").value=Number(cfg.x||0);$("#dev-custom-y").value=Number(cfg.y||0);$("#dev-custom-scale").value=Number(cfg.scale||1);};
  $("#dev-custom-selector")?.addEventListener("change",customSync);$("#dev-custom-mode")?.addEventListener("change",customSync);
  $("#dev-preview-custom")?.addEventListener("click",()=>{const s=$("#dev-custom-selector").value.trim();if(!s)return;try{document.querySelectorAll(s).forEach(el=>{el.style.setProperty("--dev-x",Number($("#dev-custom-x").value||0)+"px");el.style.setProperty("--dev-y",Number($("#dev-custom-y").value||0)+"px");el.style.setProperty("--dev-scale",String(Number($("#dev-custom-scale").value||1)));el.classList.add("dev-positioned");});}catch(e){}});
  $("#dev-save-custom")?.addEventListener("click",()=>send({type:"admin_dev_custom_layout",selector:$("#dev-custom-selector").value.trim(),mode:$("#dev-custom-mode").value,x:Number($("#dev-custom-x").value||0),y:Number($("#dev-custom-y").value||0),scale:Number($("#dev-custom-scale").value||1)}));
  $("#dev-store-redesign")?.addEventListener("change",e=>send({type:"admin_dev_flag",flag:"store_redesign",enabled:e.target.checked}));
  $("#dev-purchase-preview")?.addEventListener("change",e=>send({type:"admin_dev_flag",flag:"store_purchase_preview",enabled:e.target.checked}));
}


function formatMoney(n) {
  return "$" + Number(n || 0).toLocaleString();
}
function setMenuBalance(amount) {
  if (amount == null || amount === "" || Number.isNaN(Number(amount))) return;
  myBalance = Number(amount);
  const text = formatMoney(myBalance);
  const menu = $("#menu-balance");
  if (menu) menu.textContent = text;
  const chip = $("#balance-chip");
  if (chip) chip.textContent = text;
  const poker = $("#poker-balance");
  if (poker) poker.textContent = text;
  const store = $("#store-balance");
  if (store) store.textContent = text;
  if (myProfile) myProfile.balance = myBalance;
}
function updateProfileUI(profile) {
  if (!profile) return;
  myProfile = profile;
  // Always apply equipped cosmetics so shop purchases are visible in-game
  try {
    const cos = profile.cosmetics || {};
    applyCosmeticTheme(cos.theme || "classic");
    applyGameCosmetics(cos);
  } catch (e) { console.warn("cosmetic apply", e); }
  if (profile.isAdmin) {
    isAdmin = true;
    $("#btn-admin-float")?.classList.remove("hidden");
    $("#btn-admin-table")?.classList.remove("hidden");
    $("#poker-admin")?.classList.remove("hidden");
    $("#admin-login-box")?.classList.add("hidden");
    $("#admin-dashboard")?.classList.remove("hidden");
  }
  try { window.__syncAutoRebuyUI && window.__syncAutoRebuyUI(); } catch(e) {}
  if(profile.season) { const _prevXp = seasonData ? Number(seasonData.xp||0) : null; seasonData = profile.season; applySeasonTheme(); checkSeasonLevelUps(_prevXp, seasonData); }
  applyCosmeticTheme(profile.cosmetics?.theme || "classic");
  applyGameCosmetics(profile.cosmetics || {});
  refreshAvatarPreview();
  setMenuBalance(profile.balance);
  $("#menu-level").textContent = `LEVEL ${profile.level || 1} • ${(profile.levelTitle || "Rookie").toUpperCase()}`;
  $("#menu-xp").textContent = `${Number(profile.xp || 0).toLocaleString()} XP`;
  applyCosmeticTheme(profile.cosmetics?.theme || "classic");
  if (profile.username) {
    loggedUsername = profile.username;
    $("#welcome-user").textContent = `Welcome, ${loggedUsername}`;
  }
  renderStats();
  if (profile.dailyChallenges) renderDaily(profile.dailyClaimed, buildChallengeObjects(profile.dailyChallenges));
}

function renderStats() {
  if (!myProfile) return;
  const s = myProfile.stats || {};
  $("#stats-hero").innerHTML = `<strong>LEVEL ${myProfile.level || 1}</strong><span>${myProfile.levelTitle || "Rookie"} • ${Number(myProfile.xp || 0).toLocaleString()} XP</span>`;
  const items = [
    ["CASINO GAMES", s.gamesPlayed || 0], ["CASINO WINS", s.wins || 0], ["LOSSES", s.losses || 0],
    ["BLACKJACKS", s.blackjacks || 0], ["POKER GAMES", s.pokerGames || 0], ["POKER WINS", s.pokerWins || 0],
    ["WIN RATE", `${s.winRate || 0}%`], ["BIGGEST WIN", "$" + Number(s.biggestWin || 0).toLocaleString()]
  ];
  $("#stats-grid").innerHTML = items.map(([a,b]) => `<div class="stat-box"><span>${a}</span><strong>${b}</strong></div>`).join("");
}

function rankValue(row, key) {
  if (key === "winRate") return `${row.winRate}%`;
  if (key === "balance") return "$" + Number(row.balance || 0).toLocaleString();
  if (key === "netWorth") return "$" + Number(row.netWorth || 0).toLocaleString();
  return Number(row[key] || 0).toLocaleString();
}
function renderLeaderboard() {
  if (!leaderboardData) return;
  const rows = leaderboardData[activeRank] || [];
  $("#leaderboard-list").innerHTML = rows.length ? rows.map((r,i) => {
    const podium = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
    const trophy = i < 3 ? "🏆" : "";
    const medal = i < 3 ? ["🥇","🥈","🥉"][i] : `#${i+1}`;
    const me = r.username.toLowerCase() === (loggedUsername || "").toLowerCase();
    return `<div class="rank-row ${me ? "me" : ""} ${podium}"><span class="rank-place">${medal}</span><div class="rank-name"><strong>${trophy} ${escapeHtml(r.username)}</strong><small>Lv ${r.level} • ${escapeHtml(r.levelTitle||"")}</small></div><strong>${rankValue(r, activeRank)}</strong></div>`;
  }).join("") : '<div class="admin-empty">No players yet.</div>';
}

function showInviteToast(from, room, game) {
  const toast = $("#invite-toast");
  if (!toast) {
    if (confirm(`${from} invited you to ${game} table ${room}. Join?`)) {
      send({ type: "join", token: authToken, room, game });
    }
    return;
  }
  $("#invite-from").textContent = from;
  $("#invite-room").textContent = room;
  toast.dataset.room = room;
  toast.dataset.game = game || "blackjack";
  // Restart glow/particle entrance from bottom-right
  toast.classList.add("hidden");
  void toast.offsetWidth;
  toast.classList.remove("hidden");
  play("join");
  clearTimeout(window._inviteTimer);
  window._inviteTimer = setTimeout(() => toast.classList.add("hidden"), 45000);
}

function renderAchievements(defs, earned, fresh) {
  const box = $("#achievement-list");
  const earnedSet = new Set(earned);
  box.innerHTML = Object.entries(defs).map(([id,a]) => `<div class="achievement ${earnedSet.has(id) ? "earned" : "locked"}"><div class="achievement-icon">${a.icon}</div><div><strong>${a.title}</strong><span>${a.desc}</span></div><div class="achievement-check">${earnedSet.has(id) ? "✓" : "🔒"}</div></div>`).join("");
  if (fresh.length) centerBanner(`ACHIEVEMENT${fresh.length > 1 ? "S" : ""} UNLOCKED!`, "win");
}

function buildChallengeObjects(values) {
  const defs = [
    {id:"play10",title:"TABLE REGULAR",desc:"Play 10 hands today.",target:10,reward:250},
    {id:"win3",title:"WINNER'S RUN",desc:"Win 3 hands today.",target:3,reward:300},
    {id:"blackjack1",title:"NATURAL",desc:"Get a Blackjack today.",target:1,reward:400}
  ];
  return defs.map(d => ({...d, progress: Math.min(d.target, Number(values[d.id] || 0)), complete: Number(values[d.id] || 0) >= d.target}));
}
function renderDaily(claimed, challenges) {
  const vipBonus = Number(myProfile?.vip?.active ? (myProfile.vip.dailyBonus || 10000000) : 0);
  const claimLabel = claimed ? `<strong>✓ CLAIMED</strong><span>Come back tomorrow for +${(250 + vipBonus).toLocaleString()} chips${vipBonus ? " (VIP bonus included)" : ""}.</span>` : `<strong>+250 CHIPS${vipBonus ? ` + $${vipBonus.toLocaleString()} VIP` : ""}</strong><span>Daily free reward${vipBonus ? " • VIP active" : ""}</span><button class="btn" id="btn-claim-daily">CLAIM REWARD</button>`;
  $("#daily-reward-box").innerHTML = claimLabel;
  const btn = $("#btn-claim-daily");
  if (btn) wireButton(btn, () => { send({type:"claim_daily", token:authToken}); btn.disabled=true; });
  $("#challenge-list").innerHTML = challenges.length ? challenges.map(c => `<div class="challenge ${c.complete ? "complete" : ""}"><div><strong>${c.title}</strong><span>${c.desc}</span></div><div class="challenge-right"><b>${c.progress}/${c.target}</b><small>+${c.reward} chips</small></div></div>`).join("") : '<div class="admin-empty">No challenges today.</div>';
}

function applyCosmeticTheme(theme){
  const t = theme || "classic";
  const root = document.documentElement;
  // Clear previous theme-* classes
  root.classList.forEach(cls => { if (cls.startsWith("theme-")) root.classList.remove(cls); });
  root.setAttribute("data-cosmetic-theme", t);
  root.classList.add("theme-" + t);
  document.body.dataset.cosmeticTheme = t;
  if (myProfile) {
    myProfile.cosmetics = myProfile.cosmetics || {};
    myProfile.cosmetics.theme = t;
  }
  applySeasonTheme();
}
function applyGameCosmetics(c = {}) {
  const chip = c.chip || "classic";
  const deck = c.deck || "classic";
  const table = c.table || "classic";
  const ball = c.ball || "classic";
  const root = document.documentElement;
  root.setAttribute("data-casino-chip", chip);
  root.setAttribute("data-blackjack-deck", deck);
  root.setAttribute("data-table-skin", table);
  root.setAttribute("data-poker-ball", ball);
  // Also mirror onto body for any descendant-only selectors
  document.body.setAttribute("data-casino-chip", chip);
  document.body.setAttribute("data-blackjack-deck", deck);
  document.body.setAttribute("data-table-skin", table);
  document.body.setAttribute("data-poker-ball", ball);
  if (myProfile) {
    myProfile.cosmetics = { ...(myProfile.cosmetics || {}), ...c, chip, deck, table, ball };
  }
  // Force a tiny style recalc so chip/deck/table skins paint immediately
  document.body.style.opacity = "0.999";
  requestAnimationFrame(() => { document.body.style.opacity = ""; });
}
function applySeasonTheme(){
  const enabled = localStorage.getItem("bj_seasonal_ui") !== "0";
  const theme = seasonData?.season?.theme || "";
  const seasonLive = !!(seasonData?.season?.active===true && theme);
  // Toggle visual follows preference always; classes only when season is live
  document.documentElement.classList.toggle("season-1927", enabled && seasonLive && theme==="casino1927");
  document.documentElement.classList.toggle("season-crimson", enabled && seasonLive && theme==="crimson_royale");
  document.documentElement.setAttribute("data-seasonal-ui", enabled ? "1" : "0");
  document.documentElement.setAttribute("data-season-theme", enabled && seasonLive ? theme : "");
  $("#toggle-seasonal-ui")?.classList.toggle("on", enabled);
  const btn = $("#btn-season");
  if (btn && seasonData?.season?.name) {
    const id = seasonData.season.id || 2;
    btn.textContent = "SEASON " + id;
  }
  // If user wants seasonal UI but we have no season payload yet, ask server
  if (enabled && !seasonData && typeof authToken === "string" && authToken) {
    try { send({ type: "season", token: authToken }); } catch (e) {}
  }
}
function applySeasonalUI(enabled){
  localStorage.setItem("bj_seasonal_ui", enabled ? "1" : "0");
  applySeasonTheme();
}
function previewCosmetic(cat,id){const maps={theme:{classic:"#1c1f23,#050506",midnight:"#24516e,#06101a",emerald:"#0d3d28,#06140e",royal:"#6a326c,#160916",neon:"#16877f,#060f12",crimson:"#8b1e2d,#1a0508",golden:"#d7b56d,#3c2413",celestial:"#66cfff,#030711",casino1927:"#d7b56d,#183b2a",crimson_royale:"#8b1e2d,#12060a",admin_star:"#f472b6,#1a0510",admin_blackout:"#222,#000",founder:"#d4af37,#1a1005"},chip:{classic:"#17191d,#050506",silver:"#bfc8d0,#343b44",emerald_chip:"#2f6d4b,#0c281b",gold:"#e5c56d,#6c4c13",diamond:"#1a1a1a,#444",royal_vault:"#d4af37,#1a1008",casino1927:"#d7b56d,#3c2413",crimson_velvet:"#8b1e2d,#f3ede2",admin_chip:"#f472b6,#1a0510"},deck:{classic:"#f7f0df,#2b2a29",midnight:"#252a35,#050609",emerald_deck:"#0d3d28,#c8e6c9",crimson_deck:"#8b1e2d,#f3ede2",celestial_deck:"#0a1628,#66cfff",casino1927:"#d7b56d,#173d2a",crimson_royale_deck:"#8b1e2d,#f3ede2"},table:{classic:"#2f6d4b,#0c281b",royal:"#496c35,#1c2b16",casino1927:"#6d5130,#123a28",crimson_table:"#8b1e2d,#f3ede2"},ball:{classic:"#f4f4f4,#777",brass1927:"#f1d28a,#8f5c1a",crimson_back:"#8b1e2d,#d4b87a"},profile_frame:{classic:"#3a3d44,#111",silver:"#c8cdd5,#343942",gold:"#f0cf72,#6d4b13",diamond:"#9fe6ff,#315c82",crimson:"#ff4b5e,#4b0710",royal:"#f3d47a,#5a3410","1927":"#f4d88b,#173d2d"},profile_background:{classic:"#17191d,#050506",velvet:"#452a40,#0a0710",neon:"#16877f,#071014",crimson:"#8b1e2d,#170609",vault:"#363b45,#0a0b0e","1927":"#6d5130,#143d2b"},profile_title:{rookie:"#444,#111",card_shark:"#4d6d9e,#151d2c",high_roller:"#9f641d,#211508",vip:"#6f4aa8,#14091c",whale:"#b57cf5,#1a0824",casino_royalty:"#f1c95f,#3a2107"},casino:{classic_floor:"#2e302f,#0c0d0d",classic_wall:"#24262b,#090a0d",feature_none:"#222,#090909",room_lounge:"#244c3c,#07130e",room_suite:"#4d334a,#120914",room_vip:"#8a6420,#1a1008",room_vip_private:"#c9a227,#1a0e06",room_penthouse:"#1e3c5a,#050b13",room_royal:"#654b20,#100b04",floor_marble:"#4b4d52,#16171a",floor_ruby:"#6e1c2b,#180509",floor_gold:"#8f6724,#2d1b06",wall_1927:"#6d5130,#173d2b",wall_velvet:"#692430,#16070a",wall_vault:"#343a44,#0b0d10",feature_blackjack:"#244a35,#07120d",feature_chandelier:"#b99a58,#30220d",feature_statue:"#d0a52c,#4a2d05",feature_bar:"#74d9ff,#0b1c24"}};return (maps[cat]&&maps[cat][id])||maps[cat]?.classic||"#17191d,#050506";}
function renderAppearance(){
  const cats={
    theme:[...(storeData?.themes||[]),...(storeData?.adminThemes||[])],
    chip:[...(storeData?.chips||[]),...(storeData?.adminChips||[])],
    deck:storeData?.decks||[],
    table:storeData?.tables||[],
    ball:storeData?.balls||[]
  };
  const boxSets = [
    {theme:$("#appearance-themes"),chip:$("#appearance-chips"),deck:$("#appearance-decks"),table:$("#appearance-tables"),ball:$("#appearance-balls")},
    {theme:$("#settings-inv-themes"),chip:$("#settings-inv-chips"),deck:$("#settings-inv-decks"),table:$("#settings-inv-tables"),ball:$("#settings-inv-balls")}
  ];
  boxSets.forEach(boxes => {
    Object.entries(boxes).forEach(([cat,b])=>{
      if(!b) return;
      // Settings inventory: only owned items
      const list = (cats[cat]||[]).filter(x => b.id && b.id.startsWith("settings-") ? x.owned : true);
      b.innerHTML = list.length ? list.map(x=>{
        const c=previewCosmetic(cat,x.id).split(",");
        let a;
        if (!x.owned) a = `<button class="btn secondary" data-app-buy>BUY</button>`;
        else if (x.equipped && x.id !== "classic") a = `<button class="btn secondary" data-app-unequip="${cat}">UNEQUIP</button>`;
        else if (x.equipped) a = `<button class="btn secondary" disabled>EQUIPPED</button>`;
        else a = `<button class="btn" data-app-equip="${cat}" data-id="${escapeAttr(x.id)}">EQUIP</button>`;
        return `<div class="appearance-item ${x.equipped?'equipped':''} ${!x.owned?'locked':''}"><div class="appearance-preview" style="--preview-a:${c[0]};--preview-b:${c[1]}"></div><div><strong>${escapeHtml(x.name)}</strong><small>${x.owned?(x.equipped?"EQUIPPED":"OWNED"):"UNOWNED"}${x.limited?" • SEASONAL":""}</small></div>${a}</div>`;
      }).join("") : '<div class="admin-empty">No owned items yet.</div>';
      b.querySelectorAll("[data-app-equip]").forEach(x=>wireButton(x,()=>send({type:"equip_cosmetic",token:authToken,category:x.dataset.appEquip,id:x.dataset.id})));
      b.querySelectorAll("[data-app-unequip]").forEach(x=>wireButton(x,()=>send({type:"equip_cosmetic",token:authToken,category:x.dataset.appUnequip,id:"classic"})));
      b.querySelectorAll("[data-app-buy]").forEach(x=>wireButton(x,()=>{$("#appearance-overlay")?.classList.remove("open");$("#settings-overlay")?.classList.remove("open");openProgress("#store-overlay");send({type:"store",token:authToken});}));
    });
  });
}
function openStorePurchase(item){
  if(!item) return;
  pendingStorePurchase=item;
  const ov=$("#store-purchase-overlay"); if(!ov) return;
  const colors=previewCosmetic(item.category,item.id).split(","), rarity=item.rarity||"COMMON";
  const visual=$("#store-purchase-visual");
  visual.style.setProperty("--preview-a", colors[0]||"#222"); visual.style.setProperty("--preview-b", colors[1]||"#111");
  visual.innerHTML=`<span class="store-item-rarity rarity-${escapeHtml(rarity)}">${escapeHtml(rarity)}</span><div class="purchase-mark">${item.category==="chip"?"✦":item.category==="deck"?"♠":item.category==="table"?"▰":item.category==="profile_frame"?"◉":item.category==="profile_background"?"▧":item.category==="profile_title"?"✦":item.category==="casino"?"⌂":"✥"}</div>`;
  $("#store-purchase-rarity").className=`store-item-rarity rarity-${rarity}`; $("#store-purchase-rarity").textContent=rarity;
  $("#store-purchase-category").textContent=item.categoryLabel||item.category.toUpperCase();
  $("#store-purchase-name").textContent=item.name||item.id;
  $("#store-purchase-desc").textContent=item.desc||"Permanent item • available anytime.";
  $("#store-purchase-price").textContent=item.price?formatMoney(item.price):"FREE";
  const gp=$("#store-purchase-game-preview");
  gp.style.setProperty("--preview-a", colors[0]||"#222"); gp.style.setProperty("--preview-b",colors[1]||"#111");
  gp.innerHTML=`<div class="game-preview-sample sample-${escapeAttr(item.category)}"><span>${escapeHtml(item.name||"ITEM")}</span><b>${item.category==="theme"?"CASINO X":item.category==="chip"?"● ● ●":item.category==="deck"?"A♠ K♥":item.category==="profile_frame"?"◎":item.category==="profile_background"?"1927":item.category==="profile_title"?"HIGH ROLLER":item.category==="casino"?"♛ CASINO X":"HOUSE TABLE"}</b></div>`;
  const buy=$("#store-purchase-buy"); buy.textContent=item.owned?"OWNED":item.limited?"SEASONAL REWARD":item.vipOnly && !(storeData?.vip?.active)?"VIP REQUIRED":"BUY NOW"; buy.disabled=!!item.owned||!!item.limited||(!!item.vipOnly && !(storeData?.vip?.active));
  ov.classList.add("open");
}
function closeStorePurchase(){ pendingStorePurchase=null; $("#store-purchase-overlay")?.classList.remove("open"); }

// Store v3 hero controls: both desktop and mobile entry points use the same featured tab.
function wireStoreV3Hero(){
  [$("#store-hero-browse"),$("#store-hero-browse-main")].filter(Boolean).forEach(b=>wireButton(b,()=>{window.storeTab="all";window.storeOwnedOnly=false;renderStore();document.querySelector(".store-main")?.scrollTo({top:0,behavior:"smooth"});}));
}

function renderStore(){
  if(!storeData)return;
  const tab=window.storeTab||"all", ownedOnly=!!window.storeOwnedOnly;
  const balance=Number(storeData.balance||0), wealth=storeData.wealth||{}, vip=storeData.vip||{}, vipActive=!!vip.active, vipPrice=Number(vip.price||developerData?.vipPrice||250000000);
  const ff=developerData?.featureFlags||{};
  const hero=document.querySelector(".store-hero-banner"); if(hero) hero.classList.toggle("hidden",ff.store_redesign===false);
  $("#store-balance").innerHTML=`${formatMoney(balance)}<small>NET WORTH ${formatMoney(wealth.netWorth||balance)}</small>`;
  const vipStatus=$("#store-vip-status"); if(vipStatus) vipStatus.textContent=vipActive?`♛ VIP ACTIVE • ${Number(vip.daysLeft||0)}D LEFT`:`♛ VIP AVAILABLE`;
  document.querySelectorAll(".store-tab").forEach(b=>b.classList.toggle("active",b.dataset.storeTab===tab));
  const catalog=[...(storeData.themes||[]).map(x=>({...x,category:"theme",categoryLabel:"GAME COSMETIC"})),...(storeData.adminThemes||[]).map(x=>({...x,category:"theme",categoryLabel:"GAME COSMETIC",adminOnly:true})),...(storeData.chips||[]).map(x=>({...x,category:"chip",categoryLabel:"CHIPS"})),...(storeData.decks||[]).map(x=>({...x,category:"deck",categoryLabel:"BLACKJACK"})),...(storeData.tables||[]).map(x=>({...x,category:"table",categoryLabel:"TABLE"})),...(storeData.balls||[]).map(x=>({...x,category:"ball",categoryLabel:"CARD BACK"})),...(storeData.profileFrames||[]).map(x=>({...x,category:"profile_frame",categoryLabel:"PROFILE"})),...(storeData.profileBackgrounds||[]).map(x=>({...x,category:"profile_background",categoryLabel:"PROFILE"})),...(storeData.profileTitles||[]).map(x=>({...x,category:"profile_title",categoryLabel:"PROFILE"})),...(storeData.casinoItems||[]).map(x=>({...x,category:"casino",categoryLabel:(x.slot||"CASINO").toUpperCase()}))];
  let visible=catalog.filter(x=>{if(tab==="inventory")return x.owned;if(tab==="vip")return x.vipOnly;if(tab==="profile")return ["profile_frame","profile_background","profile_title"].includes(x.category);if(tab==="luxury")return Number(x.price||0)>=1000000;if(tab==="casino")return x.category==="casino";if(tab==="all")return true;return x.category===tab;});
  if(ownedOnly)visible=visible.filter(x=>x.owned);
  const titles={all:"FEATURED ITEMS",theme:"GAME COSMETICS",chip:"CHIPS",deck:"BLACKJACK",table:"TABLES",ball:"CARD BACKS",profile:"PROFILE FLEX",casino:"MY CASINO",luxury:"LUXURY",vip:"VIP MEMBERSHIP",inventory:"YOUR COLLECTION"};
  $("#store-results-title").textContent=titles[tab]||"HOUSE COLLECTION"; $("#store-results-count").textContent=`${visible.length} ITEM${visible.length===1?"":"S"}`;
  const catalogEl=$("#store-catalog"),empty=$("#store-empty"); empty.classList.toggle("hidden",visible.length!==0);
  const membershipCard=(tab==="all"||tab==="vip")?`<article class="vip-membership-card store-vip-deal ${vipActive?"is-active":""}"><div class="vip-deal-main"><div class="vip-deal-crown">♛</div><div><span class="vip-kicker">CASINO X • MEMBERSHIP</span><h3>VIP MEMBERSHIP</h3><p>${vipActive?"Your VIP access is active.":"Become one of the rarest players in the House."}</p></div></div><div class="vip-deal-price"><span>30 DAYS</span><strong>${formatMoney(vipPrice)}</strong></div><div class="vip-benefit-grid"><span>👑 VIP badge</span><span>💎 Exclusive cosmetics</span><span>🏠 VIP lounge</span><span>💰 +${formatMoney(vip.dailyBonus||10000000)} daily</span><span>⚡ ${Number(vip.xpMultiplier||1.25)}× XP</span><span>✨ VIP profile treatment</span></div><div class="vip-card-bottom">${vipActive?`<strong>ACTIVE • ${Number(vip.daysLeft||0)} DAYS LEFT</strong>`:`<strong>INSANE FLEX • 30 DAYS</strong>`}${vipActive?"":`<button class="store-action vip-buy-btn" id="btn-buy-vip">BUY VIP</button>`}</div></article>`:"";
  catalogEl.innerHTML=membershipCard+visible.map(x=>{
    const colors=previewCosmetic(x.category,x.id).split(","),state=x.equipped?"EQUIPPED":x.owned?"OWNED":x.limited?"SEASONAL":x.vipOnly&&!vipActive?"VIP ONLY":"AVAILABLE";
    const action=x.equipped?'<button class="store-action secondary" disabled>✓ EQUIPPED</button>':x.owned?`<button class="store-action" data-store-equip="${escapeAttr(x.category)}" data-id="${escapeAttr(x.id)}">EQUIP</button>`:x.limited?'<button class="store-action seasonal" disabled>SEASONAL</button>':x.vipOnly&&!vipActive?'<button class="store-action vip-locked" disabled>VIP REQUIRED</button>':`<button class="store-action" data-store-buy="${escapeAttr(x.category)}" data-id="${escapeAttr(x.id)}">BUY</button>`;
    const rarity=x.rarity||"COMMON",mark=x.category==="chip"?"✦":x.category==="ball"?"●":x.category==="deck"?"♠":x.category==="table"?"▰":x.category==="profile_frame"?"◉":x.category==="profile_background"?"▧":x.category==="profile_title"?"✦":x.category==="casino"?"⌂":"✥";
    return `<article class="store-product store-product-v3 rarity-border-${escapeAttr(rarity)} ${x.equipped?"is-equipped":""} ${x.owned?"is-owned":""} ${x.limited?"is-seasonal":""} ${x.vipOnly?"is-vip-only":""} ${Number(x.price||0)>=1000000?"is-luxury":""}"><div class="store-product-art" style="--preview-a:${colors[0]};--preview-b:${colors[1]}"><span class="store-item-rarity rarity-${escapeAttr(rarity)}">${escapeHtml(rarity)}</span><span class="store-product-category">${escapeHtml(x.categoryLabel)}</span><div class="store-product-mark">${mark}</div>${x.limited?`<span class="store-season-ribbon">LIMITED</span>`:""}</div><div class="store-product-copy"><div class="store-product-top"><span>${escapeHtml(state)}</span><span>${Number(x.price||0)>=1000000?"LUXURY":""}</span></div><h3>${escapeHtml(x.name)}</h3></div>${action}</article>`;
  }).join("");
  wireButton($("#btn-buy-vip"),()=>send({type:"buy_vip",token:authToken}));
  document.querySelectorAll("[data-store-buy]").forEach(b=>wireButton(b,()=>{const item=catalog.find(x=>x.category===b.dataset.storeBuy&&x.id===b.dataset.id);if(!item)return;if(ff.store_purchase_preview===false)send({type:"buy_cosmetic",token:authToken,category:item.category,id:item.id});else openStorePurchase(item);}));
  document.querySelectorAll("[data-store-equip]").forEach(b=>wireButton(b,()=>{b.disabled=true;b.classList.add("loading");send({type:"equip_cosmetic",token:authToken,category:b.dataset.storeEquip,id:b.dataset.id});}));
  wireStoreV3Hero();
}

function formatCountdown(sec){let s=Math.max(0,Math.floor(Number(sec||0))),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);return `${d}D ${String(h).padStart(2,"0")}H ${String(m).padStart(2,"0")}M`;}
function renderSeason(){
  if (!seasonData) {
    const list = $("#season-tier-list");
    if (list) list.innerHTML = '<div class="admin-empty">Loading season pass…</div>';
    if (authToken) try { send({ type: "season", token: authToken }); } catch (e) {}
    return;
  }
  const xp = Number(seasonData.xp || 0);
  const tiers = seasonData.tiers || [];
  const meta = seasonData.season || {};
  const xpEl = $("#season-xp");
  if (xpEl) xpEl.textContent = xp.toLocaleString() + " XP";
  const cd = $("#season-countdown");
  if (cd) cd.textContent = meta.active === false ? "SEASON ENDED" : formatCountdown(meta.remainingSeconds);
  const st = $("#season-season-status");
  if (st) st.textContent = meta.active === false ? "ACQUISITION CLOSED" : "ACTIVE";
  applySeasonTheme();
  const max = Math.max(1, Number(tiers.at(-1)?.xp || 1));
  const fill = $("#season-progress-fill");
  if (fill) fill.style.width = Math.min(100, Math.round(xp / max * 100)) + "%";
  const list = $("#season-tier-list");
  if (!list) return;
  if (!tiers.length) {
    list.innerHTML = '<div class="admin-empty">No season tiers configured.</div>';
    return;
  }
  list.innerHTML = tiers.map(t => {
    const r = t.reward || {};
    const type = (r.type || "reward").toUpperCase();
    const state = t.claimed ? "CLAIMED" : t.unlocked ? "AVAILABLE" : "LOCKED";
    const button = t.claimed
      ? '<button class="btn secondary" disabled>CLAIMED</button>'
      : t.unlocked
        ? `<button class="btn" data-season-claim="${t.tier}">CLAIM</button>`
        : '<button class="btn secondary" disabled>LOCKED</button>';
    const limited = (r.id && (String(r.id).includes("1927") || String(r.id).includes("crimson")))
      || ["deck","table","ball","theme","chip","title"].includes(r.type)
      ? '<span class="limited-badge">SEASONAL • PERMANENT ON CLAIM</span>' : "";
    return `<div class="season-tier ${t.unlocked?"unlocked":""} ${t.claimed?"claimed":""}"><div class="season-tier-num">${t.tier}</div><div class="season-reward-copy"><strong>${escapeHtml(r.name||"REWARD")}</strong><small>${type} • ${Number(t.xp).toLocaleString()} XP</small>${limited}</div><div class="season-state">${state}</div>${button}</div>`;
  }).join("");
  list.querySelectorAll("[data-season-claim]").forEach(b => wireButton(b, () => {
    send({ type: "claim_season", token: authToken, tier: Number(b.dataset.seasonClaim) });
  }));
}
function openProgress(id) { $(id).classList.add("open"); }
function maybeShowFirstHelp(game) {
  try {
    if (game === "poker" && localStorage.getItem("cx_help_poker_seen") !== "1") {
      setTimeout(() => openProgress("#help-poker-overlay"), 400);
    } else if (game === "blackjack" && localStorage.getItem("cx_help_bj_seen") !== "1") {
      setTimeout(() => openProgress("#help-bj-overlay"), 400);
    }
  } catch (e) {}
}
function closeProgress(id) { $(id).classList.remove("open"); }

const CHAT_EMOJIS = ["😀","😂","🤣","😍","🔥","💯","👏","🙌","😎","🤔","😭","💪","🎉","🃏","♠️","♥️","♦️","♣️","🤑","👀","✅","❌","🙏","💀","🤝","🏆"];

function formatChatText(text) {
  const raw = String(text || "");
  // Allow safe image/gif URLs to render inline
  const urlRe = /(https?:\/\/[^\s]+\.(?:gif|png|jpe?g|webp)(?:\?[^\s]*)?)/gi;
  const parts = raw.split(urlRe);
  return parts.map(part => {
    if (/^https?:\/\//i.test(part) && /\.(gif|png|jpe?g|webp)/i.test(part)) {
      return `<a class="chat-media-link" href="${escapeAttr(part)}" target="_blank" rel="noopener noreferrer"><img class="chat-media" src="${escapeAttr(part)}" alt="gif" loading="lazy" /></a>`;
    }
    return escapeHtml(part);
  }).join("");
}


function showFloatingReaction(msg) {
  const emoji = msg.emoji || "👏";
  const targetId = msg.targetId;
  let anchor = document.querySelector(`.seat-slot[data-pid="${targetId}"], .poker-seat-slot[data-pid="${targetId}"]`);
  if (!anchor) anchor = document.querySelector(".seat-slot.me, .poker-seat-slot.me") || document.body;
  const el = document.createElement("div");
  el.className = "floating-reaction";
  el.textContent = emoji;
  const rect = anchor.getBoundingClientRect();
  el.style.left = (rect.left + rect.width / 2) + "px";
  el.style.top = (rect.top + 8) + "px";
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("go"));
  setTimeout(() => el.remove(), 2000);
}

function showAnnouncementBanner(text, from) {
  const ban = $("#announce-banner");
  if (!ban) return;
  ban.textContent = (from ? from + ": " : "") + (text || "");
  ban.classList.remove("hidden");
  ban.classList.add("show");
  clearTimeout(ban._t);
  ban._t = setTimeout(() => { ban.classList.remove("show"); ban.classList.add("hidden"); }, 8000);
}


function renderAdminUsers(users, tablePlayers, dealerPreviewActive, dealerPreview, tableLuck, adminCatalog, developer) {
  try {
    window.__adminCatalog = adminCatalog || [];
    window.__adminUsers = users || [];
    const seated = Array.isArray(tablePlayers) ? tablePlayers : [];
    const allUsers = Array.isArray(users) ? users : [];

    // --- Players tab ---
    const usersBox = document.getElementById("admin-users");
    if (usersBox) {
      if (!seated.length) {
        usersBox.innerHTML = '<div class="admin-empty">No players seated at this table. Join or wait for players.</div>';
      } else {
        usersBox.innerHTML = seated.map(p => {
          const id = escapeAttr(String(p.id || ""));
          const name = escapeHtml(p.username || "Player");
          const money = Number(p.money || 0).toLocaleString();
          const luck = Number(p.luckStrength || 0);
          const lucky = luck > 0 || p.lucky;
          return `<div class="admin-player-row" data-id="${id}">
            <div class="admin-player-main">
              <strong>${name}</strong>
              <span>$${money}${p.isAdmin ? " · ADMIN" : ""}${p.connected === false ? " · OFFLINE" : ""}</span>
            </div>
            <div class="admin-player-actions">
              <button type="button" class="btn secondary admin-give-btn" data-id="${id}" data-amount="500">+$500</button>
              <button type="button" class="btn secondary admin-give-btn" data-id="${id}" data-amount="5000">+$5K</button>
              <button type="button" class="btn secondary admin-give-btn" data-id="${id}" data-amount="50000">+$50K</button>
              <button type="button" class="btn ${lucky ? "on" : "secondary"} admin-luck-toggle" data-id="${id}" data-enabled="${lucky ? "0" : "1"}">${lucky ? "LUCK ON (" + luck + ")" : "LUCK OFF"}</button>
            </div>
            <div class="admin-player-luck">
              <label>Luck 0–100 <input type="range" min="0" max="100" value="${luck}" class="admin-luck-range" data-id="${id}"></label>
              <button type="button" class="btn secondary admin-luck-apply" data-id="${id}">SET LUCK</button>
            </div>
          </div>`;
        }).join("");
      }
    }

    // Economy / global money (all accounts)
    const eco = document.getElementById("admin-economy");
    if (eco) {
      const top = allUsers.slice().sort((a,b) => Number(b.money||0) - Number(a.money||0)).slice(0, 12);
      eco.innerHTML = `<div class="admin-section-title">GLOBAL BALANCES</div>` + (top.length ? top.map(u => {
        const un = escapeAttr(u.username || "");
        return `<div class="admin-player-row">
          <div class="admin-player-main"><strong>${escapeHtml(u.username||"")}</strong><span>$${Number(u.money||0).toLocaleString()} · NW $${Number(u.netWorth||0).toLocaleString()}</span></div>
          <div class="admin-player-actions">
            <button type="button" class="btn secondary admin-global-add" data-user="${un}" data-amount="10000">+$10K</button>
            <button type="button" class="btn secondary admin-global-set" data-user="${un}" data-amount="5000">SET $5K</button>
            <button type="button" class="btn secondary admin-global-reset" data-user="${un}">RESET</button>
          </div>
        </div>`;
      }).join("") : '<div class="admin-empty">No accounts loaded.</div>');
    }

    // --- Luck tab ---
    const luckBox = document.getElementById("admin-luck-controls");
    if (luckBox) {
      const tl = tableLuck || {};
      const tStrength = Number(tl.strength || 0);
      const tActive = !!tl.active;
      luckBox.innerHTML = `
        <div class="admin-section-title">TABLE LUCK (ROULETTE)</div>
        <p class="settings-help">0 = off · higher = stronger bias. Applies to table-level roulette luck.</p>
        <div class="admin-control-row">
          <label>Strength <input type="range" id="admin-table-luck-range" min="0" max="100" value="${tStrength}"></label>
          <span id="admin-table-luck-val">${tStrength}${tActive ? " · ACTIVE" : ""}</span>
          <button type="button" class="btn" id="admin-table-luck-apply">APPLY TABLE LUCK</button>
          <button type="button" class="btn secondary" id="admin-table-luck-clear">CLEAR</button>
        </div>
        <div class="admin-section-title" style="margin-top:14px">PER-PLAYER LUCK</div>
        ${seated.length ? seated.map(p => {
          const id = escapeAttr(String(p.id||""));
          const luck = Number(p.luckStrength||0);
          return `<div class="admin-player-row"><div class="admin-player-main"><strong>${escapeHtml(p.username||"")}</strong><span>Luck ${luck}</span></div>
            <div class="admin-player-luck">
              <input type="range" min="0" max="100" value="${luck}" class="admin-luck-range" data-id="${id}">
              <button type="button" class="btn secondary admin-luck-apply" data-id="${id}">SET</button>
            </div></div>`;
        }).join("") : '<div class="admin-empty">No seated players.</div>'}`;
    }

    // --- Cards tab ---
    const cardBox = document.getElementById("admin-card-selector");
    if (cardBox) {
      const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
      const suits = ["♠","♥","♦","♣"];
      const suitCodes = ["S","H","D","C"];
      if (!window.__adminForcedAssignments) window.__adminForcedAssignments = {};
      const targets = [{id:"dealer", label:"DEALER"}].concat(seated.map(p => ({id:String(p.id), label:p.username||p.id})));
      cardBox.innerHTML = targets.map(t => {
        const key = t.id;
        const cur = (window.__adminForcedAssignments[key] || []).map(c => `${c.rank}${c.suit}`).join(" ");
        return `<div class="admin-card-target" data-target="${escapeAttr(key)}">
          <strong>${escapeHtml(t.label)}</strong>
          <div class="admin-card-picks" data-target="${escapeAttr(key)}">${cur ? escapeHtml(cur) : "<span class='settings-help'>No forced cards</span>"}</div>
          <div class="admin-card-buttons">
            ${ranks.map(r => suits.map((s,i) => `<button type="button" class="btn secondary admin-card-pick" data-target="${escapeAttr(key)}" data-rank="${r}" data-suit="${suitCodes[i]}">${r}${s}</button>`).join("")).join("")}
            <button type="button" class="btn secondary admin-card-clear-one" data-target="${escapeAttr(key)}">CLEAR</button>
          </div>
        </div>`;
      }).join("");
    }

    // Dealer preview status
    const prev = document.getElementById("admin-preview");
    if (prev) {
      const on = !!dealerPreviewActive;
      const cards = Array.isArray(dealerPreview) ? dealerPreview : [];
      $("#admin-preview-toggle")?.classList.toggle("on", on);
      prev.innerHTML = on
        ? `<div class="settings-help">Preview ON · ${cards.map(c => escapeHtml((c.rank||"")+(c.suit||""))).join(" ") || "waiting for cards"}</div>`
        : `<div class="settings-help">Dealer preview is off.</div>`;
    }

    // Items / VIP tab shell (static controls may already exist in HTML — fill dynamic list)
    const itemsBox = document.getElementById("admin-item-controls");
    if (itemsBox && !itemsBox.dataset.ready) {
      const opts = (adminCatalog||[]).map(x => `<option value="${escapeAttr(x.category+':'+x.id)}">${escapeHtml(x.name)} (${escapeHtml(x.category)}) $${Number(x.price||0).toLocaleString()}</option>`).join("");
      itemsBox.innerHTML = `
        <div class="admin-global-gift">
          <label>PLAYER USERNAME <input id="admin-gift-user" maxlength="16" placeholder="username"></label>
          <label>ITEM <select id="admin-gift-item">${opts}</select></label>
          <button type="button" class="btn" id="admin-gift-send">GIVE ITEM</button>
        </div>
        <div class="admin-global-gift vip-gift-box">
          <label>GRANT VIP TO <input id="admin-vip-user" maxlength="16" placeholder="username"></label>
          <label>DAYS <select id="admin-vip-days"><option value="30">30</option><option value="90">90</option><option value="365">365</option></select></label>
          <button type="button" class="btn vip-admin-btn" id="admin-vip-send">GRANT VIP</button>
        </div>`;
      itemsBox.dataset.ready = "1";
    }

    // Season tab
    const seasonBox = document.getElementById("admin-season-controls");
    if (seasonBox) {
      const opts = seated.map(p => `<option value="${escapeAttr(String(p.id))}">${escapeHtml(p.username||p.id)}</option>`).join("");
      seasonBox.innerHTML = `
        <p class="settings-help">Give season XP to a seated player at this table.</p>
        <div class="admin-control-row">
          <select id="admin-season-target">${opts || '<option value="">No players</option>'}</select>
          <input id="admin-season-xp" type="number" min="1" value="100" style="width:100px">
          <button type="button" class="btn" id="admin-season-give">GIVE SEASON XP</button>
        </div>`;
    }

    // Developer tab
    if (developer) {
      try { renderDeveloperControls(developer, adminCatalog || []); } catch (e) { console.warn(e); }
    }

    // Wire dynamic buttons (event delegation once)
    if (!window.__adminDelegatesBound) {
      window.__adminDelegatesBound = true;
      document.addEventListener("click", (ev) => {
        const t = ev.target.closest("button");
        if (!t) return;
        if (t.classList.contains("admin-give-btn")) {
          send({ type: "admin_give_table_money", targetId: t.dataset.id, amount: Number(t.dataset.amount || 0) });
        } else if (t.classList.contains("admin-luck-toggle")) {
          send({ type: "admin_toggle_lucky", targetId: t.dataset.id, enabled: t.dataset.enabled === "1", strength: 50 });
        } else if (t.classList.contains("admin-luck-apply")) {
          const row = t.closest(".admin-player-row, .admin-player-luck") || t.parentElement;
          const range = row?.querySelector?.(".admin-luck-range") || document.querySelector(`.admin-luck-range[data-id="${t.dataset.id}"]`);
          const strength = Number(range?.value || 0);
          send({ type: "admin_set_player_luck", targetId: t.dataset.id, strength });
        } else if (t.classList.contains("admin-global-add")) {
          send({ type: "admin_add_money", username: t.dataset.user, amount: Number(t.dataset.amount || 0) });
        } else if (t.classList.contains("admin-global-set")) {
          send({ type: "admin_set_money", username: t.dataset.user, amount: Number(t.dataset.amount || 0) });
        } else if (t.classList.contains("admin-global-reset")) {
          send({ type: "admin_reset_money", username: t.dataset.user });
        } else if (t.classList.contains("admin-card-pick")) {
          const key = t.dataset.target;
          if (!window.__adminForcedAssignments[key]) window.__adminForcedAssignments[key] = [];
          window.__adminForcedAssignments[key].push({ rank: t.dataset.rank, suit: t.dataset.suit });
          // refresh picks label
          const box = document.querySelector(`.admin-card-picks[data-target="${key}"]`);
          if (box) box.textContent = window.__adminForcedAssignments[key].map(c => c.rank + c.suit).join(" ");
        } else if (t.classList.contains("admin-card-clear-one")) {
          const key = t.dataset.target;
          window.__adminForcedAssignments[key] = [];
          const box = document.querySelector(`.admin-card-picks[data-target="${key}"]`);
          if (box) box.innerHTML = "<span class='settings-help'>No forced cards</span>";
        } else if (t.id === "admin-table-luck-apply") {
          const strength = Number(document.getElementById("admin-table-luck-range")?.value || 0);
          send({ type: "admin_set_table_luck", strength, duration: 300 });
        } else if (t.id === "admin-table-luck-clear") {
          send({ type: "admin_set_table_luck", strength: 0, duration: 0 });
        } else if (t.id === "admin-gift-send") {
          const user = document.getElementById("admin-gift-user")?.value?.trim();
          const raw = document.getElementById("admin-gift-item")?.value || "";
          const [category, itemId] = raw.split(":");
          if (user && category && itemId) send({ type: "admin_give_item", targetUsername: user, category, itemId });
        } else if (t.id === "admin-vip-send") {
          const user = document.getElementById("admin-vip-user")?.value?.trim();
          const days = Number(document.getElementById("admin-vip-days")?.value || 30);
          if (user) send({ type: "admin_grant_vip", targetUsername: user, days });
        } else if (t.id === "admin-season-give") {
          const targetId = document.getElementById("admin-season-target")?.value;
          const xp = Number(document.getElementById("admin-season-xp")?.value || 100);
          if (targetId) send({ type: "admin_give_season_xp", targetId, amount: xp });
        }
      });
    }
  } catch (err) {
    console.error("renderAdminUsers error", err);
  }
}

function showPlayerProfilePopup(profile) {
  if (!profile) return;
  let pop = document.getElementById("player-profile-popup");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "player-profile-popup";
    pop.className = "player-profile-popup";
    pop.innerHTML = `<div class="ppp-card"><button type="button" class="icon-btn ppp-close" id="ppp-close" aria-label="Close">×</button><div id="ppp-body"></div></div>`;
    document.body.appendChild(pop);
    pop.addEventListener("click", (e) => {
      if (e.target === pop || e.target.id === "ppp-close" || e.target.classList.contains("ppp-close")) {
        pop.classList.remove("open");
      }
    });
  }
  const body = pop.querySelector("#ppp-body");
  const name = escapeHtml(profile.username || "Player");
  const title = escapeHtml(profile.levelTitle || profile.cosmetics?.title || "Rookie");
  const level = Number(profile.level || 1);
  const wealth = profile.wealth || {};
  const vip = profile.vip || {};
  const av = escapeHtml((profile.avatar || (profile.username || "?").slice(0,1)).toString().slice(0,2).toUpperCase());
  const color = escapeAttr(profile.avatarColor || "#c9a227");
  body.innerHTML = `
    <div class="ppp-header">
      <div class="ppp-avatar-wrap" style="background:linear-gradient(135deg,${color},#222)"><div class="ppp-avatar">${av}</div></div>
      <div class="ppp-name-wrap">
        <strong>${name}</strong>
        <span class="ppp-rank">Lv ${level} · ${title}${vip.active ? " · VIP" : ""}${profile.isAdmin ? " · ADMIN" : ""}</span>
      </div>
    </div>
    <div class="ppp-wealth">
      <span>NET WORTH</span>
      <strong>$${Number(wealth.netWorth != null ? wealth.netWorth : profile.money || 0).toLocaleString()}</strong>
      <small>${escapeHtml(wealth.rank || "")}</small>
    </div>
    <div class="ppp-showcase-grid">
      <div><b>${Number(profile.gamesPlayed || 0)}</b><span>Games</span></div>
      <div><b>${Number(profile.winRate || 0)}%</b><span>Win rate</span></div>
      <div><b>$${Number(profile.biggestWin || 0).toLocaleString()}</b><span>Biggest</span></div>
      <div><b>${Number(profile.collectionCount || 0)}</b><span>Collection</span></div>
    </div>
    <div class="ppp-actions">
      <button type="button" class="btn" id="ppp-visit-casino">${profile.isSelf ? "VISIT MY CASINO" : "VISIT CASINO"}</button>
      ${profile.isSelf ? `<button type="button" class="btn secondary" id="ppp-edit-casino">EDIT CASINO</button>` : `<button type="button" class="btn secondary" id="ppp-add-friend" data-user="${escapeAttr(profile.username||"")}">ADD FRIEND</button>`}
      <button type="button" class="btn secondary" id="ppp-close-btn">CLOSE</button>
    </div>`;
  body.querySelector("#ppp-close-btn")?.addEventListener("click", () => pop.classList.remove("open"));
  body.querySelector("#ppp-add-friend")?.addEventListener("click", (e) => {
    const u = e.currentTarget.dataset.user;
    if (u) send({ type: "friend_request", username: u });
    pop.classList.remove("open");
  });
  body.querySelector("#ppp-visit-casino")?.addEventListener("click", () => {
    pop.classList.remove("open");
    try {
      // Prefer full profile for self so equipped casino loads correctly
      const src = profile.isSelf && myProfile ? { ...myProfile, ...profile, casino: profile.casino || myProfile.casino } : profile;
      openCasinoViewer(src, !!profile.isSelf);
    } catch (err) {
      console.warn("openCasinoViewer", err);
    }
  });
  body.querySelector("#ppp-edit-casino")?.addEventListener("click", () => {
    pop.classList.remove("open");
    try {
      window.storeTab = "casino";
      window.storeOwnedOnly = false;
      openProgress("#store-overlay");
      send({ type: "store", token: authToken });
    } catch (err) {
      console.warn("edit casino", err);
    }
  });
  pop.classList.add("open");
}


function renderHandHistory(history) {
  const list = $("#history-list");
  if (!list) return;
  if (!history.length) {
    list.innerHTML = '<div class="admin-empty">No hands recorded yet this table.</div>';
  } else {
    list.innerHTML = history.slice().reverse().map((h, i) => {
      if (h.game === "poker") {
        const winners = (h.winners || []).map(w => `${escapeHtml(w.username)} +$${Number(w.amount||0).toLocaleString()} (${escapeHtml(w.hand||"")})`).join(", ");
        return `<div class="history-entry"><div class="history-head">POKER · Pot $${Number(h.pot||0).toLocaleString()}</div><div class="history-body">${winners || "—"}</div></div>`;
      }
      const rows = (h.players || []).map(p => `${escapeHtml(p.username)}: ${escapeHtml(String(p.result||"").toUpperCase())} · ${escapeHtml(p.hand||"")} ($${p.bet||0})`).join("<br>");
      return `<div class="history-entry"><div class="history-head">BLACKJACK · Dealer ${escapeHtml(h.dealer||"—")}</div><div class="history-body">${rows || "—"}</div></div>`;
    }).join("");
  }
  $("#history-overlay")?.classList.add("open");
}

function renderSidePots(state) {
  const panel = $("#side-pot-panel");
  if (!panel) return;
  const pots = state.sidePots || [];
  if (!pots.length || currentGame !== "poker") {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  panel.innerHTML = pots.map(p => `<div class="side-pot-row"><span>${escapeHtml(p.label || "Pot")}</span><strong>$${Number(p.amount||0).toLocaleString()}</strong></div>`).join("");
}

function updateSpecBetPanel(state) {
  const panel = $("#spec-bet-panel");
  if (!panel) return;
  const me = (state.players || []).find(p => p.id === myId) || (state.spectators || []).find(p => p.id === myId);
  // spectators are in state.spectators for BJ
  const amSpec = !!(me && me.spectator) || ((state.spectators || []).some(s => s.id === myId) && !(state.players || []).some(p => p.id === myId && !p.spectator));
  // simpler: check if I'm not seated
  const seated = (state.players || []).some(p => p.id === myId && !p.spectator);
  if (seated) {
    panel.classList.add("hidden");
    return;
  }
  // show for spectators
  const targets = (state.players || []).filter(p => !p.spectator);
  if (!targets.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  const sel = $("#spec-bet-target");
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = targets.map(t => `<option value="${t.id}">${escapeHtml(t.username || t.name)}</option>`).join("");
    if (prev) sel.value = prev;
  }
}

function sendChat(){
  const input = $("#chat-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  input.value = "";
  $("#chat-emoji-bar")?.classList.add("hidden");
}

function appendChat(username, text) {
  if (chatMuted) return;
  const box = $("#chat-messages");
  if (!box) return;
  const row = el("div", "chat-line");
  row.innerHTML = `<strong>${escapeHtml(username)}</strong><span class="chat-text">${formatChatText(text)}</span>`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function toggleChat(open) {
  const panel = $("#chat-panel");
  if (!panel) return;
  panel.classList.toggle("open", !!open);
  $("#btn-chat-open")?.classList.toggle("hidden", !!open);
  if (open) {
    // Prevent the panel from stretching the bottom of the app on mobile
    panel.style.maxHeight = "min(440px, 55dvh)";
    setTimeout(() => $("#chat-input")?.focus(), 50);
  } else {
    $("#chat-emoji-bar")?.classList.add("hidden");
  }
}

function populateEmojiBar() {
  const bar = $("#chat-emoji-bar");
  if (!bar || bar.dataset.ready) return;
  bar.dataset.ready = "1";
  bar.innerHTML = CHAT_EMOJIS.map(e => `<button type="button" class="chat-emoji-item" data-emoji="${e}">${e}</button>`).join("");
  bar.querySelectorAll("[data-emoji]").forEach(btn => {
    wireButton(btn, () => {
      const input = $("#chat-input");
      if (!input) return;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const emoji = btn.dataset.emoji || "";
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      input.focus();
      const pos = start + emoji.length;
      input.setSelectionRange(pos, pos);
    });
  });
}

// ---------------------------------------------------------------------------
// Profile / friends / public tables / chat
// ---------------------------------------------------------------------------
function renderProfile() {
  const p=myProfile;if(!p)return;const wealth=p.wealth||{};
  $("#profile-hero").innerHTML=`<div><strong>${escapeHtml(p.username)}</strong><span>LEVEL ${p.level} • ${escapeHtml(p.levelTitle)}</span></div><b>${formatMoney(p.balance)}</b>`;
  const st=p.stats||{},vals=[["CASINO GAMES",st.gamesPlayed],["CASINO WINS",st.wins],["LOSSES",st.losses],["BLACKJACKS",st.blackjacks],["POKER GAMES",st.pokerGames||0],["POKER WINS",st.pokerWins||0],["WIN RATE",(st.winRate||0)+"%"],["BIGGEST WIN",formatMoney(st.biggestWin)]];
  $("#profile-stats-grid").innerHTML=vals.map(([a,b])=>`<div class="stat-box"><span>${a}</span><strong>${b}</strong></div>`).join("");
  const wh=$("#profile-wealth-summary");if(wh)wh.innerHTML=`<div class="wealth-mini"><div><span>CASH</span><strong>${formatMoney(wealth.cash||p.balance)}</strong></div><div><span>COLLECTION VALUE</span><strong>${formatMoney(wealth.collectionValue)}</strong></div><div><span>NET WORTH</span><strong>${formatMoney(wealth.netWorth||p.balance)}</strong></div><div><span>STATUS</span><strong>${escapeHtml(wealth.rank||"ROOKIE")}</strong></div></div>`;
  renderFlexProfile();renderProfileFriends();
}
function renderProfileFriends(){
  const box=$("#profile-friends"); if(!box) return;
  box.innerHTML = friendsData.length ? friendsData.slice(0,8).map(f=>`<div class="friend-row"><span class="online-dot ${f.online?'online':''}"></span><strong>${escapeHtml(f.username)}</strong><small>Lv ${f.level}</small></div>`).join("") : '<div class="admin-empty">No friends yet.</div>';
}
function renderFriends(){
  const reqBox = $("#friends-requests");
  if (reqBox) {
    const incoming = friendRequests || [];
    const outgoing = friendOutgoing || [];
    let html = "";
    if (incoming.length) {
      html += incoming.map(f => `<div class="friend-row request"><span class="online-dot ${f.online?'online':''}"></span><div class="friend-meta"><strong>${escapeHtml(f.username)}</strong><small>Wants to be friends ${f.online?'• ONLINE':'• OFFLINE'}</small></div><button class="btn friend-accept" data-user="${escapeAttr(f.username)}">ACCEPT</button><button class="btn secondary friend-decline" data-user="${escapeAttr(f.username)}">DECLINE</button></div>`).join("");
    }
    if (outgoing.length) {
      html += outgoing.map(f => `<div class="friend-row outgoing"><span class="online-dot ${f.online?'online':''}"></span><div class="friend-meta"><strong>${escapeHtml(f.username)}</strong><small>Request pending</small></div><span class="friend-pending">SENT</span></div>`).join("");
    }
    if (!html) html = '<div class="admin-empty">No pending requests.</div>';
    reqBox.innerHTML = html;
    reqBox.querySelectorAll('.friend-accept').forEach(b => wireButton(b, () => send({ type: 'accept_friend', token: authToken, username: b.dataset.user })));
    reqBox.querySelectorAll('.friend-decline').forEach(b => wireButton(b, () => send({ type: 'decline_friend', token: authToken, username: b.dataset.user })));
  }
  const box=$("#friends-list"); if(!box) return;
  box.innerHTML = friendsData.length ? friendsData.map(f=>{
    const loc = f.location ? `${(f.location.game||'').toUpperCase()} ${f.location.room}` : (f.online ? "ONLINE" : "OFFLINE");
    const statusCls = f.online ? "online" : "offline";
    return `<div class="friend-row"><span class="online-dot ${statusCls}"></span><div class="friend-meta"><strong>${escapeHtml(f.username)}</strong><small>Lv ${f.level} • <span class="friend-status ${statusCls}">${escapeHtml(loc)}</span></small></div>${f.online?`<button class="btn secondary friend-invite" data-user="${escapeAttr(f.username)}">INVITE</button>`:''}<button class="btn secondary friend-remove" data-user="${escapeAttr(f.username)}">REMOVE</button></div>`;
  }).join("") : '<div class="admin-empty">No friends yet. Add someone by username — they must accept.</div>';
  box.querySelectorAll('.friend-remove').forEach(b=>wireButton(b,()=>send({type:'remove_friend',token:authToken,username:b.dataset.user})));
  box.querySelectorAll('.friend-invite').forEach(b=>wireButton(b,()=>send({type:'invite_friend',token:authToken,username:b.dataset.user})));
}

let seasonTicker=null;function startSeasonTicker(){if(seasonTicker)clearInterval(seasonTicker);seasonTicker=setInterval(()=>{if(!seasonData?.season)return;const rem=Math.max(0,Math.floor(Number(seasonData.season.endAt||0)-Date.now()/1000));seasonData.season.remainingSeconds=rem;if(rem<=0)seasonData.season.active=false;if($("#season-overlay").classList.contains("open"))renderSeason();applySeasonTheme()},1000)}
function renderPublicTables(){
  const box=$("#public-table-list"); if(!box) return;
  // Never show poker (or other) tables in the Blackjack lobby list
  const tables = (publicTables || []).filter(t => (t.game || "blackjack") === "blackjack");
  box.innerHTML = tables.length ? tables.map(t=>{
    const bots = Number(t.bots||0);
    const specs = Number(t.spectators||0);
    const extra = [bots ? `${bots} bot${bots===1?"":"s"}` : null, specs ? `${specs} spectator${specs===1?"":"s"}` : null].filter(Boolean).join(" · ");
    return `<div class="public-table-row"><div><strong>BLACKJACK • TABLE ${escapeHtml(t.code)}</strong><small>Host: ${escapeHtml(t.host)} · ${t.players}/${t.maxPlayers} players · ${t.phase === 'PLAYING' ? 'IN GAME' : 'WAITING'}${extra ? " · " + extra : ""}</small></div><div class="public-table-actions">${t.canJoin?`<button class="btn" data-join="${t.code}">JOIN</button>`:''}${t.canSpectate?`<button class="btn secondary" data-spec="${t.code}">WATCH</button>`:''}</div></div>`;
  }).join("") : '<div class="admin-empty">No public tables yet. Create one!</div>';
  box.querySelectorAll('[data-join]').forEach(b=>wireButton(b,()=>send({type:'join',token:authToken,room:b.dataset.join,game:'blackjack'})));
  box.querySelectorAll('[data-spec]').forEach(b=>wireButton(b,()=>send({type:'join',token:authToken,room:b.dataset.spec,game:'blackjack',spectate:true})));
}

function renderPokerTables(){
  const box=$("#poker-table-list"); if(!box) return;
  const tables=pokerTables.filter(t=>t.game==="poker");
  box.innerHTML=tables.length ? tables.map(t=>{
    const bots = Number(t.bots||0);
    const specs = Number(t.spectators||0);
    const extra = [bots ? `${bots} bot${bots===1?"":"s"}` : null, specs ? `${specs} spectator${specs===1?"":"s"}` : null].filter(Boolean).join(" · ");
    return `<div class="public-table-row"><div><strong>POKER • TABLE ${escapeHtml(t.code)}</strong><small>Host: ${escapeHtml(t.host||"—")} · ${t.players}/${t.maxPlayers} seated · ${escapeHtml(t.phase||"WAITING")}${extra ? " · " + extra : ""}</small></div><div class="public-table-actions">${t.canJoin!==false?`<button class="btn" data-rjoin="${t.code}">JOIN</button>`:''}<button class="btn secondary" data-rspec="${t.code}">WATCH</button></div></div>`;
  }).join("") : '<div class="admin-empty">No Poker tables yet. Create one!</div>';
  box.querySelectorAll("[data-rjoin]").forEach(b=>wireButton(b,()=>send({type:"join",token:authToken,room:b.dataset.rjoin,game:"poker"})));
  box.querySelectorAll("[data-rspec]").forEach(b=>wireButton(b,()=>send({type:"join",token:authToken,room:b.dataset.rspec,game:"poker",spectate:true})));
}


const RANK_VAL = {A:14,K:13,Q:12,J:11,"10":10,"9":9,"8":8,"7":7,"6":6,"5":5,"4":4,"3":3,"2":2};
const HAND_LABELS = ["High Card","One Pair","Two Pair","Three of a Kind","Straight","Flush","Full House","Four of a Kind","Straight Flush","Royal Flush"];

function evalPokerHandLive(hole, community) {
  const cards = [...(hole||[]), ...(community||[])].filter(c => c && c.rank && c.suit && c.faceUp !== false);
  if (cards.length < 2) return null;
  const all = cards.map(c => ({ r: RANK_VAL[c.rank] || 0, s: c.suit, raw: c }));
  // generate 5-card combos (or use all if <5)
  function score5(five) {
    const ranks = five.map(c => c.r).sort((a,b)=>b-a);
    const suits = five.map(c => c.s);
    const flush = suits.every(s => s === suits[0]);
    const uniq = [...new Set(ranks)].sort((a,b)=>b-a);
    let straight = false, sh = 0;
    if (uniq.length === 5 && uniq[0] - uniq[4] === 4) { straight = true; sh = uniq[0]; }
    if (new Set(ranks).size === 5 && ranks.includes(14) && ranks.includes(5) && ranks.includes(4) && ranks.includes(3) && ranks.includes(2)) {
      straight = true; sh = 5;
    }
    const counts = {};
    ranks.forEach(r => counts[r] = (counts[r]||0)+1);
    const byC = Object.entries(counts).map(([r,c]) => [Number(r), c]).sort((a,b) => b[1]-a[1] || b[0]-a[0]);
    let tier = 0, tb = ranks.slice();
    if (straight && flush) { tier = sh === 14 ? 9 : 8; tb = [sh]; }
    else if (byC[0][1] === 4) { tier = 7; tb = [byC[0][0], byC[1]?.[0]||0]; }
    else if (byC[0][1] === 3 && byC[1] && byC[1][1] === 2) { tier = 6; tb = [byC[0][0], byC[1][0]]; }
    else if (flush) { tier = 5; }
    else if (straight) { tier = 4; tb = [sh]; }
    else if (byC[0][1] === 3) { tier = 3; tb = [byC[0][0], ...byC.slice(1).map(x=>x[0])]; }
    else if (byC[0][1] === 2 && byC[1] && byC[1][1] === 2) { tier = 2; tb = [Math.max(byC[0][0],byC[1][0]), Math.min(byC[0][0],byC[1][0]), byC[2]?.[0]||0]; }
    else if (byC[0][1] === 2) { tier = 1; tb = [byC[0][0], ...byC.slice(1).map(x=>x[0])]; }
    else { tier = 0; }
    return { tier, tb, five };
  }
  let best = null;
  const n = all.length;
  if (n <= 5) {
    best = score5(all);
  } else {
    // combinations of 5
    const idx = [];
    function rec(start, path) {
      if (path.length === 5) {
        const sc = score5(path.map(i => all[i]));
        if (!best || sc.tier > best.tier || (sc.tier === best.tier && JSON.stringify(sc.tb) > JSON.stringify(best.tb))) best = sc;
        return;
      }
      for (let i = start; i < n; i++) { path.push(i); rec(i+1, path); path.pop(); }
    }
    rec(0, []);
  }
  if (!best) return null;
  // Only highlight the cards that *make* the hand (pair cards, trips, etc.) — not kickers.
  const five = best.five;
  const ranks = five.map(c => c.r);
  const counts = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  const tier = best.tier;
  let keySet = new Set();
  if (tier === 0) {
    // High card: only the highest card
    const top = five.slice().sort((a,b) => b.r - a.r)[0];
    if (top) keySet.add(top.raw.rank + top.raw.suit);
  } else if (tier === 1) {
    // One pair: only the two pairing ranks
    const pairRank = Object.keys(counts).map(Number).find(r => counts[r] === 2);
    five.filter(c => c.r === pairRank).forEach(c => keySet.add(c.raw.rank + c.raw.suit));
  } else if (tier === 2) {
    // Two pair: both pairs (4 cards), not the kicker
    Object.keys(counts).map(Number).filter(r => counts[r] === 2).forEach(pr => {
      five.filter(c => c.r === pr).forEach(c => keySet.add(c.raw.rank + c.raw.suit));
    });
  } else if (tier === 3) {
    // Three of a kind: only the trips
    const tripRank = Object.keys(counts).map(Number).find(r => counts[r] === 3);
    five.filter(c => c.r === tripRank).forEach(c => keySet.add(c.raw.rank + c.raw.suit));
  } else if (tier === 6) {
    // Full house: trips + pair (all 5 are "made")
    five.forEach(c => keySet.add(c.raw.rank + c.raw.suit));
  } else if (tier === 7) {
    // Quads: only the four of a kind
    const quadRank = Object.keys(counts).map(Number).find(r => counts[r] === 4);
    five.filter(c => c.r === quadRank).forEach(c => keySet.add(c.raw.rank + c.raw.suit));
  } else if (tier === 4 || tier === 5 || tier === 8 || tier === 9) {
    // Straight / Flush / Straight Flush / Royal: all five make the hand
    five.forEach(c => keySet.add(c.raw.rank + c.raw.suit));
  } else {
    five.forEach(c => keySet.add(c.raw.rank + c.raw.suit));
  }
  // Also mark matching rank cards on the full board/hole (e.g. pair of 9s both highlighted even if best-5 picked specific suits)
  // For pairs/trips/quads, highlight every instance of that rank among hole+community so board + hand both glow.
  if (tier === 1 || tier === 2 || tier === 3 || tier === 7) {
    const madeRanks = new Set();
    keySet.forEach(k => {
      // recover rank from key: rank is all but last char(s) for suit - better use five ranks we already have
    });
    const targetRanks = new Set();
    if (tier === 1) Object.keys(counts).map(Number).filter(r => counts[r] === 2).forEach(r => targetRanks.add(r));
    if (tier === 2) Object.keys(counts).map(Number).filter(r => counts[r] === 2).forEach(r => targetRanks.add(r));
    if (tier === 3) Object.keys(counts).map(Number).filter(r => counts[r] === 3).forEach(r => targetRanks.add(r));
    if (tier === 7) Object.keys(counts).map(Number).filter(r => counts[r] === 4).forEach(r => targetRanks.add(r));
    // expand to all cards of those ranks in hole+community (not just the chosen 5)
    keySet = new Set();
    all.filter(c => targetRanks.has(c.r)).forEach(c => keySet.add(c.raw.rank + c.raw.suit));
  }
  return { name: HAND_LABELS[best.tier] || "High Card", tier: best.tier, highlightKeys: keySet };
}

function pokerCardHTML(c, small, highlight){
  // Face-down / missing card → permanent card-back (visible until showdown reveal)
  if (!c || c.faceUp === false || c.faceUp === "false" || (!c.rank && !c.suit)) {
    return `<div class="playing-card card-back ${small ? "small" : ""}" aria-hidden="true"></div>`;
  }
  const red = c.suit === "H" || c.suit === "D";
  const suitSym = { S: "♠", H: "♥", D: "♦", C: "♣" }[c.suit] || c.suit;
  const hl = highlight ? " poker-card-hl" : "";
  return `<div class="playing-card ${red ? "red" : "black"} ${small ? "small" : ""}${hl}"><span class="card-rank">${c.rank}</span><span class="card-suit">${suitSym}</span></div>`;
}


function renderSpectatorPanel(state, listId, btnId) {
  const list = $(listId);
  const btn = $(btnId);
  const panel = list ? list.closest(".spectator-panel") : null;
  // The Poker spectator panel stays in normal document flow.
  // Its responsive CSS keeps it compact so it cannot cover the felt or action dock.
  if (panel) panel.classList.remove("hidden");
  if (!list) return;
  const specs = state.spectators || [];
  const seated = (state.players || []).filter(p => !p.spectator);
  const imSeated = seated.some(p => p.id === myId);
  const imSpec = specs.some(s => s.id === myId);
  list.innerHTML = specs.length
    ? specs.map(s => {
        const av = avatarHTML({ username: s.username || s.name, avatar: s.avatar, avatarColor: s.avatarColor || s.avatar_color });
        return `<div class="spec-row">${av}<span>${escapeHtml(s.username || s.name || "?")}</span></div>`;
      }).join("")
    : '<div class="spec-empty">No spectators</div>';
  if (btn) {
    const openSeat = seated.length < (state.maxPlayers || 7);
    btn.classList.toggle("hidden", !(imSpec && openSeat));
    btn.disabled = !openSeat;
    btn.textContent = openSeat ? "TAKE SEAT" : "TABLE FULL";
  }
}

function renderPokerState(state){
  if(!state) return;
  pokerState = state;
  myRoom = state.code || myRoom;
  const me = (state.players||[]).find(p=>p.id===myId);
  $("#poker-profile-name") && ($("#poker-profile-name").textContent = me?.username || loggedUsername || "PLAYER");
  // Table stack (chips) vs bank (money) — show stack at table
  const stack = Number(me?.chips ?? 0);
  const bank = Number(me?.money ?? myBalance ?? 0);
  $("#poker-balance") && ($("#poker-balance").textContent = "$" + stack.toLocaleString() + (bank ? " · bank $" + bank.toLocaleString() : ""));
  if (me && me.money != null) myBalance = Number(me.money);
  setChipAvatar($("#poker-profile-avatar"), me ? {username: me.username, avatar: me.avatar || myProfile?.avatar, avatarColor: me.avatarColor || me.avatar_color || myProfile?.avatarColor} : myProfile);
  $("#poker-room-chip") && ($("#poker-room-chip").textContent = "POKER " + (state.code||""));
  $("#poker-player-count") && ($("#poker-player-count").textContent = `${(state.seatedCount!=null?state.seatedCount:(state.players||[]).length)}/${state.maxPlayers||6}`);
  const isSpectator = !me && (state.spectators || []).some(s => s.id === myId);
  renderSpectatorPanel(state, "#poker-spectator-list", "#btn-poker-sit-down");

  $("#poker-status") && ($("#poker-status").textContent = isSpectator ? "SPECTATING" : (state.phase || "WAITING"));
  $("#poker-street") && ($("#poker-street").textContent = state.street || "—");
  $("#poker-pot") && ($("#poker-pot").textContent = "POT $" + Number(state.pot||0).toLocaleString());
  updatePokerChipPile(state.pot);

  // Win / loss animations when a hand resolves
  if (state.phase !== prevPokerPhase) {
    if (state.phase === "HAND_OVER" || state.phase === "SHOWDOWN") {
      triggerPokerResult(state, me);
    }
    if (state.phase === "PREFLOP" || state.phase === "WAITING") {
      pokerResultPlayedKey = null;
    }
    prevPokerPhase = state.phase;
  }

  // Live hand strength for local player (name + which cards to highlight)
  let liveHand = null;
  if (me && (me.hole || []).length) {
    liveHand = evalPokerHandLive(me.hole, state.community || []);
    if (liveHand) me._liveHand = liveHand.name;
  }

  // Community cards — highlight cards that contribute to your best hand
  const comm = $("#poker-community");
  if (comm) {
    const cards = state.community || [];
    const hlKeys = liveHand ? liveHand.highlightKeys : null;
    const key = cards.map(c => (c.rank || "") + (c.suit || "")).join("|") + "|" + (liveHand ? liveHand.name : "");
    if (comm.dataset.boardKey !== key) {
      const prevLen = Number(comm.dataset.prevLen || 0);
      comm.dataset.boardKey = key;
      comm.dataset.prevLen = String(cards.length);
      if (!cards.length) {
        comm.innerHTML = '<div class="poker-comm-placeholder">COMMUNITY</div>';
      } else {
        const isNewBoard = cards.length !== prevLen;
        comm.innerHTML = cards.map((c) => {
          const ck = (c.rank || "") + (c.suit || "");
          const html = pokerCardHTML(c, false, hlKeys && hlKeys.has(ck));
          return isNewBoard ? html.replace('class="playing-card', 'class="playing-card poker-deal-in') : html;
        }).join("");
      }
    }
  }

  // Winners banner
  const winBox = $("#poker-winners");
  if(winBox){
    if((state.phase==="HAND_OVER"||state.phase==="SHOWDOWN") && (state.winners||[]).length){
      winBox.innerHTML = state.winners.map(w=>`<div class="poker-winner-chip"><strong>${escapeHtml(w.username)}</strong> wins $${Number(w.amount||0).toLocaleString()} — ${escapeHtml(w.handName||"")}</div>`).join("");
      winBox.classList.remove("hidden");
    } else {
      winBox.innerHTML = "";
      winBox.classList.add("hidden");
    }
  }

  // Seats are anchored around the felt, Blackjack-style. The viewer is placed
  // at the bottom centre when seated; the remaining players rotate around the
  // oval. Empty positions remain visible so the table always feels like a
  // real 6-seat table.
  const seats = $("#poker-seats");
  if (seats) {
    seats.innerHTML = "";
    seats.className = "poker-seats-row";
    const players = (state.players || []).filter(p => p.connected !== false && !p.spectator);
    const maxP = Math.max(2, Math.min(Number(state.maxPlayers || 6), 6));
    seats.dataset.seatCount = String(maxP);
    const meP = players.find(p => p.id === myId);
    const ordered = [];
    if (meP) ordered.push(meP);
    players.forEach(p => { if (p.id !== myId) ordered.push(p); });

    const desktopPositionsByCount = {
      // YOU at bottom rim; opponents around the oval — leave centre free for board/pot/hole.
      2: [[50, 90], [50, 14]],
      3: [[50, 90], [14, 22], [86, 22]],
      4: [[50, 90], [12, 50], [50, 14], [88, 50]],
      5: [[50, 90], [12, 58], [18, 18], [82, 18], [88, 58]],
      6: [[50, 90], [12, 62], [14, 20], [50, 12], [86, 20], [88, 62]]
    };
    const mobilePositionsByCount = {
      // Compact oval — YOU at bottom, opponents around the rim without crowding the board.
      2: [[50, 88], [50, 16]],
      3: [[50, 88], [14, 30], [86, 30]],
      4: [[50, 88], [10, 48], [50, 14], [90, 48]],
      5: [[50, 88], [10, 55], [16, 22], [84, 22], [90, 55]],
      6: [[50, 88], [10, 58], [14, 22], [50, 14], [86, 22], [90, 58]]
    };
    const mobileMode = document.documentElement.getAttribute("data-mobile") === "1";
    const positionsByCount = mobileMode ? mobilePositionsByCount : desktopPositionsByCount;
    const positions = positionsByCount[maxP] || positionsByCount[6];

    for (let i = 0; i < maxP; i++) {
      const p = ordered[i];
      const [x, y] = positions[i];
      const seat = el(
        "div",
        "poker-seat-slot" +
          (p && p.isTurn ? " turn" : "") +
          (p && p.id === myId ? " me" : "") +
          (p && p.status === "folded" ? " folded" : "") +
          (p && p.isAdmin ? " admin-player" : "")
      );
      if (p) seat.dataset.pid = p.id;
      seat.style.setProperty("left", x + "%", "important");
      seat.style.setProperty("top", y + "%", "important");

      if (p) {
        const badges = [];
        if (p.isDealer) badges.push('<span class="poker-badge dealer">D</span>');
        if (p.isSB) badges.push('<span class="poker-badge sb">SB</span>');
        if (p.isBB) badges.push('<span class="poker-badge bb">BB</span>');
        if (p.isAdmin) badges.push('<span class="admin-crown" title="Admin">♛</span>');
        const isMe = p.id === myId;
        // Opponents: permanent card-backs during a live hand; real cards at showdown/hand-over.
        // Self: large hole cards live in #poker-hole — seat only shows avatar/name/chips.
        let holeHtml = "";
        if (!isMe) {
          const phaseActive = ["PREFLOP","FLOP","TURN","RIVER","SHOWDOWN","HAND_OVER"].includes(state.phase);
          const folded = p.status === "folded";
          if (phaseActive && (!folded || p.showHole)) {
            const cards = (p.hole && p.hole.length)
              ? p.hole
              : [{ faceUp: false }, { faceUp: false }];
            // Ensure at least 2 backs if server sent fewer
            while (cards.length < 2 && !["SHOWDOWN","HAND_OVER"].includes(state.phase)) {
              cards.push({ faceUp: false });
            }
            holeHtml = cards.map(c => pokerCardHTML(c, true)).join("");
          }
        }
        const actionBadge = p.isTurn ? '<div class="poker-action-badge">ACTION</div>' : "";
        // Hand label for ME is shown under hole cards (#poker-hole-hand) to avoid overlapping the board.
        // Opponents still show hand name on their seat at showdown.
        const handLabel = (!isMe && p.handName) ? `<div class="poker-seat-hand">${escapeHtml(p.handName)}</div>` : "";
        const nameClass = p.isAdmin ? "poker-seat-name admin-name" : "poker-seat-name";
        // Card backs ABOVE avatar so they are visible (Gambit-style)
        seat.innerHTML = `${actionBadge}
          <div class="poker-seat-cards">${holeHtml}</div>
          ${avatarHTML(p)}
          <div class="${nameClass}">${escapeHtml(p.username || "?")}${isMe ? " (YOU)" : ""}${p.isBot ? " 🤖" : ""}${badges.join("")}</div>
          <div class="poker-seat-chips">$${Number(p.chips || 0).toLocaleString()}</div>
          <div class="poker-seat-bet">${p.bet ? ("$" + Number(p.bet).toLocaleString()) : ""}</div>
          ${handLabel}`;
        seat.style.cursor = "pointer";
        seat.addEventListener("click", (ev) => {
          if (ev.target.closest(".seat-plus")) return;
          send({ type: "player_profile_peek", playerId: p.id });
        });
        seats.appendChild(seat);
      } else {
        const empty = el("div", "poker-seat-slot empty");
        empty.style.setProperty("left", x + "%", "important");
        empty.style.setProperty("top", y + "%", "important");
        const plus = el("button", "seat-plus", "+");
        plus.type = "button";
        plus.title = "Invite a friend";
        wireButton(plus, () => openSeatInvite());
        empty.appendChild(plus);
        empty.appendChild(el("div", "seat-open-label", "OPEN"));
        seats.appendChild(empty);
      }
    }
  }


  // Voluntary SHOW CARDS during showdown / hand over
  let showBtn = document.getElementById("poker-show-cards-btn");
  if (["SHOWDOWN", "HAND_OVER"].includes(state.phase) && me) {
    if (!showBtn) {
      showBtn = document.createElement("button");
      showBtn.id = "poker-show-cards-btn";
      showBtn.className = "btn secondary poker-show-cards-btn";
      showBtn.textContent = "SHOW CARDS";
      const felt = document.querySelector(".poker-felt") || $("#screen-poker");
      if (felt) felt.appendChild(showBtn);
      showBtn.addEventListener("click", () => send({ type: "poker_show_cards" }));
    }
    showBtn.classList.remove("hidden");
  } else if (showBtn) {
    showBtn.classList.add("hidden");
  }

  // My hole cards — large, above the player seat (Gambit-style), highlighted if in best hand
  const hole = $("#poker-hole");
  const holeHand = $("#poker-hole-hand");
  if (hole) {
    const myHole = (me && me.hole) ? me.hole : [];
    const hlKeys = liveHand ? liveHand.highlightKeys : null;
    const handName = (liveHand && liveHand.name) || (me && me.handName) || "";
    const hKey = myHole.map(c => (c.rank||"")+(c.suit||"")+(c.faceUp===false?"x":"")).join("|") + "|" + handName;
    if (hole.dataset.holeKey !== hKey) {
      hole.dataset.holeKey = hKey;
      if (myHole.length) {
        hole.classList.remove("hidden");
        hole.innerHTML = myHole.map(c => {
          const key = (c.rank||"")+(c.suit||"");
          return pokerCardHTML(c, false, hlKeys && hlKeys.has(key));
        }).join("");
      } else {
        hole.classList.add("hidden");
        hole.innerHTML = "";
      }
    }
    if (holeHand) {
      if (myHole.length && handName) {
        holeHand.textContent = handName;
        holeHand.classList.remove("hidden");
      } else {
        holeHand.textContent = "";
        holeHand.classList.add("hidden");
      }
    }
  } else if (holeHand) {
    holeHand.textContent = "";
    holeHand.classList.add("hidden");
  }

  // Action buttons — primary mobile trio is Fold / Check / Call;
  // Bet or Raise appears next to Call only when it is your turn and legal.
  const isMyTurn = state.activePlayerId === myId && ["PREFLOP","FLOP","TURN","RIVER"].includes(state.phase);
  const toCall = Math.max(0, Number(state.currentBet||0) - Number(me?.bet||0));
  const chips = Number(me?.chips||0);
  const canBet = isMyTurn && toCall===0 && chips>0;
  const canRaise = isMyTurn && toCall>0 && chips>toCall;
  const canAllin = isMyTurn && chips>0;
  const setBtn = (id, enabled, label) => {
    const b = $(id); if(!b) return;
    b.disabled = !enabled;
    if(label) b.textContent = label;
  };
  setBtn("#poker-fold", isMyTurn && me && me.status!=="folded" && me.status!=="allin", "FOLD");
  setBtn("#poker-check", isMyTurn && toCall===0 && me?.status!=="allin", "CHECK");
  setBtn("#poker-call", isMyTurn && toCall>0 && chips>0, toCall>0 ? `CALL $${toCall.toLocaleString()}` : "CALL");
  setBtn("#poker-bet", canBet, "BET");
  setBtn("#poker-raise", canRaise, "RAISE");
  setBtn("#poker-allin", canAllin, "ALL-IN");

  // Mobile: only surface Bet / Raise / All-In when they are actually available
  // so the main row stays Fold · Check/Call · (Bet/Raise when your turn).
  $("#poker-bet")?.classList.toggle("poker-act-secondary", true);
  $("#poker-raise")?.classList.toggle("poker-act-secondary", true);
  $("#poker-allin")?.classList.toggle("poker-act-secondary", true);
  $("#poker-bet")?.classList.toggle("hidden", !canBet);
  $("#poker-raise")?.classList.toggle("hidden", !canRaise);
  // Keep All-In visible whenever it is legal (common quick action), hide otherwise
  $("#poker-allin")?.classList.toggle("hidden", !canAllin);

  // Host start button + pre-game chrome
  const startBtn = $("#btn-poker-start-hand");
  const msgEl = $("#poker-table-msg");
  const isHost = !!(me?.isHost || state.hostId===myId);
  const canPhase = state.phase==="WAITING" || state.phase==="HAND_OVER" || !state.phase;
  const isActiveHand = ["PREFLOP","FLOP","TURN","RIVER","SHOWDOWN"].includes(state.phase);
  const seatedCount = (state.players||[]).filter(p => Number(p.chips||0) > 0).length;

  // Buy-in / rebuy when you have 0 table chips and hand is not running
  const buyinBar = $("#poker-buyin-bar");
  const tableBuyIn = Number(state.buyIn || 1000);
  if (buyinBar) {
    const needBuyin = !isSpectator && me && Number(me.chips || 0) <= 0 && canPhase;
    if (needBuyin) {
      buyinBar.classList.remove("hidden");
      buyinBar.innerHTML = `<span>Table buy-in <strong>$${tableBuyIn.toLocaleString()}</strong> (from your bank)</span>
        <button class="btn menu-primary" id="btn-poker-rebuy" type="button">BUY IN</button>`;
      const rb = $("#btn-poker-rebuy");
      if (rb && !rb.dataset.wired) {
        rb.dataset.wired = "1";
        wireButton(rb, () => send({ type: "poker_buyin" }));
      }
    } else {
      buyinBar.classList.add("hidden");
      buyinBar.innerHTML = "";
    }
  }
  // Host bots button visibility
  $("#poker-bots")?.classList.toggle("hidden", !isHost);
  // Sync host buy-in select
  const hostBuy = $("#host-poker-buyin");
  if (hostBuy && state.buyIn) hostBuy.value = String(state.buyIn);

  // Hide bet amount row unless the player just opened it on their turn
  const betRow = $("#poker-bet-row");
  if (betRow && !isMyTurn) betRow.classList.add("hidden");

  // Footer: during an active hand hide Start Hand; keep Cash Out / Leave compact
  const footerEl = document.querySelector("#screen-poker .poker-table-footer");
  if (footerEl) {
    footerEl.classList.toggle("poker-footer-ingame", isActiveHand || !canPhase);
    footerEl.classList.toggle("hidden", false);
  }
  if(startBtn){
    startBtn.classList.toggle("hidden", !isHost || isActiveHand || !canPhase);
    startBtn.disabled = !(isHost && canPhase);
    if(isHost && canPhase && seatedCount < 2){
      startBtn.textContent = `START HAND (${seatedCount}/2)`;
    } else if(isHost && canPhase){
      startBtn.textContent = "START HAND";
    } else if(!canPhase){
      startBtn.textContent = "HAND IN PROGRESS";
    } else {
      startBtn.textContent = "START HAND";
    }
  }
  if(msgEl && canPhase){
    if(isSpectator){
      msgEl.className = "poker-table-msg";
      msgEl.textContent = "SPECTATING — TAKE SEAT WHEN A SPOT OPENS";
    } else if(seatedCount < 2){
      msgEl.className = "poker-table-msg";
      msgEl.textContent = `Waiting for players… ${seatedCount}/2 seated with chips`;
    } else if(isHost){
      msgEl.className = "poker-table-msg ok";
      msgEl.textContent = "Ready — press START HAND";
    } else {
      msgEl.className = "poker-table-msg";
      msgEl.textContent = "Waiting for host to start…";
    }
  } else if(msgEl && !canPhase){
    msgEl.className = "poker-table-msg";
    msgEl.textContent = "";
  }
  $("#poker-host")?.classList.toggle("hidden", !isHost);
}

function renderPokerHostList(){
  const box=$("#host-list"); if(!box || !pokerState) return;
  box.innerHTML="";
  const note = el("small","settings-help");
  note.textContent = "Use the 🤖 button in the top bar to add bots. Set buy-in above — all-in only risks the table stack.";
  box.appendChild(note);
  (pokerState.players||[]).forEach(p=>{
    const row=el("div","host-player");
    const label = (p.username||"?") + (p.id===myId?" (you)":"") + (p.isBot?" 🤖":"");
    row.appendChild(el("span",null,label));
    if(p.id===myId || p.isHost) row.appendChild(el("span","host-badge","HOST"));
    else {
      const actions=el("div","host-actions");
      if (!p.isBot) {
        const transferBtn=el("button","btn secondary kick-btn","MAKE HOST");
        wireButton(transferBtn,()=>{ if(confirm("Transfer host to "+p.username+"?")){ send({type:"transfer_host",targetId:p.id}); $("#host-overlay").classList.remove("open"); }});
        actions.appendChild(transferBtn);
      }
      const kickBtn=el("button","kick-btn","KICK");
      wireButton(kickBtn,()=>{ if(confirm("Remove "+p.username+"?")) send({type:"kick",targetId:p.id}); });
      actions.appendChild(kickBtn);
      row.appendChild(actions);
    }
    box.appendChild(row);
  });
  (pokerState.spectators||[]).forEach(s=>{
    const row=el("div","host-player");
    row.appendChild(el("span",null,(s.username||"?")+(s.isBot?" 🤖":"")+" (spectator)"));
    box.appendChild(row);
  });
}

function openPokerLobby(){
  if (myId || myRoom) send({ type: "leave_table" });
  clearTableClientState();
  currentGame = "poker";
  const err = $("#poker-room-error");
  if (err) err.textContent = "";
  const roomInput = $("#poker-room");
  if (roomInput && !roomInput.dataset.keep) roomInput.value = "";
  showScreen("#screen-poker-lobby");
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (err) err.textContent = "Connecting… try again in a moment.";
    connect();
  }
  send({ type: "public_tables", game: "poker" });
}

function openBlackjackLobby(){
  if (myId || myRoom) send({ type: "leave_table" });
  clearTableClientState();
  currentGame = "blackjack";
  $("#room-error") && ($("#room-error").textContent = "");
  showScreen("#screen-lobby");
  send({ type: "public_tables", game: "blackjack" });
}

function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function escapeAttr(v){return escapeHtml(v);}

// ---------------------------------------------------------------------------
// Settings (dark mode + volume) — persisted locally for convenience
// ---------------------------------------------------------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  $("#toggle-dark").classList.toggle("on", dark);
  localStorage.setItem("bj_dark", dark ? "1" : "0");
}
function applySound(enabled) {
  soundEnabled = !!enabled;
  $("#toggle-sound").classList.toggle("on", soundEnabled);
  localStorage.setItem("bj_sound", soundEnabled ? "1" : "0");
}
function applyVolume(v) {
  sfxVolume = v / 100;
  $("#volume-pct").textContent = v + "%";
  $("#slider-volume").value = v;
  localStorage.setItem("bj_volume", String(v));
}

function applyScale(v) {
  uiScale = Math.max(80, Math.min(130, Number(v) || 100));
  document.documentElement.style.setProperty("--ui-scale", String(uiScale / 100));
  $("#scale-pct").textContent = uiScale + "%";
  $("#slider-scale").value = uiScale;
  localStorage.setItem("bj_scale", String(uiScale));
}
function applyQuality(level) {
  const labels = ["Low", "Medium", "High"];
  const v = Math.max(0, Math.min(2, Number(level) || 2));
  document.documentElement.setAttribute("data-quality", String(v));
  const lbl = $("#quality-label");
  if (lbl) lbl.textContent = labels[v] || "High";
  const slider = $("#slider-quality");
  if (slider) slider.value = v;
  localStorage.setItem("bj_quality", String(v));
  document.documentElement.classList.toggle("opt-low", v === 0);
  document.documentElement.classList.toggle("opt-medium", v === 1);
  document.documentElement.classList.toggle("opt-high", v === 2);
}


function updateOrientation() {
  if (document.documentElement.getAttribute("data-mobile") !== "1") {
    document.documentElement.removeAttribute("data-orient");
    return;
  }
  const landscape = window.innerWidth > window.innerHeight;
  document.documentElement.setAttribute("data-orient", landscape ? "landscape" : "portrait");
}
window.addEventListener("resize", updateOrientation);
window.addEventListener("orientationchange", updateOrientation);

function applyMobileMode(enabled) {
  const on = !!enabled;
  document.documentElement.setAttribute("data-mobile", on ? "1" : "0");
  updateOrientation();
  $("#toggle-mobile")?.classList.toggle("on", on);
  $("#toggle-mobile-auth")?.classList.toggle("on", on);
  localStorage.setItem("bj_mobile", on ? "1" : "0");
  applyDeveloperUI(developerData);
  if (typeof pokerState !== "undefined" && pokerState && $("#screen-poker")?.classList.contains("active")) {
    renderPokerState(pokerState);
  }
}

function syncFullscreenToggle() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  $("#toggle-fullscreen")?.classList.toggle("on", on);
}

async function applyFullscreen(enabled) {
  try {
    if (enabled) {
      const el = document.documentElement;
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    } else if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
    }
  } catch (e) { /* denied / unsupported */ }
  syncFullscreenToggle();
}

const AVATAR_PRESETS = [
  { id: "fox", color: "#f59e0b" },
  { id: "wolf", color: "#64748b" },
  { id: "dragon", color: "#ef4444" },
  { id: "cat", color: "#ec4899" },
  { id: "dice", color: "#8b5cf6" },
  { id: "suit", color: "#14b8a6" },
];

function refreshAvatarPreview() {
  const prev = $("#avatar-preview");
  if (!prev) return;
  const letter = (loggedUsername || myProfile?.username || "?").charAt(0).toUpperCase();
  const color = myProfile?.avatarColor || "#6366f1";
  const av = myProfile?.avatar;
  if (av && String(av).startsWith("data:")) {
    prev.style.backgroundImage = `url(${av})`;
    prev.style.backgroundSize = "cover";
    prev.textContent = "";
  } else {
    prev.style.backgroundImage = "";
    prev.style.background = color;
    prev.textContent = letter;
  }
}

let avatarCrop = { img: null, scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

function openAvatarCrop(dataUrl) {
  const modal = $("#avatar-crop-modal");
  const img = $("#avatar-crop-img");
  const stage = $("#avatar-crop-stage");
  const zoom = $("#avatar-crop-zoom");
  if (!modal || !img || !stage) return;
  img.onload = () => {
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    avatarCrop.scale = stage.clientWidth / side;
    avatarCrop.x = (stage.clientWidth - img.naturalWidth * avatarCrop.scale) / 2;
    avatarCrop.y = (stage.clientHeight - img.naturalHeight * avatarCrop.scale) / 2;
    zoom.value = 100;
    applyAvatarCropTransform();
  };
  img.src = dataUrl;
  avatarCrop.img = dataUrl;
  modal.classList.remove("hidden");
}

function applyAvatarCropTransform() {
  const img = $("#avatar-crop-img");
  if (!img) return;
  const z = (parseInt($("#avatar-crop-zoom")?.value || "100", 10) / 100);
  const s = avatarCrop.scale * z;
  img.style.width = (img.naturalWidth * s) + "px";
  img.style.height = (img.naturalHeight * s) + "px";
  img.style.left = avatarCrop.x + "px";
  img.style.top = avatarCrop.y + "px";
}

function exportAvatarCrop() {
  const stage = $("#avatar-crop-stage");
  const img = $("#avatar-crop-img");
  if (!stage || !img) return null;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const z = (parseInt($("#avatar-crop-zoom")?.value || "100", 10) / 100);
  const s = avatarCrop.scale * z;
  // Draw circular crop of the visible stage area
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const scaleToCanvas = size / stage.clientWidth;
  ctx.drawImage(
    img,
    avatarCrop.x * scaleToCanvas,
    avatarCrop.y * scaleToCanvas,
    img.naturalWidth * s * scaleToCanvas,
    img.naturalHeight * s * scaleToCanvas
  );
  return canvas.toDataURL("image/jpeg", 0.85);
}

function initAvatarEditor() {
  const presets = $("#avatar-presets");
  if (presets && !presets.dataset.ready) {
    presets.dataset.ready = "1";
    presets.innerHTML = AVATAR_PRESETS.map(p =>
      `<button type="button" class="avatar-preset" data-preset="${p.id}" data-color="${p.color}" style="background:${p.color}" title="${p.id}">${p.id.charAt(0).toUpperCase()}</button>`
    ).join("");
    presets.querySelectorAll(".avatar-preset").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        play("click");
        send({ type: "set_avatar", token: authToken, avatar: "preset:" + btn.dataset.preset, color: btn.dataset.color });
      });
    });
  }
  const upload = $("#avatar-upload");
  if (upload && !upload.dataset.ready) {
    upload.dataset.ready = "1";
    upload.addEventListener("change", () => {
      const file = upload.files?.[0];
      if (!file) return;
      if (file.size > 2_500_000) { centerBanner("IMAGE TOO LARGE", "lose"); return; }
      const reader = new FileReader();
      reader.onload = () => openAvatarCrop(reader.result);
      reader.readAsDataURL(file);
      upload.value = "";
    });
  }
  const resetBtn = $("#btn-avatar-reset");
  if (resetBtn && !resetBtn.dataset.ready) {
    resetBtn.dataset.ready = "1";
    resetBtn.addEventListener("click", (e) => {
      e.preventDefault();
      play("click");
      send({ type: "set_avatar", token: authToken, avatar: "reset" });
    });
  }

  // Crop modal interactions
  const stage = $("#avatar-crop-stage");
  const zoom = $("#avatar-crop-zoom");
  if (stage && !stage.dataset.ready) {
    stage.dataset.ready = "1";
    const onDown = (e) => {
      avatarCrop.dragging = true;
      avatarCrop.lastX = e.clientX ?? e.touches?.[0]?.clientX;
      avatarCrop.lastY = e.clientY ?? e.touches?.[0]?.clientY;
    };
    const onMove = (e) => {
      if (!avatarCrop.dragging) return;
      const cx = e.clientX ?? e.touches?.[0]?.clientX;
      const cy = e.clientY ?? e.touches?.[0]?.clientY;
      avatarCrop.x += cx - avatarCrop.lastX;
      avatarCrop.y += cy - avatarCrop.lastY;
      avatarCrop.lastX = cx;
      avatarCrop.lastY = cy;
      applyAvatarCropTransform();
    };
    const onUp = () => { avatarCrop.dragging = false; };
    stage.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  if (zoom && !zoom.dataset.ready) {
    zoom.dataset.ready = "1";
    zoom.addEventListener("input", applyAvatarCropTransform);
  }
  const applyBtn = $("#avatar-crop-apply");
  const cancelBtn = $("#avatar-crop-cancel");
  if (applyBtn && !applyBtn.dataset.ready) {
    applyBtn.dataset.ready = "1";
    applyBtn.addEventListener("click", () => {
      const data = exportAvatarCrop();
      if (data) send({ type: "set_avatar", token: authToken, avatar: data });
      $("#avatar-crop-modal")?.classList.add("hidden");
      play("chip");
    });
  }
  if (cancelBtn && !cancelBtn.dataset.ready) {
    cancelBtn.dataset.ready = "1";
    cancelBtn.addEventListener("click", () => $("#avatar-crop-modal")?.classList.add("hidden"));
  }
}

function initSettings() {
  const savedDark = localStorage.getItem("bj_dark") === "1";
  applyTheme(savedDark);
  const savedSound = localStorage.getItem("bj_sound") !== "0";
  applySound(savedSound);
  const savedVol = parseInt(localStorage.getItem("bj_volume") || "60", 10);
  applyVolume(savedVol);
  const savedScale = parseInt(localStorage.getItem("bj_scale") || "100", 10);
  applyScale(savedScale);
  // Mobile mode: remember preference; auto-enable on narrow phones if never set
  (function initMobileMode() {
    const saved = localStorage.getItem("bj_mobile");
    if (saved === "1" || saved === "0") {
      applyMobileMode(saved === "1");
    } else {
      const narrow = window.matchMedia("(max-width: 700px), (max-aspect-ratio: 3/4)").matches
        || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
      applyMobileMode(narrow);
    }
  })();
  const savedQuality = parseInt(localStorage.getItem("bj_quality") || "2", 10);
  applyQuality(savedQuality);
  applySeasonTheme();

  $("#toggle-sound").addEventListener("click", () => {
    applySound(!soundEnabled); play("toggle");
  });
  $("#toggle-dark").addEventListener("click",()=>{play("toggle");applyTheme(!(document.documentElement.getAttribute("data-theme")==="dark"));});
  $("#toggle-mobile")?.addEventListener("click",()=>{play("toggle");applyMobileMode(!(document.documentElement.getAttribute("data-mobile")==="1"));});
  $("#toggle-mobile-auth")?.addEventListener("click",()=>{play("toggle");applyMobileMode(!(document.documentElement.getAttribute("data-mobile")==="1"));});
  $("#toggle-fullscreen")?.addEventListener("click",()=>{
    play("toggle");
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    applyFullscreen(!on);
  });
  document.addEventListener("fullscreenchange", syncFullscreenToggle);
  document.addEventListener("webkitfullscreenchange", syncFullscreenToggle);
  $("#toggle-seasonal-ui").addEventListener("click",()=>{play("toggle");applySeasonalUI(!(localStorage.getItem("bj_seasonal_ui") !== "0"));});
  $("#slider-volume").addEventListener("input", (e) => applyVolume(parseInt(e.target.value, 10)));
  $("#slider-scale").addEventListener("input", (e) => applyScale(parseInt(e.target.value, 10)));
  $("#slider-quality")?.addEventListener("input", (e) => applyQuality(parseInt(e.target.value, 10)));

  wireButton($("#btn-settings"), () => { $("#btn-leave-table").classList.remove("hidden"); $("#settings-overlay").classList.add("open"); });
  wireButton($("#btn-settings-menu"), () => { $("#btn-leave-table").classList.add("hidden"); $("#settings-overlay").classList.add("open"); });
  wireButton($("#btn-settings-shop"), () => {
    $("#settings-overlay")?.classList.remove("open");
    window.storeTab = "inventory";
    window.storeOwnedOnly = true;
    openProgress("#store-overlay");
    send({ type: "store", token: authToken });
  });
  // Settings "INVENTORY & EQUIP" header → open store inventory tab
  const invHead = document.querySelector(".settings-inv-head");
  if (invHead && !invHead.dataset.storeLink) {
    invHead.dataset.storeLink = "1";
    invHead.style.cursor = "pointer";
    invHead.title = "Open store inventory";
    invHead.addEventListener("click", () => {
      $("#settings-overlay")?.classList.remove("open");
      window.storeTab = "inventory";
      window.storeOwnedOnly = true;
      openProgress("#store-overlay");
      send({ type: "store", token: authToken });
    });
  }
  // Refresh inventory whenever settings opens
  const _openSettingsInv = () => { send({ type: "store", token: authToken }); setTimeout(() => { try { renderAppearance(); } catch(e){} }, 120); };
  document.querySelectorAll("#btn-settings, #poker-settings, #btn-settings-menu").forEach(btn => {
    if (btn && !btn.dataset.invHook) {
      btn.dataset.invHook = "1";
      btn.addEventListener("click", () => setTimeout(_openSettingsInv, 50));
    }
  });
  wireButton($("#btn-settings-close"), () => $("#settings-overlay").classList.remove("open"));

  // Update Log
  wireButton($("#btn-update-log"), () => openUpdateLog(true));
  wireButton($("#btn-update-log-close"), () => closeUpdateLog());
  wireButton($("#btn-update-log-gotit"), () => closeUpdateLog());
  $("#update-log-overlay")?.addEventListener("click", (e) => {
    if (e.target === $("#update-log-overlay")) closeUpdateLog();
  });

  // Invite toast actions
  wireButton($("#invite-accept"), () => {
    const toast = $("#invite-toast");
    if (!toast) return;
    const room = toast.dataset.room;
    const game = toast.dataset.game || "blackjack";
    toast.classList.add("hidden");
    if (room) send({ type: "join", token: authToken, room, game });
  });
  wireButton($("#invite-decline"), () => $("#invite-toast")?.classList.add("hidden"));

  // Avatar editor
  initAvatarEditor();

  // High Rollers auto-refresh every 20 minutes
  setInterval(() => {
    if (authToken) send({ type: "leaderboard", token: authToken });
  }, 20 * 60 * 1000);
  wireButton($("#btn-settings-appearance"), () => {
    $("#settings-overlay").classList.remove("open");
    $("#appearance-overlay").classList.add("open");
    send({type:"store",token:authToken});
    renderAppearance();
  });
  wireButton($("#btn-appearance-close"), () => $("#appearance-overlay").classList.remove("open"));

  // Host panel
  wireButton($("#btn-host"), () => {
    const wrap = $("#host-poker-buyin-wrap");
    if (wrap) wrap.classList.add("hidden");
    openHostPanel();
  });
  wireButton($("#poker-host"), () => openHostPanel());
  wireButton($("#btn-host-close"), () => $("#host-overlay").classList.remove("open"));
  $("#toggle-double-cash")?.addEventListener("click", () => {
    play("click");
    send({type: "toggle_double_cash"});
  });
  wireButton($("#btn-appearance-store"), () => {
    $("#appearance-overlay").classList.remove("open");
    openProgress("#store-overlay");
    send({type:"store",token:authToken});
  });
  wireButton($("#btn-leave-table"), () => {
    send({ type: "leave_table" });
    // Immediate local exit — server confirms with left_table; fail-safe if not
    clearTableClientState();
    if (myBalance) setMenuBalance(myBalance);
    else if (myProfile?.balance != null) setMenuBalance(myProfile.balance);
    showMainMenu();
    if (authToken) send({ type: "profile", token: authToken });
    setTimeout(() => {
      if ($("#screen-table")?.classList.contains("active") || $("#screen-poker")?.classList.contains("active")) {
        clearTableClientState();
        showMainMenu();
        if (authToken) send({ type: "profile", token: authToken });
      }
    }, 600);
  });
}

// ---------------------------------------------------------------------------
// Wire up static controls
// ---------------------------------------------------------------------------
function initControls() {
  buildChipRow();
  wireButton($("#btn-clear"), () => send({ type: "clear_bet" }));
  wireButton($("#btn-allin"), () => send({ type: "all_in" }));
  wireButton($("#btn-ready"), () => send({ type: "ready" }));
  wireButton($("#btn-hit"), () => { play("hit"); send({ type: "hit" }); });
  wireButton($("#btn-stand"), () => { play("stand"); send({ type: "stand" }); });
  wireButton($("#btn-split"), () => send({ type: "split", token: authToken }));
  wireButton($("#btn-double"), () => send({ type: "double" }));
}

function initJoin() {
  $("#auth-username").value = localStorage.getItem("bj_username_hint") || "";
  $("#tab-login").addEventListener("click", () => setAuthMode("login"));
  $("#tab-signup").addEventListener("click", () => setAuthMode("signup"));
  wireButton($("#btn-auth"), loginOrSignup);

  // Terms of Service modal wiring
  const tosLink = $("#tos-link");
  if (tosLink) tosLink.addEventListener("click", (e) => { e.preventDefault(); openTosModal(); });
  const tosClose = $("#tos-close");
  if (tosClose) tosClose.addEventListener("click", closeTosModal);
  const tosOverlay = $("#tos-modal");
  if (tosOverlay) tosOverlay.addEventListener("click", (e) => { if (e.target === tosOverlay) closeTosModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTosModal(); });

  wireButton($("#btn-play"), openBlackjackLobby);
  wireButton($("#game-blackjack"), openBlackjackLobby);
  wireButton($("#game-poker"), openPokerLobby);
  wireButton($("#btn-join-table"),()=>{
    const room=$("#input-room").value.trim();
    $("#room-error").textContent="";
    if(!room){$("#room-error").textContent="Enter a private table code, or use CREATE TABLE.";return;}
    const pin=($("#bj-join-pin")?.value||$("#bj-table-pin")?.value||"").trim();
    $("#bj-join-pin-wrap")?.classList.remove("hidden");
    send({type:"join",token:authToken,room,game:"blackjack",pin:pin||undefined});
  });
  wireButton($("#btn-spectate-table"),()=>{
    const room=$("#input-room").value.trim();
    $("#room-error").textContent="";
    if(!room){$("#room-error").textContent="Enter a table code to spectate.";return;}
    const pin=($("#bj-join-pin")?.value||$("#bj-table-pin")?.value||"").trim();
    send({type:"join",token:authToken,room,game:"blackjack",spectate:true,pin:pin||undefined});
  });
  wireButton($("#btn-back-menu"), () => {
    $("#room-error").textContent = "";
    showMainMenu();
  });
  wireButton($("#btn-logout"), () => {
    if (authToken) send({type:"logout", token:authToken});
    localStorage.removeItem("bj_session_token");
    authToken = null; loggedUsername = null; myId = null; myRoom = null; isAdmin = false;
    document.querySelector("#screen-join .auth-card").classList.remove("main-menu-mode");
    $("#btn-admin-float").classList.add("hidden");
    ["#stats-overlay","#leaderboard-overlay","#achievements-overlay","#daily-overlay","#store-overlay","#season-overlay"].forEach(id => $(id).classList.remove("open"));
    myProfile = null; leaderboardData = null;
    $("#auth-form").classList.remove("hidden"); $("#room-form").classList.add("hidden");
    $("#auth-password").value = ""; $("#auth-confirm").value = "";
    if (ws) { try { ws.close(); } catch(e) {} }
    ws = null; showScreen("#screen-join");
  });
  wireButton($("#btn-refresh-balance"), () => send({type:"refresh_balance"}));
  wireButton($("#btn-claim-100"), () => {
    send({type:"claim_100"});
    $("#claim-overlay").classList.remove("open");
  });
  wireButton($("#btn-host"), () => {
    const wrap = $("#host-poker-buyin-wrap");
    if (wrap) wrap.classList.add("hidden");
    renderHostList();
    $("#host-overlay").classList.add("open");
  });
  wireButton($("#btn-host-close"), () => $("#host-overlay").classList.remove("open"));
  const openAdmin = () => {
    $("#settings-overlay").classList.remove("open");
    $("#admin-overlay").classList.add("open");
    $("#admin-login-box").classList.toggle("hidden", isAdmin);
    $("#admin-dashboard").classList.toggle("hidden", !isAdmin);
    if (isAdmin) send({type:"admin_data"});
    else setTimeout(() => $("#admin-password").focus(), 120);
  };
  wireButton($("#btn-admin-float"), openAdmin);
  wireButton($("#btn-admin-table"), openAdmin);
  wireButton($("#poker-admin"), openAdmin);
  wireButton($("#poker-host"), () => {
    const wrap = $("#host-poker-buyin-wrap");
    if (wrap) wrap.classList.remove("hidden");
    renderPokerHostList();
    $("#host-overlay").classList.add("open");
  });

  // Poker bots panel (host)
  wireButton($("#poker-bots"), () => {
    $("#bots-overlay")?.classList.add("open");
  });
  wireButton($("#btn-bots-close"), () => $("#bots-overlay")?.classList.remove("open"));
  wireButton($("#btn-bots-add"), () => {
    const n = parseInt($("#bots-count")?.value || "1", 10) || 1;
    send({ type: "add_bot", count: n });
    $("#bots-overlay")?.classList.remove("open");
  });
  wireButton($("#btn-host-set-buyin"), () => {
    const amount = parseInt($("#host-poker-buyin")?.value || "1000", 10) || 1000;
    send({ type: "poker_set_buyin", amount });
  });
  // First-time player: help buttons glow until tutorial opened once
  function markHelpSeen(key) {
    try { localStorage.setItem(key, "1"); } catch (e) {}
    document.querySelectorAll(".help-glow").forEach(b => {
      if (b.id === "bj-help" && localStorage.getItem("cx_help_bj_seen") === "1") b.classList.remove("help-glow");
      if (b.id === "poker-help" && localStorage.getItem("cx_help_poker_seen") === "1") b.classList.remove("help-glow");
    });
  }
  function refreshHelpGlow() {
    if (localStorage.getItem("cx_help_bj_seen") === "1") $("#bj-help")?.classList.remove("help-glow");
    if (localStorage.getItem("cx_help_poker_seen") === "1") $("#poker-help")?.classList.remove("help-glow");
  }
  refreshHelpGlow();

  wireButton($("#admin-preview-toggle"), () => {
    if (isAdmin) send({type:"admin_toggle_preview", enabled: !$("#admin-preview-toggle").classList.contains("on")});
  });
  wireButton($("#btn-admin-login"), () => {
    $("#admin-error").textContent = "";
    send({type:"admin_login", password:$("#admin-password").value});
  });
  wireButton($("#btn-admin-refresh"), () => {
    if (isAdmin) send({type:"admin_login", password:$("#admin-password").value});
  });
  wireButton($("#btn-admin-close"), () => $("#admin-overlay").classList.remove("open"));

  // Admin sidebar tabs
  document.querySelectorAll(".admin-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".admin-pane").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const pane = document.querySelector(`.admin-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.add("active");
    });
  });
  wireButton($("#admin-apply-cards"), () => {
    send({ type: "admin_set_forced_cards", assignments: window.__adminForcedAssignments || {} });
  });
  wireButton($("#admin-clear-cards"), () => {
    window.__adminForcedAssignments = {};
    send({ type: "admin_clear_forced_cards" });

  // Reactions
  document.querySelectorAll(".reaction-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const emoji = btn.dataset.emoji;
      if (emoji) send({ type: "reaction", emoji, targetId: myId });
    });
  });
  // History
  wireButton($("#btn-history-open"), () => {
    if (!currentRoom) {
      const list = $("#history-list");
      if (list) list.innerHTML = '<div class="admin-empty">Join a table to see hand history.</div>';
      $("#history-overlay")?.classList.add("open");
      return;
    }
    send({ type: "hand_history" });
  });
  wireButton($("#btn-history-close"), () => $("#history-overlay")?.classList.remove("open"));
  // Admin announce
  wireButton($("#admin-announce-send"), () => {
    const t = ($("#admin-announce-text")?.value || "").trim();
    if (t && isAdmin) send({ type: "admin_announce", text: t });
  });
  // Spectator bet
  wireButton($("#btn-spec-bet"), () => {
    const targetId = $("#spec-bet-target")?.value;
    const amount = Number($("#spec-bet-amount")?.value);
    if (targetId && amount >= 10) send({ type: "spectator_bet", targetId, amount });
  });
  // Auto-rebuy settings
  const arToggle = $("#toggle-auto-rebuy");
  const arSlider = $("#slider-auto-rebuy");
  const arLabel = $("#auto-rebuy-amt-label");
  function syncAutoRebuyUI() {
    if (!myProfile) return;
    arToggle?.classList.toggle("on", !!myProfile.autoRebuy);
    if (arSlider) arSlider.value = String(myProfile.autoRebuyAmount || 1000);
    if (arLabel) arLabel.textContent = "$" + Number(myProfile.autoRebuyAmount || 1000).toLocaleString();
  }
  arToggle?.addEventListener("click", () => {
    const on = !arToggle.classList.contains("on");
    arToggle.classList.toggle("on", on);
    const amount = Number(arSlider?.value || 1000);
    send({ type: "set_auto_rebuy", token: authToken, enabled: on, amount });
  });
  arSlider?.addEventListener("input", () => {
    if (arLabel) arLabel.textContent = "$" + Number(arSlider.value).toLocaleString();
  });
  arSlider?.addEventListener("change", () => {
    const on = arToggle?.classList.contains("on");
    send({ type: "set_auto_rebuy", token: authToken, enabled: !!on, amount: Number(arSlider.value) });
  });
  // expose for profile updates
  window.__syncAutoRebuyUI = syncAutoRebuyUI;


    const label = $("#admin-card-assigned");
    if (label) label.textContent = "Cleared.";
  });


  // Fun admin table modifiers
  const funAdmin = (action) => () => { if (isAdmin) send({ type: "admin_fun", action }); };
  wireButton($("#admin-fun-double"), funAdmin("double_cash"));
  wireButton($("#admin-fun-rain"), funAdmin("rain_money"));
  wireButton($("#admin-fun-xp"), funAdmin("season_xp"));
  wireButton($("#admin-fun-refill"), funAdmin("refill_shoe"));
  wireButton($("#admin-fun-chaos"), funAdmin("chaos_bets"));
  wireButton($("#admin-fun-force0"), funAdmin("force_zero"));
  wireButton($("#admin-fun-force-red"), funAdmin("bias_red"));
  wireButton($("#admin-fun-clear-luck"), funAdmin("clear_luck"));

  wireButton($("#btn-profile"), () => { openProgress("#profile-overlay"); renderProfile(); send({type:"profile", token:authToken}); });
  wireButton($("#btn-profile-close"), () => closeProgress("#profile-overlay"));

  function setProfileMsg(err, ok) {
    const e = $("#profile-account-error");
    const o = $("#profile-account-ok");
    if (e) e.textContent = err || "";
    if (o) { o.textContent = ok || ""; o.classList.toggle("hidden", !ok); }
  }
  wireButton($("#btn-change-password"), () => {
    setProfileMsg("", "");
    const cur = $("#profile-cur-password")?.value || "";
    const neu = $("#profile-new-password")?.value || "";
    if (!cur || !neu) { setProfileMsg("Enter current and new password."); return; }
    send({ type: "change_password", token: authToken, currentPassword: cur, newPassword: neu });
  });
  wireButton($("#btn-change-username"), () => {
    setProfileMsg("", "");
    const name = ($("#profile-new-username")?.value || "").trim();
    const pw = $("#profile-user-password")?.value || "";
    if (!name || !pw) { setProfileMsg("Enter new username and password."); return; }
    send({ type: "change_username", token: authToken, newUsername: name, password: pw });
  });
  wireButton($("#btn-delete-account"), () => {
    setProfileMsg("", "");
    const pw = $("#profile-delete-password")?.value || "";
    if (!pw) { setProfileMsg("Enter your password to delete."); return; }
    if (!confirm("Delete your account permanently? This cannot be undone.")) return;
    send({ type: "delete_account", token: authToken, password: pw });
  });

  wireButton($("#btn-friends"), () => { openProgress("#friends-overlay"); $("#friends-error").textContent=""; send({type:"friends",token:authToken}); });
  wireButton($("#btn-friends-close"), () => closeProgress("#friends-overlay"));
  wireButton($("#btn-add-friend"), () => { $("#friends-error").textContent=""; send({type:"add_friend",token:authToken,username:$("#friend-username").value.trim()}); });
  wireButton($("#btn-create-public"), () => {
    const maxPlayers = parseInt($("#bj-max-players")?.value || "5", 10) || 5;
    const pin = ($("#bj-table-pin")?.value || "").trim();
    if (pin && !/^\d{4}$/.test(pin)) { const e=$("#room-error"); if(e) e.textContent="PIN must be 4 digits."; return; }
    send({type:"create_public", token:authToken, game:"blackjack", maxPlayers, pin: pin || undefined});
  });
  wireButton($("#btn-poker-create"), () => {
    const err = $("#poker-room-error");
    if (err) err.textContent = "";
    if (!authToken) { if (err) err.textContent = "Please log in first."; return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) { if (err) err.textContent = "Not connected. Reconnecting…"; connect(); return; }
    const maxPlayers = parseInt($("#poker-max-players")?.value || "6", 10) || 6;
    const pin = ($("#poker-table-pin")?.value || "").trim();
    const buyIn = parseInt($("#poker-create-buyin")?.value || "1000", 10) || 1000;
    if (pin && !/^\d{4}$/.test(pin)) { if (err) err.textContent = "PIN must be 4 digits."; return; }
    if (err) err.textContent = "Creating table…";
    send({type:"create_public", token:authToken, game:"poker", maxPlayers, pin: pin || undefined, buyIn});
  });
  wireButton($("#btn-poker-spectate"),()=>{const room=($("#poker-join-code")||$("#poker-room-input")||$("#input-poker-room"))?.value?.trim();if(!room){const el=$("#poker-lobby-error");if(el)el.textContent="Enter a code to spectate.";return;}send({type:"join",token:authToken,room,game:"poker",spectate:true});});
  wireButton($("#btn-poker-join"),()=>{
    const err = $("#poker-room-error");
    if (err) err.textContent = "";
    const room = ($("#poker-room")?.value || "").trim();
    if (!room) { if (err) err.textContent = "Enter a private table code, or use CREATE TABLE."; return; }
    if (!authToken) { if (err) err.textContent = "Please log in first."; return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) { if (err) err.textContent = "Not connected. Reconnecting…"; connect(); return; }
    const pin = ($("#poker-join-pin")?.value || $("#poker-table-pin")?.value || "").trim();
    $("#poker-join-pin-wrap")?.classList.remove("hidden");
    if (err) err.textContent = "Joining…";
    send({type:"join", token:authToken, room, game:"poker", pin: pin || undefined});
  });
  wireButton($("#btn-poker-back"), () => { const err=$("#poker-room-error"); if(err) err.textContent=""; showMainMenu(); });
  wireButton($("#btn-sit-down"), () => send({ type: "sit_down", token: authToken }));
  wireButton($("#btn-poker-sit-down"), () => send({ type: "sit_down", token: authToken }));
  wireButton($("#btn-poker-leave"), () => {
    send({ type: "leave_table" });
    if (myBalance) setMenuBalance(myBalance);
    else if (myProfile?.balance != null) setMenuBalance(myProfile.balance);
    if (authToken) send({ type: "profile", token: authToken });
    clearTableClientState();
    showMainMenu();
    setTimeout(() => {
      if ($("#screen-poker")?.classList.contains("active")) {
        clearTableClientState();
        showMainMenu();
        $("#host-overlay")?.classList.remove("open");
        $("#settings-overlay")?.classList.remove("open");
      }
    }, 800);
  });
  wireButton($("#poker-settings"), () => { $("#btn-leave-table").classList.remove("hidden"); $("#settings-overlay").classList.add("open"); });
  wireButton($("#poker-fold"), () => send({type:"poker_action", action:"fold"}));
  wireButton($("#poker-check"), () => send({type:"poker_action", action:"check"}));
  wireButton($("#poker-call"), () => send({type:"poker_action", action:"call"}));
  wireButton($("#poker-allin"), () => send({type:"poker_action", action:"allin"}));
  wireButton($("#poker-bet"), () => {
    $("#poker-bet-row")?.classList.remove("hidden");
    const minR = Number(pokerState?.minRaise||50);
    const inp = $("#poker-bet-amount");
    if(inp){ inp.value = minR; inp.min = minR; }
    window._pokerActMode = "bet";
  });
  wireButton($("#poker-raise"), () => {
    $("#poker-bet-row")?.classList.remove("hidden");
    const cur = Number(pokerState?.currentBet||0);
    const minR = Number(pokerState?.minRaise||50);
    const inp = $("#poker-bet-amount");
    if(inp){ inp.value = cur + minR; inp.min = cur + minR; }
    window._pokerActMode = "raise";
  });
  wireButton($("#poker-bet-confirm"), () => {
    const amt = parseInt($("#poker-bet-amount")?.value||"0",10)||0;
    const mode = window._pokerActMode || "bet";
    send({type:"poker_action", action: mode, amount: amt});
    $("#poker-bet-row")?.classList.add("hidden");
  });
  wireButton($("#poker-bet-cancel"), () => $("#poker-bet-row")?.classList.add("hidden"));
  wireButton($("#btn-poker-start-hand"), () => {
    const msgEl = $("#poker-table-msg");
    if (msgEl) { msgEl.className = "poker-table-msg"; msgEl.textContent = "Starting hand…"; }
    if (!send({type:"poker_start"})) {
      if (msgEl) { msgEl.className = "poker-table-msg error"; msgEl.textContent = "Not connected."; }
    }
  });
  wireButton($("#btn-poker-cashout"), () => send({type:"poker_cashout"}));
  wireButton($("#btn-chat-open"), () => toggleChat(true));
  wireButton($("#btn-chat-toggle"), () => toggleChat(false));
  wireButton($("#btn-chat-mute"), () => { chatMuted=!chatMuted; localStorage.setItem('bj_chat_muted',chatMuted?'1':'0'); $("#btn-chat-mute").textContent=chatMuted?'🔇':'🔊'; });
  wireButton($("#btn-chat-send"), () => sendChat());
  wireButton($("#btn-chat-emoji"), () => {
    populateEmojiBar();
    $("#chat-emoji-bar")?.classList.toggle("hidden");
  });
  $("#chat-input")?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  wireButton($("#poker-help"), () => {
    openProgress("#help-poker-overlay");
    try { localStorage.setItem("cx_help_poker_seen", "1"); } catch(e) {}
    $("#poker-help")?.classList.remove("help-glow");
  });
  wireButton($("#btn-help-poker-close"), () => {
    closeProgress("#help-poker-overlay");
    try { localStorage.setItem("cx_help_poker_seen", "1"); } catch(e) {}
    $("#poker-help")?.classList.remove("help-glow");
  });
  wireButton($("#bj-help"), () => {
    openProgress("#help-bj-overlay");
    try { localStorage.setItem("cx_help_bj_seen", "1"); } catch(e) {}
    $("#bj-help")?.classList.remove("help-glow");
  });
  wireButton($("#btn-help-bj-close"), () => {
    closeProgress("#help-bj-overlay");
    try { localStorage.setItem("cx_help_bj_seen", "1"); } catch(e) {}
    $("#bj-help")?.classList.remove("help-glow");
  });

  wireButton($("#btn-stats"), () => { renderStats(); openProgress("#stats-overlay"); send({type:"profile", token:authToken}); });
  wireButton($("#btn-rankings"), () => { openProgress("#leaderboard-overlay"); send({type:"leaderboard_playtime",token:authToken}); send({type:"leaderboard",token:authToken}); send({type:"leaderboard"}); });
  wireButton($("#btn-achievements"), () => { openProgress("#achievements-overlay"); send({type:"achievements", token:authToken}); });
  wireButton($("#btn-daily"), () => { openProgress("#daily-overlay"); send({type:"daily", token:authToken}); });
  wireButton($("#btn-daily-home"), () => { openProgress("#daily-overlay"); send({type:"daily", token:authToken}); });
  wireButton($("#btn-store"), () => { openProgress("#store-overlay"); send({type:"store", token:authToken}); });
  wireButton($("#btn-season"), () => {
    openProgress("#season-overlay");
    renderSeason();
    send({type:"season", token:authToken});
  });
  wireButton($("#btn-stats-close"), () => closeProgress("#stats-overlay"));
  wireButton($("#btn-rankings-close"), () => closeProgress("#leaderboard-overlay"));
  wireButton($("#btn-achievements-close"), () => closeProgress("#achievements-overlay"));
  wireButton($("#btn-daily-close"), () => closeProgress("#daily-overlay"));
  wireButton($("#btn-store-close"), () => closeProgress("#store-overlay"));
  wireButton($("#store-purchase-cancel"), () => closeStorePurchase());
  wireButton($("#store-purchase-buy"), () => { if(pendingStorePurchase && !$("#store-purchase-buy").disabled){ const x=pendingStorePurchase; closeStorePurchase(); send({type:"buy_cosmetic",token:authToken,category:x.category,id:x.id}); } });
  wireButton($("#store-hero-browse"),()=>{window.storeTab="all";window.storeOwnedOnly=false;renderStore();});
  $("#store-purchase-overlay")?.addEventListener("click",e=>{if(e.target===$("#store-purchase-overlay"))closeStorePurchase();});
  window.storeTab = "all";
  window.storeOwnedOnly = false;
  document.querySelectorAll(".store-tab").forEach(btn => wireButton(btn, () => {
    window.storeTab = btn.dataset.storeTab || "all";
    renderStore();
  }));
  wireButton($("#store-owned-toggle"), () => {
    window.storeOwnedOnly = !window.storeOwnedOnly;
    renderStore();
  });
  wireButton($("#btn-season-close"), () => closeProgress("#season-overlay"));
  document.querySelectorAll(".rank-tab").forEach(btn => btn.addEventListener("click", () => {
    activeRank = btn.dataset.rank;
    document.querySelectorAll(".rank-tab").forEach(x => x.classList.toggle("active", x === btn));
    renderLeaderboard();
  }));
}

initSettings();
initControls();
initJoin();
startSeasonTicker();
$("#btn-chat-mute").textContent = chatMuted ? "🔇" : "🔊";
if (localStorage.getItem("bj_session_token")) { setTimeout(() => { if (!ws || ws.readyState === WebSocket.CLOSED) connect(); }, 50); }

// Keep presence fresh while logged in
setInterval(() => {
  if (authToken) {
    try { send({ type: "presence", token: authToken }); } catch (e) {}
  }
}, 20000);
