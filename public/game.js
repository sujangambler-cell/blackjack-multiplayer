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
const UPDATE_LOG_VERSION = 3;
const UPDATE_LOG_ENTRIES = [
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
      if (msg.game === "poker") { pokerTables = msg.tables || []; renderPokerTables(); }
      else { publicTables = msg.tables || []; renderPublicTables(); }
      return;
    }
    if (msg.type === "public_created") {
      if (msg.game === "poker") {
        const inp = $("#poker-room");
        if (inp) { inp.value = msg.code; inp.dataset.keep = "1"; }
        const err = $("#poker-room-error");
        if (err) err.textContent = "";
        send({type:"join", token:authToken, room:msg.code, game:"poker"});
      } else {
        $("#input-room").value = msg.code;
        send({type:"join", token:authToken, room:msg.code, game:"blackjack"});
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
        send({type:"poker_state"});
      } else {
        setChipAvatar($("#table-profile-avatar"), {username: msg.username || loggedUsername, avatar: myProfile?.avatar, avatarColor: myProfile?.avatarColor});
        showScreen("#screen-table");
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
      renderDaily(false, msg.profile.dailyChallenges ? buildChallengeObjects(msg.profile.dailyChallenges) : []);
      return;
    }
    if (msg.type === "store") {
      storeData = msg.store || null;
      renderStore();
      if (msg.store && myProfile) {
        myProfile.cosmetics = myProfile.cosmetics || {};
        myProfile.cosmetics.theme = msg.store.themes.find(x => x.equipped)?.id || myProfile.cosmetics.theme || "classic";
        myProfile.cosmetics.chip = msg.store.chips.find(x => x.equipped)?.id || myProfile.cosmetics.chip || "classic";
        myProfile.cosmetics.deck = msg.store.decks?.find(x => x.equipped)?.id || myProfile.cosmetics.deck || "classic";
        myProfile.cosmetics.table = msg.store.tables?.find(x => x.equipped)?.id || myProfile.cosmetics.table || "classic";
        myProfile.cosmetics.ball = msg.store.balls?.find(x => x.equipped)?.id || myProfile.cosmetics.ball || "classic";
        applyCosmeticTheme(myProfile.cosmetics.theme);
        applyGameCosmetics(myProfile.cosmetics);
      }
      if (msg.purchased) { play("win"); centerBanner("ITEM UNLOCKED", "win"); }
      if (msg.equipped) {
        play("chip");
        centerBanner("EQUIPPED", "win");
        // Re-apply from profile payload path as well
        if (myProfile?.cosmetics) {
          applyCosmeticTheme(myProfile.cosmetics.theme);
          applyGameCosmetics(myProfile.cosmetics);
        }
      }
      renderAppearance();
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
    if (msg.type === "admin_ok") {
      isAdmin = true;
      $("#admin-login-box").classList.add("hidden");
      $("#admin-dashboard").classList.remove("hidden");
      $("#btn-admin-float").classList.remove("hidden"); $("#btn-admin-table").classList.remove("hidden"); $("#poker-admin").classList.remove("hidden");
      return;
    }
    if (msg.type === "admin_data") {
      renderAdminUsers(msg.users || [], msg.tablePlayers || [], msg.dealerPreviewActive, msg.dealerPreview, msg.tableLuck);
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
  // Discord-style: evenly spaced along lower inner arc of the oval
  for (let i = 0; i < maxP; i++) {
    const t = maxP === 1 ? 0.5 : i / (maxP - 1); // 0..1 left → right
    // Wide bottom arc inside the rail — extra vertical air so seats aren't squashed
    const x = 14 + t * 72;
    const y = 66 + Math.sin(t * Math.PI) * 8;
    const p = seated[i];
    const seat = el("div", "seat-slot" + (p ? (p.id === myId ? " me" : "") : " empty") + (p && state.activePlayerId === p.id ? " active-turn" : ""));
    seat.style.left = x + "%";
    seat.style.top = y + "%";

    if (p) {
      // Identity first (like Discord), cards above when dealt
      const handDiv = el("div", "seat-hand");
      (p.hand || []).forEach((c) => handDiv.appendChild(buildCard(c, true)));
      if ((p.hand || []).length) seat.appendChild(handDiv);
      if (p.display) seat.appendChild(el("div", "seat-value", p.display));
      if (p.bet > 0) seat.appendChild(el("div", "seat-bet", "Bet $" + p.bet));
      const identity = el("div", "seat-identity");
      identity.innerHTML = avatarHTML(p);
      identity.appendChild(el("div", "seat-name", p.name + (p.id === myId ? " (you)" : "")));
      identity.appendChild(el("div", "seat-money", "$" + Number(p.money).toLocaleString()));
      seat.appendChild(identity);
      if (p.result) {
        const label = { win: "WIN", lose: "LOSE", push: "PUSH", bust: "BUST", blackjack: "BLACKJACK" }[p.result] || "";
        const statusClass = p.result === "blackjack" ? "blackjack" : p.result;
        seat.appendChild(el("div", "seat-status " + statusClass, label));
      }
    } else {
      // Empty seat: dashed + with OPEN under it
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
  renderHostList();
  $("#host-overlay")?.classList.add("open");
}

function renderAdminUsers(users, tablePlayers = [], previewActive = false, preview = null, tableLuck = null) {
  const box = $("#admin-users");
  if (!box) return;
  box.innerHTML = "";
  if (!tablePlayers.length) {
    box.appendChild(el("div", "admin-empty", "No players currently at this table."));
  }
  tablePlayers.forEach((u) => {
    const row = el("div", "admin-user");
    const info = el("div", null, `${u.username} • $${Number(u.money).toLocaleString()}`);
    const actions = el("div", "admin-user-actions");
    const input = document.createElement("input");
    input.type = "number"; input.min = "1"; input.max = "1000000"; input.placeholder = "Chips";
    const add = el("button", "btn secondary", "GIVE");
    add.addEventListener("click", () => {
      const n = Number(input.value);
      if (Number.isInteger(n) && n > 0 && n <= 1000000) send({type:"admin_give_table_money",targetId:u.id,amount:n});
    });
    const luck = document.createElement("input");
    luck.type="number"; luck.min="0"; luck.max="100"; luck.value=String(u.luckStrength||0); luck.title="Player luck 0–100";
    const luckBtn = el("button", "btn secondary", "SET LUCK");
    luckBtn.addEventListener("click", () => {
      const n=Number(luck.value);
      if (Number.isInteger(n) && n>=0 && n<=100) send({type:"admin_set_poker_luck",targetId:u.id,strength:n});
    });
    actions.append(input, add, luck, luckBtn);
    row.append(info, actions); box.appendChild(row);
  });
  $("#admin-preview-toggle").classList.toggle("on", !!previewActive);
  const pv=$("#admin-preview"); pv.innerHTML="";
  if(previewActive && preview){
    pv.appendChild(el("div","admin-section-title","DEALER PREVIEW"));
    const hand=el("div","admin-preview-cards"); preview.forEach(c=>hand.appendChild(buildCard(c))); pv.appendChild(hand);
  }

  const season = $("#admin-season-controls");
  const items = $("#admin-item-controls");
  if (!season || !items) return;
  season.innerHTML = ""; items.innerHTML = "";
  const luckSection=el("div","admin-table-luck");
  luckSection.innerHTML=`<div class="admin-control-row"><strong>TABLE LUCK ${tableLuck?.active?"• ACTIVE":"• OFF"}</strong><input class="admin-number" id="admin-table-luck-strength" type="number" min="0" max="100" value="${Number(tableLuck?.strength||0)}" placeholder="0–100"><button class="btn secondary" id="admin-table-luck-set">SET 5 MIN</button></div>`;
  $("#admin-users").prepend(luckSection);
  $("#admin-table-luck-set").addEventListener("click",()=>{const n=Number($("#admin-table-luck-strength").value);if(Number.isInteger(n)&&n>=0&&n<=100)send({type:"admin_set_table_luck",strength:n,duration:300});});
  tablePlayers.forEach(u => {
    const xpRow=el("div","admin-control-row");
    xpRow.innerHTML=`<strong>${escapeHtml(u.username)}</strong><input class="admin-number" type="number" min="1" max="1000000" placeholder="XP"><button class="btn secondary">GIVE XP</button>`;
    xpRow.querySelector("button").addEventListener("click",()=>{const n=Number(xpRow.querySelector("input").value);if(Number.isInteger(n)&&n>0&&n<=1000000)send({type:"admin_give_season_xp",targetId:u.id,amount:n});});
    season.appendChild(xpRow);
    const rewardRow=el("div","admin-control-row");
    rewardRow.innerHTML=`<strong>Reward</strong><select class="admin-select">${Array.from({length:10},(_,i)=>`<option value="${i+1}">TIER ${i+1}</option>`).join("")}</select><button class="btn secondary">GIVE REWARD</button>`;
    rewardRow.querySelector("button").addEventListener("click",()=>send({type:"admin_claim_season_reward",targetId:u.id,tier:Number(rewardRow.querySelector("select").value)}));
    season.appendChild(rewardRow);

    const itemRow=el("div","admin-control-row");
    itemRow.innerHTML=`<strong>${escapeHtml(u.username)}</strong><select class="admin-select"><option value="admin_star">ADMIN STAR THEME</option><option value="admin_chip">ADMIN CHIP</option></select><button class="btn secondary">GIVE ITEM</button>`;
    itemRow.querySelector("button").addEventListener("click",()=>send({type:"admin_give_item",targetId:u.id,itemId:itemRow.querySelector("select").value}));
    items.appendChild(itemRow);
  });
  if (!tablePlayers.length) {
    season.appendChild(el("div","admin-empty","No players available."));
    items.appendChild(el("div","admin-empty","No players available."));
  }
}

// ---------------------------------------------------------------------------
// Progression UI — stats, rankings, achievements, daily rewards/challenges
// ---------------------------------------------------------------------------

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
  $("#daily-reward-box").innerHTML = claimed ? '<strong>✓ CLAIMED</strong><span>Come back tomorrow for +250 chips.</span>' : '<strong>+250 CHIPS</strong><span>Daily free reward</span><button class="btn" id="btn-claim-daily">CLAIM REWARD</button>';
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
function previewCosmetic(cat,id){const maps={theme:{classic:"#1c1f23,#050506",midnight:"#24516e,#06101a",emerald:"#0d3d28,#06140e",royal:"#6a326c,#160916",neon:"#16877f,#060f12",crimson:"#8b1e2d,#1a0508",golden:"#d7b56d,#3c2413",celestial:"#66cfff,#030711",casino1927:"#d7b56d,#183b2a",crimson_royale:"#8b1e2d,#12060a",admin_star:"#f472b6,#1a0510",admin_blackout:"#222,#000",founder:"#d4af37,#1a1005"},chip:{classic:"#17191d,#050506",silver:"#bfc8d0,#343b44",emerald_chip:"#2f6d4b,#0c281b",gold:"#e5c56d,#6c4c13",diamond:"#1a1a1a,#444",royal_vault:"#d4af37,#1a1008",casino1927:"#d7b56d,#3c2413",crimson_velvet:"#8b1e2d,#f3ede2",admin_chip:"#f472b6,#1a0510"},deck:{classic:"#f7f0df,#2b2a29",midnight:"#252a35,#050609",emerald_deck:"#0d3d28,#c8e6c9",crimson_deck:"#8b1e2d,#f3ede2",celestial_deck:"#0a1628,#66cfff",casino1927:"#d7b56d,#173d2a",crimson_royale_deck:"#8b1e2d,#f3ede2"},table:{classic:"#2f6d4b,#0c281b",royal:"#496c35,#1c2b16",casino1927:"#6d5130,#123a28",crimson_table:"#8b1e2d,#f3ede2"},ball:{classic:"#f4f4f4,#777",brass1927:"#f1d28a,#8f5c1a",crimson_back:"#8b1e2d,#d4b87a"}};return (maps[cat]&&maps[cat][id])||maps[cat]?.classic||"#17191d,#050506";}
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
function renderStore(){
  if(!storeData) return;
  const catalog = [
    ...(storeData.themes||[]).map(x=>({...x,category:"theme",categoryLabel:"THEME"})),
    ...(storeData.chips||[]).map(x=>({...x,category:"chip",categoryLabel:"CHIPS"})),
    ...(storeData.decks||[]).map(x=>({...x,category:"deck",categoryLabel:"BLACKJACK"})),
    ...(storeData.tables||[]).map(x=>({...x,category:"table",categoryLabel:"TABLE"})),
    ...(storeData.balls||[]).map(x=>({...x,category:"ball",categoryLabel:"CARD BACKS"}))
  ];
  $("#store-balance").textContent="$"+Number(storeData.balance||0).toLocaleString();
  const activeTab = window.storeTab || "all";
  const ownedOnly = !!window.storeOwnedOnly;
  document.querySelectorAll(".store-tab").forEach(b=>b.classList.toggle("active",b.dataset.storeTab===activeTab));
  const forceOwned = activeTab==="inventory" || ownedOnly; const visible = catalog.filter(x=>(activeTab==="all"||activeTab==="inventory"||x.category===activeTab) && (!forceOwned||x.owned));
  $("#store-results-title").textContent = activeTab==="all" ? "HOUSE COLLECTION" : ({theme:"THEMES",chip:"CASINO CHIPS",deck:"BLACKJACK DECKS",table:"TABLE SKINS",ball:"CARD BACKS"}[activeTab]||"COLLECTION");
  $("#store-results-count").textContent = visible.length+" ITEM"+(visible.length===1?"":"S");
  $("#store-owned-toggle").classList.toggle("active",ownedOnly);
  $("#store-owned-toggle").setAttribute("aria-pressed",String(ownedOnly));
  const catalogEl=$("#store-catalog"), empty=$("#store-empty");
  empty.classList.toggle("hidden",visible.length!==0);
  catalogEl.innerHTML=visible.map(x=>{
    const colors=previewCosmetic(x.category,x.id).split(",");
    const state=x.equipped?"EQUIPPED":x.owned?"OWNED":x.limited?"SEASONAL REWARD":"AVAILABLE";
    let action="";
    if(x.equipped) action='<button class="store-action secondary" disabled>✓ EQUIPPED</button>';
    else if(x.owned) action=`<button class="store-action" data-store-equip="${escapeAttr(x.category)}" data-id="${escapeAttr(x.id)}">EQUIP</button>`;
    else if(x.limited) action='<button class="store-action seasonal" disabled>CLAIM IN SEASON</button>';
    else action=`<button class="store-action" data-store-buy="${escapeAttr(x.category)}" data-id="${escapeAttr(x.id)}">BUY <span>$${Number(x.price||0).toLocaleString()}</span></button>`;
    const rarity=x.rarity||"COMMON"; return `<article class="store-product rarity-border-${rarity} ${x.equipped?"is-equipped":""} ${x.owned?"is-owned":""} ${x.limited?"is-seasonal":""}">
      <div class="store-product-art" style="--preview-a:${colors[0]};--preview-b:${colors[1]}">
        <span class="store-item-rarity rarity-${rarity}">${rarity}</span><span class="store-product-category">${escapeHtml(x.categoryLabel)}</span>
        <div class="store-product-mark">${escapeHtml(x.category==="chip"?"✦":x.category==="ball"?"●":x.category==="deck"?"♠":x.category==="table"?"▰":"✥")}</div>
        ${x.limited?`<span class="store-season-ribbon">SEASON ${x.season||2}</span>`:""}
      </div>
      <div class="store-product-copy">
        <div class="store-product-top"><span>${escapeHtml(state)}</span><span>${x.price?("$"+Number(x.price).toLocaleString()):"FREE"}</span></div>
        <h3>${escapeHtml(x.name)}</h3>
        <p>${x.limited?"Limited Season 1 reward • permanent once claimed.":x.owned?"Already in your permanent collection.":"Permanent item • available anytime."}</p>
      </div>
      ${action}
    </article>`;
  }).join("");
  document.querySelectorAll("[data-store-buy]").forEach(b=>wireButton(b,()=>{
    b.disabled=true; b.classList.add("loading");
    send({type:"buy_cosmetic",token:authToken,category:b.dataset.storeBuy,id:b.dataset.id});
  }));
  document.querySelectorAll("[data-store-equip]").forEach(b=>wireButton(b,()=>{
    b.disabled=true; b.classList.add("loading");
    send({type:"equip_cosmetic",token:authToken,category:b.dataset.storeEquip,id:b.dataset.id});
  }));
  applyCosmeticTheme(myProfile?.cosmetics?.theme||"classic");
  applyGameCosmetics(myProfile?.cosmetics||{});
  renderAppearance();
}
function formatCountdown(sec){let s=Math.max(0,Math.floor(Number(sec||0))),d=Math.floor(s/86400);s%=86400;let h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);return `${d}D ${String(h).padStart(2,"0")}H ${String(m).padStart(2,"0")}M`;}
function renderSeason(){if(!seasonData)return;const xp=Number(seasonData.xp||0),tiers=seasonData.tiers||[],meta=seasonData.season||{};$("#season-xp").textContent=xp.toLocaleString()+" XP";$("#season-countdown").textContent=meta.active===false?"SEASON ENDED":formatCountdown(meta.remainingSeconds);$("#season-season-status").textContent=meta.active===false?"ACQUISITION CLOSED":"ACTIVE";applySeasonTheme();const max=Number(tiers.at(-1)?.xp||1);$("#season-progress-fill").style.width=Math.min(100,Math.round(xp/max*100))+"%";$("#season-tier-list").innerHTML=tiers.map(t=>{const r=t.reward||{},type=(r.type||"reward").toUpperCase(),state=t.claimed?"CLAIMED":t.unlocked?"AVAILABLE":"LOCKED",button=t.claimed?'<button class="btn secondary" disabled>CLAIMED</button>':t.unlocked?`<button class="btn" data-season-claim="${t.tier}">CLAIM</button>`:'<button class="btn secondary" disabled>LOCKED</button>',limited=(r.id&&(String(r.id).includes("1927")||String(r.id).includes("crimson")))||["deck","table","ball","theme","chip","title"].includes(r.type)?'<span class="limited-badge">SEASONAL • PERMANENT ON CLAIM</span>':"";return `<div class="season-tier ${t.unlocked?"unlocked":""} ${t.claimed?"claimed":""}"><div class="season-tier-num">${t.tier}</div><div class="season-reward-copy"><strong>${escapeHtml(r.name||"REWARD")}</strong><small>${type} • ${Number(t.xp).toLocaleString()} XP</small>${limited}</div><div class="season-state">${state}</div>${button}</div>`}).join("");document.querySelectorAll("[data-season-claim]").forEach(b=>wireButton(b,()=>send({type:"claim_season",token:authToken,tier:Number(b.dataset.seasonClaim)})));}
function openProgress(id) { $(id).classList.add("open"); }
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
  const p = myProfile;
  if (!p) return;
  $("#profile-hero").innerHTML = `<div><strong>${escapeHtml(p.username)}</strong><span>LEVEL ${p.level} • ${escapeHtml(p.levelTitle)}</span></div><b>$${Number(p.balance||0).toLocaleString()}</b>`;
  const st = p.stats || {};
  const vals = [["CASINO GAMES",st.gamesPlayed],["CASINO WINS",st.wins],["LOSSES",st.losses],["BLACKJACKS",st.blackjacks],["POKER GAMES",st.pokerGames||0],["POKER WINS",st.pokerWins||0],["WIN RATE",(st.winRate||0)+"%"],["BIGGEST WIN","$"+Number(st.biggestWin||0).toLocaleString()]];
  $("#profile-stats-grid").innerHTML = vals.map(([a,b])=>`<div class="stat-box"><span>${a}</span><strong>${b}</strong></div>`).join("");
  renderProfileFriends();
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
  box.innerHTML = publicTables.length ? publicTables.map(t=>{
    const bots = Number(t.bots||0);
    const specs = Number(t.spectators||0);
    const extra = [bots ? `${bots} bot${bots===1?"":"s"}` : null, specs ? `${specs} spectator${specs===1?"":"s"}` : null].filter(Boolean).join(" · ");
    return `<div class="public-table-row"><div><strong>${escapeHtml((t.game||"BLACKJACK").toUpperCase())} • TABLE ${escapeHtml(t.code)}</strong><small>Host: ${escapeHtml(t.host)} · ${t.players}/${t.maxPlayers} players · ${t.phase === 'PLAYING' ? 'IN GAME' : 'WAITING'}${extra ? " · " + extra : ""}</small></div><div class="public-table-actions">${t.canJoin?`<button class="btn" data-join="${t.code}">JOIN</button>`:''}${t.canSpectate?`<button class="btn secondary" data-spec="${t.code}">WATCH</button>`:''}</div></div>`;
  }).join("") : '<div class="admin-empty">No public tables yet. Create one!</div>';
  box.querySelectorAll('[data-join]').forEach(b=>wireButton(b,()=>send({type:'join',token:authToken,room:b.dataset.join})));
  box.querySelectorAll('[data-spec]').forEach(b=>wireButton(b,()=>send({type:'join',token:authToken,room:b.dataset.spec,spectate:true})));
}

function renderPokerTables(){
  const box=$("#poker-table-list"); if(!box) return;
  const tables=pokerTables.filter(t=>t.game==="poker");
  box.innerHTML=tables.length ? tables.map(t=>{
    const bots = Number(t.bots||0);
    const specs = Number(t.spectators||0);
    const extra = [bots ? `${bots} bot${bots===1?"":"s"}` : null, specs ? `${specs} spectator${specs===1?"":"s"}` : null].filter(Boolean).join(" · ");
    return `<div class="public-table-row"><div><strong>POKER • TABLE ${escapeHtml(t.code)}</strong><small>Host: ${escapeHtml(t.host||"—")} · ${t.players}/${t.maxPlayers} seated · Buy-in $${Number(t.buyIn||1000).toLocaleString()} · ${escapeHtml(t.phase||"WAITING")}${extra ? " · " + extra : ""}</small></div><div class="public-table-actions">${t.canJoin!==false?`<button class="btn" data-rjoin="${t.code}">JOIN</button>`:''}<button class="btn secondary" data-rspec="${t.code}">WATCH</button></div></div>`;
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
  if(!c || c.faceUp===false) return `<div class="playing-card card-back ${small?"small":""}"></div>`;
  const red = c.suit==="H"||c.suit==="D";
  const suitSym = {S:"♠",H:"♥",D:"♦",C:"♣"}[c.suit]||c.suit;
  const hl = highlight ? " poker-card-hl" : "";
  return `<div class="playing-card ${red?"red":"black"} ${small?"small":""}${hl}"><span class="card-rank">${c.rank}</span><span class="card-suit">${suitSym}</span></div>`;
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
  $("#poker-balance") && ($("#poker-balance").textContent = "$" + Number(me?.money ?? myBalance ?? 0).toLocaleString());
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
          (p && p.status === "folded" ? " folded" : "")
      );
      seat.style.setProperty("left", x + "%", "important");
      seat.style.setProperty("top", y + "%", "important");

      if (p) {
        const badges = [];
        if (p.isDealer) badges.push('<span class="poker-badge dealer">D</span>');
        if (p.isSB) badges.push('<span class="poker-badge sb">SB</span>');
        if (p.isBB) badges.push('<span class="poker-badge bb">BB</span>');
        const isMe = p.id === myId;
        // Opponents: always show 2 card-backs during an active hand (unless folded).
        // Self: large hole cards live in #poker-hole — seat only shows avatar/name/chips.
        let holeHtml = "";
        if (!isMe) {
          const phaseActive = ["PREFLOP","FLOP","TURN","RIVER","SHOWDOWN"].includes(state.phase);
          const folded = p.status === "folded";
          if (phaseActive && !folded) {
            const backs = (p.hole && p.hole.length >= 2)
              ? p.hole
              : [{ faceUp: false }, { faceUp: false }];
            holeHtml = backs.map(c => pokerCardHTML(c, true)).join("");
          } else if (p.hole && p.hole.length && !folded) {
            holeHtml = p.hole.map(c => pokerCardHTML(c, true)).join("");
          }
        }
        const actionBadge = p.isTurn ? '<div class="poker-action-badge">ACTION</div>' : "";
        // Hand label for ME is shown under hole cards (#poker-hole-hand) to avoid overlapping the board.
        // Opponents still show hand name on their seat at showdown.
        const handLabel = (!isMe && p.handName) ? `<div class="poker-seat-hand">${escapeHtml(p.handName)}</div>` : "";
        // Card backs ABOVE avatar so they are visible (Gambit-style)
        seat.innerHTML = `${actionBadge}
          <div class="poker-seat-cards">${holeHtml}</div>
          ${avatarHTML(p)}
          <div class="poker-seat-name">${escapeHtml(p.username || "?")}${isMe ? " (YOU)" : ""}${p.isBot ? " 🤖" : ""}${badges.join("")}</div>
          <div class="poker-seat-chips">$${Number(p.chips || 0).toLocaleString()}</div>
          <div class="poker-seat-bet">${p.bet ? ("$" + Number(p.bet).toLocaleString()) : ""}</div>
          ${handLabel}`;
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

  // Buy-in: ONLY when you have 0 chips and no hand is running
  const buyinBar = $("#poker-buyin-bar");
  if (buyinBar) {
    const needsBuyin = !!(me && Number(me.chips || 0) <= 0 && !isSpectator && !isActiveHand && canPhase);
    buyinBar.classList.toggle("hidden", !needsBuyin);
    if (!needsBuyin) buyinBar.classList.add("hidden");
  }

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
  const addRow = el("div","host-player host-add-bot-row");
  const addBtn = el("button","btn menu-primary","+ ADD BOT");
  addBtn.type = "button";
  wireButton(addBtn, () => {
    send({ type: "add_bot" });
  });
  addRow.appendChild(addBtn);
  const hint = el("small","settings-help");
  hint.textContent = "Bots join as spectators mid-hand and sit when the round ends.";
  addRow.appendChild(hint);
  box.appendChild(addRow);
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
    openProgress("#store-overlay");
    send({ type: "store", token: authToken });
  });
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
  wireButton($("#btn-host"), () => openHostPanel());
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
  wireButton($("#btn-play"), openBlackjackLobby);
  wireButton($("#game-blackjack"), openBlackjackLobby);
  wireButton($("#game-poker"), openPokerLobby);
  wireButton($("#btn-join-table"),()=>{const room=$("#input-room").value.trim();$("#room-error").textContent="";if(!room){$("#room-error").textContent="Enter a private table code, or use CREATE PUBLIC TABLE.";return;}send({type:"join",token:authToken,room,game:"blackjack"});});
  wireButton($("#btn-spectate-table"),()=>{const room=$("#input-room").value.trim();$("#room-error").textContent="";if(!room){$("#room-error").textContent="Enter a table code to spectate.";return;}send({type:"join",token:authToken,room,game:"blackjack",spectate:true});});
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
  wireButton($("#poker-host"), () => { renderPokerHostList(); $("#host-overlay").classList.add("open"); });
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
  wireButton($("#btn-friends"), () => { openProgress("#friends-overlay"); $("#friends-error").textContent=""; send({type:"friends",token:authToken}); });
  wireButton($("#btn-friends-close"), () => closeProgress("#friends-overlay"));
  wireButton($("#btn-add-friend"), () => { $("#friends-error").textContent=""; send({type:"add_friend",token:authToken,username:$("#friend-username").value.trim()}); });
  wireButton($("#btn-create-public"), () => {
    const maxPlayers = parseInt($("#bj-max-players")?.value || "5", 10) || 5;
    send({type:"create_public", token:authToken, game:"blackjack", maxPlayers});
  });
  wireButton($("#btn-poker-create"), () => {
    const err = $("#poker-room-error");
    if (err) err.textContent = "";
    if (!authToken) { if (err) err.textContent = "Please log in first."; return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) { if (err) err.textContent = "Not connected. Reconnecting…"; connect(); return; }
    const maxPlayers = parseInt($("#poker-max-players")?.value || "6", 10) || 6;
    const buyIn = parseInt($("#poker-buyin")?.value || "1000", 10) || 1000;
    if (err) err.textContent = "Creating table…";
    send({type:"create_public", token:authToken, game:"poker", maxPlayers, buyIn});
  });
  wireButton($("#btn-poker-spectate"),()=>{const room=($("#poker-join-code")||$("#poker-room-input")||$("#input-poker-room"))?.value?.trim();if(!room){const el=$("#poker-lobby-error");if(el)el.textContent="Enter a code to spectate.";return;}send({type:"join",token:authToken,room,game:"poker",spectate:true});});
  wireButton($("#btn-poker-join"),()=>{
    const err = $("#poker-room-error");
    if (err) err.textContent = "";
    const room = ($("#poker-room")?.value || "").trim();
    if (!room) { if (err) err.textContent = "Enter a private table code, or use CREATE PUBLIC TABLE."; return; }
    if (!authToken) { if (err) err.textContent = "Please log in first."; return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) { if (err) err.textContent = "Not connected. Reconnecting…"; connect(); return; }
    if (err) err.textContent = "Joining…";
    send({type:"join", token:authToken, room, game:"poker"});
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
  wireButton($("#btn-poker-buyin-go"), () => {
    const amt = Math.floor(Number($("#poker-buyin-amt")?.value || 0));
    if (amt <= 0) return;
    send({ type: "poker_buyin", token: authToken, amount: amt });
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
  wireButton($("#poker-help"), () => openProgress("#help-poker-overlay"));
  wireButton($("#btn-help-poker-close"), () => closeProgress("#help-poker-overlay"));
  wireButton($("#bj-help"), () => openProgress("#help-bj-overlay"));
  wireButton($("#btn-help-bj-close"), () => closeProgress("#help-bj-overlay"));

  wireButton($("#btn-stats"), () => { renderStats(); openProgress("#stats-overlay"); send({type:"profile", token:authToken}); });
  wireButton($("#btn-rankings"), () => { openProgress("#leaderboard-overlay"); send({type:"leaderboard_playtime",token:authToken}); send({type:"leaderboard",token:authToken}); send({type:"leaderboard"}); });
  wireButton($("#btn-achievements"), () => { openProgress("#achievements-overlay"); send({type:"achievements", token:authToken}); });
  wireButton($("#btn-daily"), () => { openProgress("#daily-overlay"); send({type:"daily", token:authToken}); });
  wireButton($("#btn-daily-home"), () => { openProgress("#daily-overlay"); send({type:"daily", token:authToken}); });
  wireButton($("#btn-store"), () => { openProgress("#store-overlay"); send({type:"store", token:authToken}); });
  wireButton($("#btn-season"), () => { openProgress("#season-overlay"); send({type:"season", token:authToken}); });
  wireButton($("#btn-stats-close"), () => closeProgress("#stats-overlay"));
  wireButton($("#btn-rankings-close"), () => closeProgress("#leaderboard-overlay"));
  wireButton($("#btn-achievements-close"), () => closeProgress("#achievements-overlay"));
  wireButton($("#btn-daily-close"), () => closeProgress("#daily-overlay"));
  wireButton($("#btn-store-close"), () => closeProgress("#store-overlay"));
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
