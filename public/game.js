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
let leaderboardData = null;
let activeRank = "balance";
let publicTables = [];
let rouletteTables = [];
let rouletteState = null;
let rouletteBetAmount = 100;
let currentGame = "blackjack";
let friendsData = [];
let chatMuted = localStorage.getItem("bj_chat_muted") === "1";
let storeData = null;
let seasonData = null;
let appearanceData = null;
let rouletteAnimationTimer = null;
const ROULETTE_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

// ---------------------------------------------------------------------------
// Update Log — versioned changelog shown once per account after update
// ---------------------------------------------------------------------------
const UPDATE_LOG_VERSION = 1;
const UPDATE_LOG_ENTRIES = [
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
      <div class="ul-illust" aria-hidden="true">${e.icon}</div>
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
    body: "Claim it in the main menu — open Season 1 for your pass rewards.",
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
  const t = e.target.closest?.(".btn, .icon-btn, .chip, .game-card, .toggle, .auth-tab, .seat-plus, .roulette-number, .roulette-bet");
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
  rouletteState = null;
  isAdmin = false;
  $("#settings-overlay")?.classList.remove("open");
  $("#host-overlay")?.classList.remove("open");
  $("#claim-overlay")?.classList.remove("open");
  $("#admin-overlay")?.classList.remove("open");
  $("#invite-toast")?.classList.add("hidden");
  $("#friend-boost-hud")?.classList.add("hidden");
  $("#double-cash-banner")?.remove();
  $("#roulette-admin")?.classList.add("hidden");
  $("#btn-admin-table")?.classList.add("hidden");
  $("#btn-host")?.classList.add("hidden");
  $("#roulette-host")?.classList.add("hidden");
  // Clear any leftover seat DOM so re-entering doesn't flash old seats
  const seats = $("#seats-row");
  if (seats) seats.innerHTML = "";
  const dealer = $("#dealer-hand");
  if (dealer) dealer.innerHTML = "";
  const dval = $("#dealer-value");
  if (dval) dval.textContent = "";
  toggleChat?.(false);
}

function showMainMenu() {
  clearTableClientState();
  document.querySelector("#screen-join .auth-card")?.classList.add("main-menu-mode");
  $("#auth-form")?.classList.add("hidden");
  $("#room-form")?.classList.remove("hidden");
  $("#room-error") && ($("#room-error").textContent = "");
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
  const w = innerWidth, h = innerHeight;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
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
  const f = $("#flash");
  if (!f) return;
  f.className = "";
  void f.offsetWidth; // restart animation
  f.classList.add(kind, "flash-" + kind);
}
function shakeTable() {
  const tw = $("#table-wrap");
  tw.classList.remove("shake");
  void tw.offsetWidth;
  tw.classList.add("shake");
}
function centerBanner(text, kind) {
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
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
      $("#menu-balance").textContent = "$" + msg.balance;
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
      if (msg.game === "roulette") { rouletteTables = msg.tables || []; renderRouletteTables(); }
      else { publicTables = msg.tables || []; renderPublicTables(); }
      return;
    }
    if (msg.type === "public_created") {
      if (msg.game === "roulette") { $("#roulette-room").value = msg.code; send({type:"join", token:authToken, room:msg.code, game:"roulette"}); }
      else { $("#input-room").value = msg.code; send({type:"join", token:authToken, room:msg.code, game:"blackjack"}); }
      return;
    }
    if (msg.type === "friends") {
      friendsData = msg.friends || [];
      renderFriends();
      renderProfileFriends();
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
      myId = msg.id;
      myRoom = msg.room;
      currentGame = msg.game || "blackjack";
      $("#room-chip").textContent = "TABLE " + myRoom;
      $("#profile-name").textContent = msg.username || loggedUsername || "PLAYER";
      $("#menu-balance").textContent = "$" + msg.balance;
      $("#btn-admin-float").classList.add("hidden"); $("#btn-admin-table").classList.remove("hidden");
      $("#chat-messages").innerHTML = "";
      toggleChat(false);
      if (currentGame === "roulette") {
        $("#roulette-profile-name").textContent = msg.username || loggedUsername || "PLAYER";
        $("#roulette-balance").textContent = "$" + Number(msg.balance||0).toLocaleString();
        $("#roulette-room-chip").textContent = "ROULETTE " + myRoom;
        $("#roulette-admin").classList.remove("hidden");
        showScreen("#screen-roulette");
        send({type:"roulette_state"});
      } else {
        showScreen("#screen-table");
      }
      play("join");
      return;
    }
    if (msg.type === "left_table") {
      const bal = $("#balance-chip")?.textContent || $("#menu-balance")?.textContent || "$0";
      clearTableClientState();
      $("#btn-admin-float")?.classList.add("hidden");
      if ($("#menu-balance")) $("#menu-balance").textContent = bal;
      showMainMenu();
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
      $("#balance-chip").textContent = "$" + msg.balance;
      $("#menu-balance").textContent = "$" + msg.balance;
      $("#roulette-balance").textContent = "$" + Number(msg.balance||0).toLocaleString();
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
      $("#btn-admin-float").classList.remove("hidden"); $("#btn-admin-table").classList.remove("hidden"); $("#roulette-admin").classList.remove("hidden");
      return;
    }
    if (msg.type === "admin_data") {
      renderAdminUsers(msg.users || [], msg.tablePlayers || [], msg.dealerPreviewActive, msg.dealerPreview, msg.tableLuck);
      return;
    }
    if (msg.type === "roulette_state") { renderRouletteState(msg.state); return; }
    if (msg.type === "error") {
      const target = msg.scope === "auth" ? $("#join-error") :
        msg.scope === "admin" ? $("#admin-error") :
        msg.scope === "daily" ? $("#daily-reward-box") :
        msg.scope === "friends" ? $("#friends-error") :
        msg.scope === "roulette" ? $("#roulette-room-error") :
        msg.scope === "store" ? $("#store-empty") : $("#room-error");
      if (msg.scope === "daily") target.innerHTML = `<strong>NOT AVAILABLE</strong><span>${msg.message}</span>`;
      else if (msg.scope === "store") { target.classList.remove("hidden"); target.innerHTML = `<strong>${escapeHtml(msg.message || "Store action unavailable")}</strong><span>Please try again.</span>`; setTimeout(()=>{ if(storeData) renderStore(); }, 1200); }
      else target.textContent = msg.message;
      return;
    }
    if (msg.type === "state") onState(msg.state);
  });
  ws.addEventListener("close", () => {
    // Only return to account screen when we weren't intentionally leaving.
    if (!$("#screen-table").classList.contains("active")) return;
    $("#room-error").textContent = "Disconnected from server.";
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
  if (!$("#screen-table")?.classList.contains("active") && !$("#screen-roulette")?.classList.contains("active")) {
    return;
  }
  const prev = lastState;
  lastState = state;

  const me = state.players.find((p) => p.id === myId);
  if (me) {
    $("#balance-chip").textContent = "$" + me.money;
    $("#menu-balance").textContent = "$" + me.money;
    $("#profile-name").textContent = me.username || loggedUsername || me.name;
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
  bettingDock.classList.add("hidden");
  actionDock.classList.add("hidden");
  waitingDock.classList.add("hidden");

  if (state.phase === "BETTING" && me && !me.spectator) {
    bettingDock.classList.remove("hidden");
    $("#bet-amount").textContent = "$" + me.bet;
    $("#bet-hint").style.visibility = me.bet === 0 ? "visible" : "hidden";
    $("#btn-ready").disabled = me.bet <= 0 || me.status === "ready";
    $("#btn-ready").textContent = me.status === "ready" ? "WAITING…" : "READY";
    $("#btn-clear").disabled = me.bet === 0;
    $("#btn-allin").disabled = me.money <= 0 || me.bet === me.money;
    document.querySelectorAll("#chip-row .chip").forEach((c) => (c.disabled = me.bet >= me.money));
  } else if (state.phase === "PLAYING" && me && state.activePlayerId === me.id) {
    actionDock.classList.remove("hidden");
    const canDouble = me.hand.length === 2 && me.money >= me.bet;
    $("#btn-double").disabled = !canDouble;
  } else {
    waitingDock.classList.remove("hidden");
    const note = $("#waiting-note");
    if (me && me.spectator) {
      note.textContent = "Spectating — watching this table";
    } else if (state.phase === "PLAYING") {
      const active = state.players.find((p) => p.id === state.activePlayerId);
      note.textContent = active ? `Waiting for ${active.name}…` : "Dealer is playing…";
    } else if (state.phase === "ROUND_OVER") {
      note.textContent = "Round over — next hand starting soon";
    } else if (me && me.status === "spectating") {
      note.textContent = "Spectating — you're in next round";
    } else {
      note.textContent = "Waiting for the table…";
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

  // Friend boost HUD
  updateFriendBoostHUD(state);
}

function openSeatInvite() {
  // Prefer friends overlay for invite; if at table, prompt username of friend
  const friends = myProfile?.friends || friendsData || [];
  if (!friends.length) {
    centerBanner("ADD FRIENDS FIRST", "lose");
    openProgress("#friends-overlay");
    send({ type: "friends", token: authToken });
    return;
  }
  const names = friends.map(f => f.username).join(", ");
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
      if (Number.isInteger(n) && n>=0 && n<=100) send({type:"admin_set_roulette_luck",targetId:u.id,strength:n});
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
function updateProfileUI(profile) {
  if (!profile) return;
  myProfile = profile;
  if(profile.season) { const _prevXp = seasonData ? Number(seasonData.xp||0) : null; seasonData = profile.season; applySeasonTheme(); checkSeasonLevelUps(_prevXp, seasonData); }
  applyCosmeticTheme(profile.cosmetics?.theme || "classic");
  applyGameCosmetics(profile.cosmetics || {});
  refreshAvatarPreview();
  $("#menu-balance").textContent = "$" + Number(profile.balance || 0).toLocaleString();
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
    ["BLACKJACKS", s.blackjacks || 0], ["ROULETTE GAMES", s.rouletteGames || 0], ["ROULETTE WINS", s.rouletteWins || 0],
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
  root.setAttribute("data-roulette-ball", ball);
  // Also mirror onto body for any descendant-only selectors
  document.body.setAttribute("data-casino-chip", chip);
  document.body.setAttribute("data-blackjack-deck", deck);
  document.body.setAttribute("data-table-skin", table);
  document.body.setAttribute("data-roulette-ball", ball);
  if (myProfile) {
    myProfile.cosmetics = { ...(myProfile.cosmetics || {}), ...c, chip, deck, table, ball };
  }
  // Force a tiny style recalc so chip/deck/table skins paint immediately
  document.body.style.opacity = "0.999";
  requestAnimationFrame(() => { document.body.style.opacity = ""; });
}
function applySeasonTheme(){
  const enabled = localStorage.getItem("bj_seasonal_ui") !== "0";
  const active = !!(seasonData?.season?.active===true && seasonData?.season?.theme==="casino1927");
  document.documentElement.classList.toggle("season-1927", active && enabled);
  document.documentElement.setAttribute("data-seasonal-ui", active && enabled ? "1" : "0");
  $("#toggle-seasonal-ui")?.classList.toggle("on", active && enabled);
}
function applySeasonalUI(enabled){
  localStorage.setItem("bj_seasonal_ui", enabled ? "1" : "0");
  applySeasonTheme();
}
function previewCosmetic(cat,id){const maps={theme:{classic:"#1c1f23,#050506",midnight:"#24516e,#06101a",royal:"#6a326c,#160916",neon:"#16877f,#060f12",casino1927:"#d7b56d,#183b2a"},chip:{classic:"#17191d,#050506",silver:"#bfc8d0,#343b44",gold:"#e5c56d,#6c4c13",casino1927:"#d7b56d,#3c2413"},deck:{classic:"#f7f0df,#2b2a29",midnight:"#252a35,#050609",casino1927:"#d7b56d,#173d2a"},table:{classic:"#2f6d4b,#0c281b",royal:"#496c35,#1c2b16",casino1927:"#6d5130,#123a28"},ball:{classic:"#f4f4f4,#777",brass1927:"#f1d28a,#8f5c1a"}};return (maps[cat]&&maps[cat][id])||maps[cat]?.classic||"#17191d,#050506";}
function renderAppearance(){const boxes={theme:$("#appearance-themes"),chip:$("#appearance-chips"),deck:$("#appearance-decks"),table:$("#appearance-tables"),ball:$("#appearance-balls")};if(!boxes.theme)return;const cats={theme:[...(storeData?.themes||[]),...(storeData?.adminThemes||[])],chip:[...(storeData?.chips||[]),...(storeData?.adminChips||[])],deck:storeData?.decks||[],table:storeData?.tables||[],ball:storeData?.balls||[]};Object.entries(boxes).forEach(([cat,b])=>{if(!b)return;b.innerHTML=(cats[cat]||[]).map(x=>{const c=previewCosmetic(cat,x.id).split(","),a=x.equipped?'<button class="btn secondary" disabled>EQUIPPED</button>':x.owned?`<button class="btn" data-app-equip="${cat}" data-id="${escapeAttr(x.id)}">EQUIP</button>`:'<button class="btn secondary" data-app-buy>BUY AT SHOP</button>';return `<div class="appearance-item ${x.equipped?'equipped':''} ${!x.owned?'locked':''}"><div class="appearance-preview" style="--preview-a:${c[0]};--preview-b:${c[1]}">${escapeHtml(x.name)}</div><div><strong>${escapeHtml(x.name)}</strong><small>${x.owned?(x.equipped?"CURRENTLY EQUIPPED":"OWNED"):"UNOWNED"}${x.limited?" • SEASONAL":""}</small></div>${a}</div>`}).join("");b.querySelectorAll("[data-app-equip],[data-app-buy]").forEach(x=>wireButton(x,()=>{if(x.hasAttribute("data-app-buy")){$("#appearance-overlay").classList.remove("open");openProgress("#store-overlay");send({type:"store",token:authToken});}else send({type:"equip_cosmetic",token:authToken,category:x.dataset.appEquip,id:x.dataset.id});}));});}
function renderStore(){
  if(!storeData) return;
  const catalog = [
    ...(storeData.themes||[]).map(x=>({...x,category:"theme",categoryLabel:"THEME"})),
    ...(storeData.chips||[]).map(x=>({...x,category:"chip",categoryLabel:"CHIPS"})),
    ...(storeData.decks||[]).map(x=>({...x,category:"deck",categoryLabel:"BLACKJACK"})),
    ...(storeData.tables||[]).map(x=>({...x,category:"table",categoryLabel:"TABLE"})),
    ...(storeData.balls||[]).map(x=>({...x,category:"ball",categoryLabel:"ROULETTE"}))
  ];
  $("#store-balance").textContent="$"+Number(storeData.balance||0).toLocaleString();
  const activeTab = window.storeTab || "all";
  const ownedOnly = !!window.storeOwnedOnly;
  document.querySelectorAll(".store-tab").forEach(b=>b.classList.toggle("active",b.dataset.storeTab===activeTab));
  const visible = catalog.filter(x=>(activeTab==="all"||x.category===activeTab) && (!ownedOnly||x.owned));
  $("#store-results-title").textContent = activeTab==="all" ? "HOUSE COLLECTION" : ({theme:"THEMES",chip:"CASINO CHIPS",deck:"BLACKJACK DECKS",table:"TABLE SKINS",ball:"ROULETTE BALLS"}[activeTab]||"COLLECTION");
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
    return `<article class="store-product ${x.equipped?"is-equipped":""} ${x.owned?"is-owned":""} ${x.limited?"is-seasonal":""}">
      <div class="store-product-art" style="--preview-a:${colors[0]};--preview-b:${colors[1]}">
        <span class="store-product-category">${escapeHtml(x.categoryLabel)}</span>
        <div class="store-product-mark">${escapeHtml(x.category==="chip"?"✦":x.category==="ball"?"●":x.category==="deck"?"♠":x.category==="table"?"▰":"✥")}</div>
        ${x.limited?'<span class="store-season-ribbon">SEASON 1</span>':""}
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
function renderSeason(){if(!seasonData)return;const xp=Number(seasonData.xp||0),tiers=seasonData.tiers||[],meta=seasonData.season||{};$("#season-xp").textContent=xp.toLocaleString()+" XP";$("#season-countdown").textContent=meta.active===false?"SEASON ENDED":formatCountdown(meta.remainingSeconds);$("#season-season-status").textContent=meta.active===false?"ACQUISITION CLOSED":"ACTIVE";applySeasonTheme();const max=Number(tiers.at(-1)?.xp||1);$("#season-progress-fill").style.width=Math.min(100,Math.round(xp/max*100))+"%";$("#season-tier-list").innerHTML=tiers.map(t=>{const r=t.reward||{},type=(r.type||"reward").toUpperCase(),state=t.claimed?"CLAIMED":t.unlocked?"AVAILABLE":"LOCKED",button=t.claimed?'<button class="btn secondary" disabled>CLAIMED</button>':t.unlocked?`<button class="btn" data-season-claim="${t.tier}">CLAIM</button>`:'<button class="btn secondary" disabled>LOCKED</button>',limited=(r.id&&String(r.id).includes("1927"))||["deck","table","ball"].includes(r.type)?'<span class="limited-badge">SEASONAL • PERMANENT ON CLAIM</span>':"";return `<div class="season-tier ${t.unlocked?"unlocked":""} ${t.claimed?"claimed":""}"><div class="season-tier-num">${t.tier}</div><div class="season-reward-copy"><strong>${escapeHtml(r.name||"REWARD")}</strong><small>${type} • ${Number(t.xp).toLocaleString()} XP</small>${limited}</div><div class="season-state">${state}</div>${button}</div>`}).join("");document.querySelectorAll("[data-season-claim]").forEach(b=>wireButton(b,()=>send({type:"claim_season",token:authToken,tier:Number(b.dataset.seasonClaim)})));}
function openProgress(id) { $(id).classList.add("open"); }
function closeProgress(id) { $(id).classList.remove("open"); }

function sendChat(){ const input=$("#chat-input"); const text=input.value.trim(); if(!text) return; send({type:"chat",text}); input.value=""; }

// ---------------------------------------------------------------------------
// Profile / friends / public tables / chat
// ---------------------------------------------------------------------------
function renderProfile() {
  const p = myProfile;
  if (!p) return;
  $("#profile-hero").innerHTML = `<div><strong>${escapeHtml(p.username)}</strong><span>LEVEL ${p.level} • ${escapeHtml(p.levelTitle)}</span></div><b>$${Number(p.balance||0).toLocaleString()}</b>`;
  const st = p.stats || {};
  const vals = [["CASINO GAMES",st.gamesPlayed],["CASINO WINS",st.wins],["LOSSES",st.losses],["BLACKJACKS",st.blackjacks],["ROULETTE GAMES",st.rouletteGames||0],["ROULETTE WINS",st.rouletteWins||0],["WIN RATE",(st.winRate||0)+"%"],["BIGGEST WIN","$"+Number(st.biggestWin||0).toLocaleString()]];
  $("#profile-stats-grid").innerHTML = vals.map(([a,b])=>`<div class="stat-box"><span>${a}</span><strong>${b}</strong></div>`).join("");
  renderProfileFriends();
}
function renderProfileFriends(){
  const box=$("#profile-friends"); if(!box) return;
  box.innerHTML = friendsData.length ? friendsData.slice(0,8).map(f=>`<div class="friend-row"><span class="online-dot ${f.online?'online':''}"></span><strong>${escapeHtml(f.username)}</strong><small>Lv ${f.level}</small></div>`).join("") : '<div class="admin-empty">No friends yet.</div>';
}
function renderFriends(){
  const box=$("#friends-list"); if(!box) return;
  box.innerHTML = friendsData.length ? friendsData.map(f=>{
    const loc = f.location ? `${(f.location.game||'').toUpperCase()} ${f.location.room}` : (f.online ? "ONLINE" : "OFFLINE");
    return `<div class="friend-row"><span class="online-dot ${f.online?'online':''}"></span><div class="friend-meta"><strong>${escapeHtml(f.username)}</strong><small>Lv ${f.level} • ${escapeHtml(loc)}</small></div><button class="btn secondary friend-invite" data-user="${escapeAttr(f.username)}">INVITE</button><button class="btn secondary friend-remove" data-user="${escapeAttr(f.username)}">REMOVE</button></div>`;
  }).join("") : '<div class="admin-empty">No friends yet. Add someone by username.</div>';
  box.querySelectorAll('.friend-remove').forEach(b=>wireButton(b,()=>send({type:'remove_friend',token:authToken,username:b.dataset.user})));
  box.querySelectorAll('.friend-invite').forEach(b=>wireButton(b,()=>send({type:'invite_friend',token:authToken,username:b.dataset.user})));
}

let seasonTicker=null;function startSeasonTicker(){if(seasonTicker)clearInterval(seasonTicker);seasonTicker=setInterval(()=>{if(!seasonData?.season)return;const rem=Math.max(0,Math.floor(Number(seasonData.season.endAt||0)-Date.now()/1000));seasonData.season.remainingSeconds=rem;if(rem<=0)seasonData.season.active=false;if($("#season-overlay").classList.contains("open"))renderSeason();applySeasonTheme()},1000)}
function renderPublicTables(){
  const box=$("#public-table-list"); if(!box) return;
  box.innerHTML = publicTables.length ? publicTables.map(t=>`<div class="public-table-row"><div><strong>${escapeHtml((t.game||"BLACKJACK").toUpperCase())} • TABLE ${escapeHtml(t.code)}</strong><small>Host: ${escapeHtml(t.host)} • ${t.players}/${t.maxPlayers} Players • ${t.phase === 'PLAYING' ? 'IN GAME' : 'WAITING'}</small></div><div class="public-table-actions">${t.canJoin?`<button class="btn" data-join="${t.code}">JOIN</button>`:''}${t.canSpectate?`<button class="btn secondary" data-spec="${t.code}">WATCH</button>`:''}</div></div>`).join("") : '<div class="admin-empty">No public tables yet. Create one!</div>';
  box.querySelectorAll('[data-join]').forEach(b=>wireButton(b,()=>send({type:'join',token:authToken,room:b.dataset.join})));
  box.querySelectorAll('[data-spec]').forEach(b=>wireButton(b,()=>send({type:'join',token:authToken,room:b.dataset.spec,spectate:true})));
}

function renderRouletteTables(){
  const box=$("#roulette-table-list"); if(!box) return;
  const tables=rouletteTables.filter(t=>t.game==="roulette");
  box.innerHTML=tables.length ? tables.map(t=>`<div class="public-table-row"><div><strong>ROULETTE • TABLE ${escapeHtml(t.code)}</strong><small>Host: ${escapeHtml(t.host)} • ${t.players}/${t.maxPlayers} Players • ${t.phase==='SPINNING'?'SPINNING':'BETTING'}</small></div><div class="public-table-actions">${t.canJoin?`<button class="btn" data-rjoin="${t.code}">JOIN</button>`:''}</div></div>`).join("") : '<div class="admin-empty">No Roulette tables yet. Create one! </div>';
  box.querySelectorAll('[data-rjoin]').forEach(b=>wireButton(b,()=>send({type:'join',token:authToken,room:b.dataset.rjoin,game:'roulette'})));
}
function buildRouletteNumbers(){
  const box=$("#roulette-number-strip"), zero=$("#roulette-zero-bet");
  if(!box || !zero) return;
  box.innerHTML="";
  for(let n=1;n<=36;n++){
    const b=el("button","roulette-number",String(n));
    b.dataset.n = String(n);
    b.classList.add(ROULETTE_RED_SET.has(n)?"red":"black");
    wireButton(b,()=>placeRouletteBet("straight",n));
    box.appendChild(b);
  }
  wireButton(zero,()=>placeRouletteBet("straight",0));
  const pockets=$("#roulette-pockets");
  if(pockets) pockets.innerHTML=ROULETTE_ORDER.map((n,i)=>`<span class="wheel-pocket ${n===0?"green":ROULETTE_RED_SET.has(n)?"red":"black"}" style="--i:${i}">${n}</span>`).join("");
}
const ROULETTE_RED_SET=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function placeRouletteBet(type,value=null){
  if(!rouletteState || rouletteState.phase!=="BETTING") return;
  send({type:"roulette_bet",token:authToken,betType:type,value,amount:rouletteBetAmount});
}
function animateRouletteResult(number) {
  const wheel = $("#roulette-wheel");
  const ball = $("#roulette-ball");
  const panel = document.querySelector(".roulette-wheel-wrap");
  if (!wheel) return;
  if (rouletteAnimationTimer) clearTimeout(rouletteAnimationTimer);

  const n = Number(number);
  const idx = Math.max(0, ROULETTE_ORDER.indexOf(n));
  const slotAngle = 360 / 37;
  // Ball ends at the winning pocket under the top pointer
  const endDeg = 5 * 360 + (360 - idx * slotAngle);
  // Wheel spins opposite direction a bit for depth
  const wheelEnd = -(3 * 360 + idx * slotAngle * 0.3);

  wheel.classList.remove("spinning");
  ball?.classList.remove("ball-spinning");
  void wheel.offsetWidth;

  wheel.style.transform = `rotate(${wheelEnd}deg)`;
  wheel.classList.add("spinning");
  if (ball) {
    ball.style.setProperty("--ball-end", endDeg + "deg");
    void ball.offsetWidth;
    ball.classList.add("ball-spinning");
  }
  play("deal");

  rouletteAnimationTimer = setTimeout(() => {
    ball?.classList.remove("ball-spinning");
    wheel.classList.remove("spinning");
    // Snap ball to final position
    if (ball) ball.style.transform = `rotate(${endDeg}deg) translateY(-92px)`;
    // Result banner on wheel
    if (panel) {
      const color = n === 0 ? "green" : ROULETTE_RED_SET.has(n) ? "red" : "black";
      const old = panel.querySelector(".roulette-result-flash");
      if (old) old.remove();
      const flash = el("div", "roulette-result-flash " + color, String(n));
      panel.appendChild(flash);
      if (color === "green" || color === "red") play("win");
      else play("chip");
      setTimeout(() => flash.remove(), 2200);
    }
  }, 5600);
}
function renderRouletteState(state){
  rouletteState=state; if(!state) return;
  $("#roulette-room-chip").textContent="ROULETTE " + state.code;
  const me=(state.players||[]).find(x=>x.id===myId);
  if(me?.cosmetics) applyGameCosmetics(me.cosmetics);
  const total=Number(me?.total||0);
  $("#roulette-seat-info").textContent=me ? `YOUR BETS: $${total.toLocaleString()}` : "PLACE A BET TO JOIN THE ROUND";
  $("#roulette-total-bets").textContent="$"+total.toLocaleString();
  $("#roulette-balance-meta").textContent=$("#roulette-balance").textContent;
  const maxP = state.maxPlayers || 5;
  $("#roulette-player-count").textContent=`${state.players?.length||0}/${maxP}` + (state.doubleCash ? " • 2×" : "");
  $("#roulette-status").textContent=state.phase;
  $("#roulette-round-state").textContent=state.phase;
  const r=state.lastResult;
  $("#roulette-result").textContent = state.phase==='SPINNING' ? "THE WHEEL IS SPINNING…" : r ? `RESULT • ${r.number} ${String(r.color).toUpperCase()}` : "PLACE YOUR BETS";
  $("#roulette-spin").disabled = state.phase!=="BETTING" || !(me && me.total>0);
  $("#roulette-clear").disabled = state.phase!=="BETTING" || !(me && me.total>0);
  document.querySelectorAll(".roulette-bet,.roulette-number,.roulette-zero-bet").forEach(b=>b.disabled=state.phase!=="BETTING");
  const host=(state.players||[]).find(x=>x.id===myId)?.isHost;
  $("#roulette-host").classList.toggle("hidden",!host);
  $("#roulette-admin").classList.toggle("hidden",!isAdmin);

  // Show player bet markers on board spots
  document.querySelectorAll(".bet-stack").forEach(s => s.remove());
  const board = state.boardBets || [];
  board.forEach(b => {
    let target = null;
    if (b.type === "straight") {
      if (Number(b.value) === 0) target = $("#roulette-zero-bet");
      else target = document.querySelector(`.roulette-number[data-n="${b.value}"]`) ||
        [...document.querySelectorAll(".roulette-number")].find(el => el.textContent.trim() === String(b.value));
    } else {
      target = document.querySelector(`.roulette-bet[data-bet="${b.type}"]`) ||
        document.querySelector(`[data-bet="${b.type}"]`);
    }
    if (!target) return;
    let stack = target.querySelector(".bet-stack");
    if (!stack) {
      stack = el("div", "bet-stack");
      target.appendChild(stack);
    }
    const av = el("div", "bet-avatar", b.letter || "?");
    av.style.background = b.color || "#6366f1";
    av.title = `${b.username}: $${b.amount}`;
    stack.appendChild(av);
  });

  if (state.phase === "SPINNING" || (r && state.phase === "RESULT")) {
    if (r && state.phase === "RESULT") {
      if (!window._lastRouletteAnimTs || window._lastRouletteAnimTs !== r.ts) {
        window._lastRouletteAnimTs = r.ts;
        animateRouletteResult(r.number);
        // Win/loss feedback for me
        if (me && me.total > 0) {
          // rough: if we had bets, celebrate on result screen
          setTimeout(() => {
            centerBanner(`RESULT ${r.number} ${String(r.color).toUpperCase()}`, r.number === 0 ? "win" : (r.color === "red" ? "win" : "push"));
          }, 5600);
        }
      }
      const history = $("#roulette-history");
      if (history && history.dataset.lastTs !== String(r.ts)) {
        history.dataset.lastTs = String(r.ts);
        const chip = el("span", "history-number", String(r.number));
        chip.classList.add(r.number === 0 ? "green" : r.color);
        history.prepend(chip);
        while (history.children.length > 12) history.lastElementChild.remove();
      }
    }
  }
}

function renderRouletteHostList(){
  const box=$("#host-list"); if(!box || !rouletteState) return;
  box.innerHTML="";
  const dc = $("#toggle-double-cash");
  if (dc) dc.classList.toggle("on", !!rouletteState.doubleCash);
  (rouletteState.players||[]).forEach(p=>{
    const row=el("div","host-player");
    row.appendChild(el("span",null,p.username+(p.id===myId?" (you)":"")));
    if(p.id===myId || p.isHost) row.appendChild(el("span","host-badge","HOST"));
    else {
      const actions=el("div","host-actions");
      const transferBtn=el("button","btn secondary kick-btn","MAKE HOST");
      wireButton(transferBtn,()=>{ if(confirm("Transfer host to "+p.username+"?")){ send({type:"transfer_host",targetId:p.id}); $("#host-overlay").classList.remove("open"); }});
      const kickBtn=el("button","kick-btn","KICK");
      wireButton(kickBtn,()=>{ if(confirm("Kick "+p.username+"?")) send({type:"kick",targetId:p.id}); });
      actions.appendChild(transferBtn); actions.appendChild(kickBtn);
      row.appendChild(actions);
    }
    box.appendChild(row);
  });
}

function openRouletteLobby(){
  // If still seated, leave first so server doesn't keep a ghost seat
  if (myId || myRoom) send({ type: "leave_table" });
  clearTableClientState();
  currentGame = "roulette";
  $("#roulette-room-error") && ($("#roulette-room-error").textContent = "");
  showScreen("#screen-roulette-lobby");
  send({ type: "public_tables", game: "roulette" });
}
function openBlackjackLobby(){
  if (myId || myRoom) send({ type: "leave_table" });
  clearTableClientState();
  currentGame = "blackjack";
  $("#room-error") && ($("#room-error").textContent = "");
  showScreen("#screen-lobby");
  send({ type: "public_tables", game: "blackjack" });
}

function appendChat(username,text){
  if(chatMuted) return;
  const box=$("#chat-messages"); if(!box) return;
  const row=el('div','chat-line'); row.innerHTML=`<strong>${escapeHtml(username)}</strong><span>${escapeHtml(text)}</span>`; box.appendChild(row); box.scrollTop=box.scrollHeight;
}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function escapeAttr(v){return escapeHtml(v);}
function toggleChat(open){$("#chat-panel").classList.toggle('open',open);$("#btn-chat-open").classList.toggle('hidden',open);if(open) $("#chat-input").focus();}

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

function applyMobileMode(enabled) {
  const on = !!enabled;
  document.documentElement.setAttribute("data-mobile", on ? "1" : "0");
  $("#toggle-mobile")?.classList.toggle("on", on);
  $("#toggle-mobile-auth")?.classList.toggle("on", on);
  localStorage.setItem("bj_mobile", on ? "1" : "0");
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
  // Mobile mode: remember preference (default off until user turns on)
  applyMobileMode(localStorage.getItem("bj_mobile") === "1");
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
  wireButton($("#roulette-host"), () => openHostPanel());
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
    showMainMenu();
    setTimeout(() => {
      if ($("#screen-table")?.classList.contains("active") || $("#screen-roulette")?.classList.contains("active")) {
        clearTableClientState();
        showMainMenu();
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
  wireButton($("#btn-double"), () => send({ type: "double" }));
}

function initJoin() {
  $("#auth-username").value = localStorage.getItem("bj_username_hint") || "";
  $("#tab-login").addEventListener("click", () => setAuthMode("login"));
  $("#tab-signup").addEventListener("click", () => setAuthMode("signup"));
  wireButton($("#btn-auth"), loginOrSignup);
  wireButton($("#btn-play"), openBlackjackLobby);
  wireButton($("#game-blackjack"), openBlackjackLobby);
  wireButton($("#game-roulette"), openRouletteLobby);
  wireButton($("#btn-join-table"),()=>{const room=$("#input-room").value.trim();$("#room-error").textContent="";if(!room){$("#room-error").textContent="Enter a private table code, or use CREATE PUBLIC TABLE.";return;}send({type:"join",token:authToken,room,game:"blackjack"});});
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
  wireButton($("#roulette-admin"), openAdmin);
  wireButton($("#roulette-host"), () => { renderRouletteHostList(); $("#host-overlay").classList.add("open"); });
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
  wireButton($("#btn-roulette-create"), () => {
    const maxPlayers = parseInt($("#roulette-max-players")?.value || "5", 10) || 5;
    send({type:"create_public", token:authToken, game:"roulette", maxPlayers});
  });
  wireButton($("#btn-roulette-join"),()=>{const room=$("#roulette-room").value.trim();$("#roulette-room-error").textContent="";if(!room){$("#roulette-room-error").textContent="Enter a private table code, or use CREATE PUBLIC TABLE.";return;}send({type:"join",token:authToken,room,game:"roulette"});});
  wireButton($("#btn-roulette-back"), showMainMenu);
  wireButton($("#roulette-clear"), () => send({type:"roulette_clear"}));
  wireButton($("#roulette-chip-amount"), () => { const vals=[100,500,1000,5000]; rouletteBetAmount=vals[(vals.indexOf(rouletteBetAmount)+1)%vals.length]; $("#roulette-chip-amount").textContent="$"+rouletteBetAmount.toLocaleString(); $("#roulette-chip-amount").classList.add("selected-chip"); });
  wireButton($("#roulette-spin"), () => send({type:"roulette_spin"}));
  wireButton($("#roulette-leave"), () => {
    send({ type: "leave_table" });
    clearTableClientState();
    showMainMenu();
    // Fail-safe: if still on roulette screen, force exit
    setTimeout(() => {
      if ($("#screen-roulette")?.classList.contains("active")) {
        clearTableClientState();
        showMainMenu();
        $("#host-overlay")?.classList.remove("open");
        $("#settings-overlay")?.classList.remove("open");
        showMainMenu();
      }
    }, 800);
  });
  wireButton($("#roulette-settings"), () => { $("#btn-leave-table").classList.remove("hidden"); $("#settings-overlay").classList.add("open"); });
  document.querySelectorAll(".roulette-bet").forEach(b => wireButton(b, () => placeRouletteBet(b.dataset.bet)));
  buildRouletteNumbers();
  wireButton($("#btn-chat-open"), () => toggleChat(true));
  wireButton($("#btn-chat-toggle"), () => toggleChat(false));
  wireButton($("#btn-chat-mute"), () => { chatMuted=!chatMuted; localStorage.setItem('bj_chat_muted',chatMuted?'1':'0'); $("#btn-chat-mute").textContent=chatMuted?'🔇':'🔊'; });
  wireButton($("#btn-chat-send"), () => sendChat());
  $("#chat-input").addEventListener('keydown',e=>{if(e.key==='Enter')sendChat();});

  wireButton($("#btn-stats"), () => { renderStats(); openProgress("#stats-overlay"); send({type:"profile", token:authToken}); });
  wireButton($("#btn-rankings"), () => { openProgress("#leaderboard-overlay"); send({type:"leaderboard"}); });
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
