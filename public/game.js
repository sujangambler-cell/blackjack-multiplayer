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
// Audio — synthesized SFX (no asset files needed), same idea as the desktop build
// ---------------------------------------------------------------------------
const actx = new (window.AudioContext || window.webkitAudioContext)();

function tone(freq, duration, kind = "sine", sweep = 0, vol = 0.5) {
  if (actx.state === "suspended") actx.resume();
  const t0 = actx.currentTime;
  const osc = actx.createOscillator();
  const gain = actx.createGain();
  osc.type = kind;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweep) osc.frequency.linearRampToValueAtTime(freq + sweep, t0 + duration);
  gain.gain.setValueAtTime(vol * sfxVolume, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(actx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

const SFX = {
  click: () => tone(700, 0.06, "square", 0, 0.4),
  hover: () => tone(500, 0.03, "sine", 0, 0.12),
  chip: () => tone(900, 0.05, "sine", -200, 0.3),
  deal: () => tone(320, 0.08, "sine", 180, 0.35),
  flip: () => tone(500, 0.07, "sine", 150, 0.3),
  hit: () => tone(420, 0.09, "triangle", 100, 0.32),
  stand: () => tone(250, 0.12, "triangle", -40, 0.28),
  blackjack: () => { tone(660, 0.16, "sine", 180, 0.42); setTimeout(() => tone(990, 0.28, "sine", 80, 0.35), 90); },
  join: () => tone(560, 0.12, "sine", 160, 0.3),
  leave: () => tone(300, 0.14, "sine", -100, 0.25),
  win: () => { tone(660, 0.35, "sine", 220, 0.45); },
  lose: () => tone(180, 0.4, "sine", -80, 0.45),
  bust: () => tone(140, 0.35, "square", -60, 0.45),
  push: () => tone(420, 0.2, "sine", 0, 0.3),
  pity: () => { tone(500, 0.15, "sine", 100, 0.4); setTimeout(() => tone(700, 0.25, "sine", 150, 0.4), 120); },
};
function play(name) {
  if (!soundEnabled || sfxVolume <= 0) return;
  try { SFX[name] && SFX[name](); } catch (e) { /* audio may not be unlocked yet */ }
}
// unlock audio on first interaction (mobile browsers require a gesture)
document.addEventListener("pointerdown", () => { if (actx.state === "suspended") actx.resume(); }, { once: true });

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

function showMainMenu() {
  document.querySelector("#screen-join .auth-card").classList.add("main-menu-mode");
  $("#auth-form").classList.add("hidden");
  $("#room-form").classList.remove("hidden");
  $("#room-error").textContent = "";
  showScreen("#screen-join");
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
  const wrap = el("div", "card" + (faceUp ? "" : " face-down"));
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
  f.className = "";
  void f.offsetWidth; // restart animation
  f.classList.add(kind);
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
      if (confirm(`${msg.from} invited you to table ${msg.room}. Join now?`)) {
        $("#input-room").value = msg.room;
        showScreen("#screen-lobby");
        send({type:"join",token:authToken,room:msg.room});
      }
      return;
    }
    if (msg.type === "joined") {
      myId = msg.id;
      myRoom = msg.room;
      currentGame = msg.game || "blackjack";
      $("#room-chip").textContent = "TABLE " + myRoom;
      $("#profile-name").textContent = msg.username || loggedUsername || "PLAYER";
      $("#menu-balance").textContent = "$" + msg.balance;
      $("#btn-admin-float").classList.toggle("hidden", !(isAdmin && currentGame === "blackjack"));
      $("#chat-messages").innerHTML = "";
      toggleChat(false);
      if (currentGame === "roulette") {
        $("#roulette-profile-name").textContent = msg.username || loggedUsername || "PLAYER";
        $("#roulette-balance").textContent = "$" + Number(msg.balance||0).toLocaleString();
        $("#roulette-room-chip").textContent = "ROULETTE " + myRoom;
        $("#roulette-admin").classList.toggle("hidden", !isAdmin);
        showScreen("#screen-roulette");
        send({type:"roulette_state"});
      } else {
        showScreen("#screen-table");
      }
      play("join");
      return;
    }
    if (msg.type === "left_table") {
      myId = null; myRoom = null; lastState = null;
      $("#settings-overlay").classList.remove("open");
      $("#claim-overlay").classList.remove("open");
      $("#admin-overlay").classList.remove("open");
      $("#roulette-admin").classList.add("hidden");
      $("#btn-admin-float").classList.add("hidden");
      $("#menu-balance").textContent = $("#balance-chip").textContent || "$0";
      toggleChat(false);
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
        applyCosmeticTheme(myProfile.cosmetics.theme);
      }
      if (msg.purchased) { play("win"); centerBanner("ITEM UNLOCKED", "win"); }
      if (msg.equipped) play("chip");
      renderAppearance();
      return;
    }
    if (msg.type === "season") {
      seasonData = msg.season || null;
      if (msg.profile) updateProfileUI(msg.profile);
      renderSeason();
      if (msg.claimedTier) { play("win"); centerBanner("SEASON REWARD CLAIMED", "win"); }
      return;
    }
    if (msg.type === "admin_ok") {
      isAdmin = true;
      $("#admin-login-box").classList.add("hidden");
      $("#admin-dashboard").classList.remove("hidden");
      $("#btn-admin-float").classList.remove("hidden");
      return;
    }
    if (msg.type === "admin_data") {
      renderAdminUsers(msg.users || [], msg.tablePlayers || [], msg.dealerPreviewActive, msg.dealerPreview, msg.tableLuck);
      return;
    }
    if (msg.type === "roulette_state") { renderRouletteState(msg.state); return; }
    if (msg.type === "error") {
      const target = msg.scope === "auth" ? $("#join-error") : (msg.scope === "admin" ? $("#admin-error") : (msg.scope === "daily" ? $("#daily-reward-box") : (msg.scope === "friends" ? $("#friends-error") : (msg.scope === "roulette" ? $("#roulette-room-error") : $("#room-error")))));
      if (msg.scope === "daily") target.innerHTML = `<strong>NOT AVAILABLE</strong><span>${msg.message}</span>`;
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
  const prev = lastState;
  lastState = state;

  const me = state.players.find((p) => p.id === myId);
  if (me) {
    $("#balance-chip").textContent = "$" + me.money;
    $("#menu-balance").textContent = "$" + me.money;
    $("#profile-name").textContent = me.username || loggedUsername || me.name;
    $("#btn-admin-float").classList.toggle("hidden", !(isAdmin && currentGame === "blackjack"));
    $("#btn-host").classList.toggle("hidden", !me.isHost);
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
  if (result === "win" || result === "blackjack") {
    play(result === "blackjack" ? "blackjack" : "win");
    flash("win");
    burstConfetti();
    centerBanner(result === "blackjack" ? "BLACKJACK!" : "YOU WIN!", "win");
  } else if (result === "push") {
    play("push");
    centerBanner("PUSH", "push");
  } else if (result === "lose") {
    play("lose");
    flash("lose");
    shakeTable();
    centerBanner("DEALER WINS", "lose");
  } else if (result === "bust") {
    play("bust");
    flash("lose");
    shakeTable();
    centerBanner("BUST!", "bust");
  }
}

function renderSeats(state, prev) {
  const row = $("#seats-row");
  row.innerHTML = "";
  for (const p of state.players) {
    if (!p.connected) continue;
    const seat = el("div", "seat" + (p.id === myId ? " me" : "") + (state.activePlayerId === p.id ? " active-turn" : ""));

    seat.appendChild(el("div", "seat-name", p.name + (p.id === myId ? " (you)" : "")));
    seat.appendChild(el("div", "seat-money", "$" + p.money));
    if (p.bet > 0) seat.appendChild(el("div", "seat-bet", "Bet $" + p.bet));

    const handDiv = el("div", "seat-hand");
    (p.hand || []).forEach((c) => handDiv.appendChild(buildCard(c, true)));
    seat.appendChild(handDiv);

    if (p.display) seat.appendChild(el("div", "seat-value", p.display));

    if (p.result) {
      const label = { win: "WIN", lose: "LOSE", push: "PUSH", bust: "BUST", blackjack: "BLACKJACK" }[p.result] || "";
      const statusClass = p.result === "blackjack" ? "blackjack" : p.result;
      seat.appendChild(el("div", "seat-status " + statusClass, label));
    }

    row.appendChild(seat);
  }
}


function renderHostList() {
  if (!lastState) return;
  const box = $("#host-list");
  box.innerHTML = "";
  lastState.players.forEach((p) => {
    const row = el("div", "host-player");
    row.appendChild(el("span", null, p.username || p.name));
    if (p.id === myId) row.appendChild(el("span", null, "HOST"));
    else {
      const b = el("button", "kick-btn", "KICK");
      wireButton(b, () => send({ type: "kick", targetId: p.id }));
      row.appendChild(b);
    }
    box.appendChild(row);
  });
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
    const medal = i < 3 ? ["🥇","🥈","🥉"][i] : `#${i+1}`;
    const me = r.username.toLowerCase() === (loggedUsername || "").toLowerCase();
    return `<div class="rank-row ${me ? "me" : ""}"><span class="rank-place">${medal}</span><div class="rank-name"><strong>${r.username}</strong><small>Lv ${r.level} • ${r.levelTitle}</small></div><strong>${rankValue(r, activeRank)}</strong></div>`;
  }).join("") : '<div class="admin-empty">No players yet.</div>';
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
  const t=theme || "classic";
  document.documentElement.setAttribute("data-cosmetic-theme", t);
  document.body.dataset.cosmeticTheme = t;
  if (myProfile) {
    myProfile.cosmetics = myProfile.cosmetics || {};
    myProfile.cosmetics.theme = t;
  }
}
function renderAppearance() {
  const themeBox=$("#appearance-themes"), chipBox=$("#appearance-chips");
  if(!themeBox || !chipBox) return;
  const themes=[...(storeData?.themes||[]), ...(storeData?.adminThemes||[])], chips=[...(storeData?.chips||[]), ...(storeData?.adminChips||[])];
  const card=(item,cat)=>{
    const owned=!!item.owned, equipped=!!item.equipped;
    const action=equipped?'<button class="btn secondary" disabled>EQUIPPED</button>':
      owned?`<button class="btn" data-app-equip="${cat}" data-id="${escapeAttr(item.id)}">EQUIP</button>`:
      '<button class="btn secondary" data-app-buy>BUY AT SHOP</button>';
    return `<div class="appearance-item ${equipped?'equipped':''} ${!owned?'locked':''}">
      <div class="appearance-preview" style="--preview-a:${cat==="theme"?themePreview(item.id).split(",")[0]:chipPreview(item.id).split(",")[0]};--preview-b:${cat==="theme"?themePreview(item.id).split(",")[1]:chipPreview(item.id).split(",")[1]}">${escapeHtml(item.name)}</div>
      <div><strong>${escapeHtml(item.name)}</strong><small>${owned?(equipped?"CURRENTLY EQUIPPED":"OWNED"):"UNOWNED"}</small></div>${action}</div>`;
  };
  themeBox.innerHTML=themes.map(x=>card(x,"theme")).join("");
  chipBox.innerHTML=chips.map(x=>card(x,"chip")).join("");
  themeBox.querySelectorAll("[data-app-equip], [data-app-buy]").forEach(b=>wireButton(b,()=>{
    if(b.hasAttribute("data-app-buy")) { $("#appearance-overlay").classList.remove("open"); openProgress("#store-overlay"); send({type:"store",token:authToken}); }
    else send({type:"equip_cosmetic",token:authToken,category:b.dataset.appEquip,id:b.dataset.id});
  }));
}

function chipPreview(id){
  const map={classic:"#17191d,#050506",silver:"#bfc8d0,#343b44",gold:"#e5c56d,#6c4c13",orbit:"#5dd6ff,#172a65"};
  return map[id]||map.classic;
}
function themePreview(id){
  const map={classic:"#1c1f23,#050506",midnight:"#24516e,#06101a",royal:"#6a326c,#160916",neon:"#16877f,#060f12",orbit:"#12618c,#040814"};
  return map[id]||map.classic;
}
function renderStore(){
  if(!storeData) return;
  $("#store-balance").textContent="$"+Number(storeData.balance||0).toLocaleString();
  const card=(item,cat)=>{
    const colors=cat==="theme"?themePreview(item.id):chipPreview(item.id);
    const action=item.equipped?'<button class="btn secondary" disabled>EQUIPPED</button>':item.owned?`<button class="btn" data-equip="${cat}" data-id="${item.id}">EQUIP</button>`:`<button class="btn" data-buy="${cat}" data-id="${item.id}">${item.price?"BUY $"+Number(item.price).toLocaleString():"UNLOCK"}</button>`;
    return `<div class="store-item ${item.equipped?'equipped':''}"><div class="store-preview" style="--preview-a:${colors.split(',')[0]};--preview-b:${colors.split(',')[1]}">${cat==='theme'?'THEME':'CHIP'}</div><strong>${item.name}</strong><small>${item.limited?'LIMITED • SEASON 1':item.owned?'OWNED':'PERMANENT'}</small>${action}</div>`;
  };
  $("#store-themes").innerHTML=storeData.themes.map(x=>card(x,"theme")).join("");
  $("#store-chips").innerHTML=storeData.chips.map(x=>card(x,"chip")).join("");
  document.querySelectorAll("[data-buy]").forEach(b=>wireButton(b,()=>send({type:"buy_cosmetic",token:authToken,category:b.dataset.buy,id:b.dataset.id})));
  document.querySelectorAll("[data-equip]").forEach(b=>wireButton(b,()=>send({type:"equip_cosmetic",token:authToken,category:b.dataset.equip,id:b.dataset.id})));
  applyCosmeticTheme(myProfile?.cosmetics?.theme||"classic");
  renderAppearance();
}
function renderSeason(){
  if(!seasonData) return;
  const xp=Number(seasonData.xp||0), tiers=seasonData.tiers||[];
  $("#season-xp").textContent=xp.toLocaleString()+" XP";
  const max=Number(tiers.at(-1)?.xp||1);
  const pct=Math.min(100,Math.round(xp/max*100));
  $("#season-progress-fill").style.width=pct+"%";
  $("#season-tier-list").innerHTML=tiers.map(t=>{
    const r=t.reward||{};
    const type=(r.type||"reward").toUpperCase();
    const state=t.claimed?"CLAIMED":t.unlocked?"AVAILABLE":"LOCKED";
    const button=t.claimed?'<button class="btn secondary" disabled>CLAIMED</button>':
      t.unlocked?`<button class="btn" data-season-claim="${t.tier}">CLAIM</button>`:
      '<button class="btn secondary" disabled>LOCKED</button>';
    const limited=(r.id==="orbit")?'<span class="limited-badge">LIMITED</span>':"";
    return `<div class="season-tier ${t.unlocked?'unlocked':''} ${t.claimed?'claimed':''}">
      <div class="season-tier-num">${t.tier}</div>
      <div class="season-reward-copy"><strong>${escapeHtml(r.name||"REWARD")}</strong><small>${type} • ${Number(t.xp).toLocaleString()} XP</small>${limited}</div>
      <div class="season-state">${state}</div>${button}
    </div>`;
  }).join("");
  document.querySelectorAll("[data-season-claim]").forEach(b=>wireButton(b,()=>send({type:"claim_season",token:authToken,tier:Number(b.dataset.seasonClaim)})));
}
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
  box.innerHTML = friendsData.length ? friendsData.map(f=>`<div class="friend-row"><span class="online-dot ${f.online?'online':''}"></span><strong>${escapeHtml(f.username)}</strong><small>Lv ${f.level} • ${f.online?'ONLINE':'OFFLINE'}</small><button class="btn secondary friend-invite" data-user="${escapeAttr(f.username)}">INVITE</button><button class="btn secondary friend-remove" data-user="${escapeAttr(f.username)}">REMOVE</button></div>`).join("") : '<div class="admin-empty">No friends yet. Add someone by username.</div>';
  box.querySelectorAll('.friend-remove').forEach(b=>wireButton(b,()=>send({type:'remove_friend',token:authToken,username:b.dataset.user})));
  box.querySelectorAll('.friend-invite').forEach(b=>wireButton(b,()=>send({type:'invite_friend',token:authToken,username:b.dataset.user})));
}

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
function animateRouletteResult(number){
  const wheel=$("#roulette-wheel"), ball=$("#roulette-ball");
  if(!wheel) return;
  if(rouletteAnimationTimer) clearTimeout(rouletteAnimationTimer);
  const idx=Math.max(0,ROULETTE_ORDER.indexOf(Number(number)));
  const rotations=6*360 + idx*(360/37);
  wheel.style.setProperty("--target-rotation", rotations+"deg");
  wheel.classList.remove("roulette-spinning"); void wheel.offsetWidth; wheel.classList.add("roulette-spinning");
  if(ball){
    ball.style.setProperty("--ball-rotation", `${rotations*1.35}deg`);
    ball.classList.remove("ball-spinning"); void ball.offsetWidth; ball.classList.add("ball-spinning");
  }
  rouletteAnimationTimer=setTimeout(()=>{wheel.classList.remove("roulette-spinning"); if(ball) ball.classList.remove("ball-spinning");},5200);
}
function renderRouletteState(state){
  rouletteState=state; if(!state) return;
  $("#roulette-room-chip").textContent="ROULETTE " + state.code;
  const me=(state.players||[]).find(x=>x.id===myId);
  const total=Number(me?.total||0);
  $("#roulette-seat-info").textContent=me ? `YOUR BETS: $${total.toLocaleString()}` : "PLACE A BET TO JOIN THE ROUND";
  $("#roulette-total-bets").textContent="$"+total.toLocaleString();
  $("#roulette-balance-meta").textContent=$("#roulette-balance").textContent;
  $("#roulette-player-count").textContent=`${state.players?.length||0}/5`;
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
  if(r && state.phase==='RESULT'){
    animateRouletteResult(r.number);
    const history=$("#roulette-history");
    if(history && !history.dataset.lastTs || history?.dataset.lastTs !== String(r.ts)){
      if(history){ history.dataset.lastTs=String(r.ts); const chip=el("span","history-number",String(r.number)); chip.classList.add(r.number===0?"green":r.color); history.prepend(chip); while(history.children.length>12) history.lastElementChild.remove(); }
    }
  }
}

function renderRouletteHostList(){
  const box=$("#host-list"); if(!box || !rouletteState) return;
  box.innerHTML="";
  (rouletteState.players||[]).forEach(p=>{
    const row=el("div","host-player");
    row.appendChild(el("span",null,p.username+(p.id===myId?" (you)":"")));
    if(p.id===myId) row.appendChild(el("span",null,"HOST"));
    else {
      const b=el("button","kick-btn","KICK");
      wireButton(b,()=>send({type:"kick",targetId:p.id}));
      row.appendChild(b);
    }
    box.appendChild(row);
  });
}

function openRouletteLobby(){ currentGame="roulette"; $("#roulette-room-error").textContent=""; showScreen("#screen-roulette-lobby"); send({type:"public_tables",game:"roulette"}); }
function openBlackjackLobby(){ currentGame="blackjack"; $("#room-error").textContent=""; showScreen("#screen-lobby"); send({type:"public_tables",game:"blackjack"}); }

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

function initSettings() {
  const savedDark = localStorage.getItem("bj_dark") === "1";
  applyTheme(savedDark);
  const savedSound = localStorage.getItem("bj_sound") !== "0";
  applySound(savedSound);
  const savedVol = parseInt(localStorage.getItem("bj_volume") || "60", 10);
  applyVolume(savedVol);
  const savedScale = parseInt(localStorage.getItem("bj_scale") || "100", 10);
  applyScale(savedScale);

  $("#toggle-sound").addEventListener("click", () => {
    applySound(!soundEnabled); play("click");
  });
  $("#toggle-dark").addEventListener("click", () => {
    play("click");
    applyTheme(!(document.documentElement.getAttribute("data-theme") === "dark"));
  });
  $("#slider-volume").addEventListener("input", (e) => applyVolume(parseInt(e.target.value, 10)));
  $("#slider-scale").addEventListener("input", (e) => applyScale(parseInt(e.target.value, 10)));

  wireButton($("#btn-settings"), () => { $("#btn-leave-table").classList.remove("hidden"); $("#settings-overlay").classList.add("open"); });
  wireButton($("#btn-settings-menu"), () => { $("#btn-leave-table").classList.add("hidden"); $("#settings-overlay").classList.add("open"); });
  wireButton($("#btn-settings-close"), () => $("#settings-overlay").classList.remove("open"));
  wireButton($("#btn-settings-appearance"), () => {
    $("#settings-overlay").classList.remove("open");
    $("#appearance-overlay").classList.add("open");
    send({type:"store",token:authToken});
    renderAppearance();
  });
  wireButton($("#btn-appearance-close"), () => $("#appearance-overlay").classList.remove("open"));
  wireButton($("#btn-appearance-store"), () => {
    $("#appearance-overlay").classList.remove("open");
    openProgress("#store-overlay");
    send({type:"store",token:authToken});
  });
  wireButton($("#btn-leave-table"), () => { send({type:"leave_table"}); });
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
  wireButton($("#btn-join-table"), () => {
    const room = $("#input-room").value.trim() || "public";
    $("#room-error").textContent = "";
    send({ type: "join", token: authToken, room, game:"blackjack" });
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

  wireButton($("#btn-profile"), () => { openProgress("#profile-overlay"); renderProfile(); send({type:"profile", token:authToken}); });
  wireButton($("#btn-profile-close"), () => closeProgress("#profile-overlay"));
  wireButton($("#btn-friends"), () => { openProgress("#friends-overlay"); $("#friends-error").textContent=""; send({type:"friends",token:authToken}); });
  wireButton($("#btn-friends-close"), () => closeProgress("#friends-overlay"));
  wireButton($("#btn-add-friend"), () => { $("#friends-error").textContent=""; send({type:"add_friend",token:authToken,username:$("#friend-username").value.trim()}); });
  wireButton($("#btn-create-public"), () => send({type:"create_public",token:authToken,game:"blackjack"}));
  wireButton($("#btn-roulette-create"), () => send({type:"create_public",token:authToken,game:"roulette"}));
  wireButton($("#btn-roulette-join"), () => send({type:"join",token:authToken,room:$("#roulette-room").value.trim() || "PUBLIC",game:"roulette"}));
  wireButton($("#btn-roulette-back"), showMainMenu);
  wireButton($("#roulette-clear"), () => send({type:"roulette_clear"}));
  wireButton($("#roulette-chip-amount"), () => { const vals=[100,500,1000,5000]; rouletteBetAmount=vals[(vals.indexOf(rouletteBetAmount)+1)%vals.length]; $("#roulette-chip-amount").textContent="$"+rouletteBetAmount.toLocaleString(); $("#roulette-chip-amount").classList.add("selected-chip"); });
  wireButton($("#roulette-spin"), () => send({type:"roulette_spin"}));
  wireButton($("#roulette-leave"), () => send({type:"leave_table"}));
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
  wireButton($("#btn-store"), () => { openProgress("#store-overlay"); send({type:"store", token:authToken}); });
  wireButton($("#btn-season"), () => { openProgress("#season-overlay"); send({type:"season", token:authToken}); });
  wireButton($("#btn-stats-close"), () => closeProgress("#stats-overlay"));
  wireButton($("#btn-rankings-close"), () => closeProgress("#leaderboard-overlay"));
  wireButton($("#btn-achievements-close"), () => closeProgress("#achievements-overlay"));
  wireButton($("#btn-daily-close"), () => closeProgress("#daily-overlay"));
  wireButton($("#btn-store-close"), () => closeProgress("#store-overlay"));
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
$("#btn-chat-mute").textContent = chatMuted ? "🔇" : "🔊";
if (localStorage.getItem("bj_session_token")) { setTimeout(() => { if (!ws || ws.readyState === WebSocket.CLOSED) connect(); }, 50); }
