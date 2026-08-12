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
    if (authMode === "login") {
      send({ type: "login", username: $("#auth-username").value.trim(), password: $("#auth-password").value });
    } else {
      send({ type: "signup", username: $("#auth-username").value.trim(), password: $("#auth-password").value });
    }
  });
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "auth_ok") {
      authToken = msg.token;
      loggedUsername = msg.username;
      $("#welcome-user").textContent = `Welcome, ${loggedUsername}`;
      $("#auth-form").classList.add("hidden");
      $("#room-form").classList.remove("hidden");
      $("#menu-balance").textContent = "$" + msg.balance;
      $("#join-error").textContent = "";
      showMainMenu();
      localStorage.setItem("bj_username_hint", loggedUsername);
      return;
    }
    if (msg.type === "joined") {
      myId = msg.id;
      myRoom = msg.room;
      $("#room-chip").textContent = "TABLE " + myRoom;
      $("#profile-name").textContent = msg.username || loggedUsername || "PLAYER";
      $("#menu-balance").textContent = "$" + msg.balance;
      $("#btn-admin-float").classList.toggle("hidden", !isAdmin);
      showScreen("#screen-table");
      play("join");
      return;
    }
    if (msg.type === "left_table") {
      myId = null; myRoom = null; lastState = null;
      $("#settings-overlay").classList.remove("open");
      $("#claim-overlay").classList.remove("open");
      $("#admin-overlay").classList.remove("open");
      $("#menu-balance").textContent = $("#balance-chip").textContent || "$0";
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
      renderAdminUsers(msg.users || [], msg.tablePlayers || [], msg.dealerPreviewActive, msg.dealerPreview);
      return;
    }
    if (msg.type === "error") {
      const target = msg.scope === "auth" ? $("#join-error") : (msg.scope === "admin" ? $("#admin-error") : $("#room-error"));
      target.textContent = msg.message;
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
    $("#btn-admin-float").classList.toggle("hidden", !isAdmin);
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

  if (state.phase === "BETTING" && me) {
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
    if (state.phase === "PLAYING") {
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

function renderAdminUsers(users, tablePlayers = [], previewActive = false, preview = null) {
  const box = $("#admin-users");
  box.innerHTML = "";
  const title = el("div", "admin-section-title", "PLAYERS AT THIS TABLE"); box.appendChild(title);
  if (!tablePlayers.length) box.appendChild(el("div", "admin-empty", "No players currently at this table."));
  tablePlayers.forEach((u) => {
    const row = el("div", "admin-user");
    const info = el("div", null, `${u.username}  •  $${u.money}`);
    const actions = el("div", "admin-user-actions");
    const input = document.createElement("input"); input.type="number"; input.min="1"; input.placeholder="Amount";
    const add = el("button", "kick-btn", "GIVE");
    const lucky = el("button", "kick-btn", u.lucky ? "LUCKY ON" : "LUCKY OFF");
    add.addEventListener("click",()=>{const n=parseInt(input.value,10);if(n>0)send({type:"admin_give_table_money",targetId:u.id,amount:n});});
    lucky.addEventListener("click",()=>send({type:"admin_toggle_lucky",targetId:u.id,enabled:!u.lucky}));
    actions.append(input,add,lucky); row.append(info,actions); box.appendChild(row);
  });
  $("#admin-preview-toggle").classList.toggle("on", !!previewActive);
  const pv=$("#admin-preview"); pv.innerHTML="";
  if(previewActive && preview){
    pv.appendChild(el("div","admin-section-title","DEALER PREVIEW"));
    const hand=el("div","admin-preview-cards"); preview.forEach(c=>hand.appendChild(buildCard(c))); pv.appendChild(hand);
  }
}


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
  wireButton($("#btn-settings-admin"), () => {
    $("#settings-overlay").classList.remove("open");
    $("#admin-overlay").classList.add("open");
    $("#admin-error").textContent = "";
    $("#admin-login-box").classList.toggle("hidden", isAdmin);
    $("#admin-dashboard").classList.toggle("hidden", !isAdmin);
    if (isAdmin) {
      send({type:"admin_data"});
    } else {
      $("#admin-password").value = "";
      setTimeout(() => $("#admin-password").focus(), 120);
    }
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
  wireButton($("#btn-play"), () => {
    $("#room-error").textContent = "";
    showScreen("#screen-lobby");
  });
  wireButton($("#btn-join-table"), () => {
    const room = $("#input-room").value.trim() || "public";
    $("#room-error").textContent = "";
    send({ type: "join", token: authToken, room });
  });
  wireButton($("#btn-back-menu"), () => {
    $("#room-error").textContent = "";
    showMainMenu();
  });
  wireButton($("#btn-logout"), () => {
    authToken = null; loggedUsername = null; myId = null; myRoom = null; isAdmin = false;
    document.querySelector("#screen-join .auth-card").classList.remove("main-menu-mode");
    $("#btn-admin-float").classList.add("hidden");
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
  wireButton($("#btn-admin-float"), () => {
    $("#settings-overlay").classList.remove("open");
    $("#admin-overlay").classList.add("open");
    $("#admin-login-box").classList.toggle("hidden", isAdmin);
    $("#admin-dashboard").classList.toggle("hidden", !isAdmin);
    if (isAdmin) send({type:"admin_data"});
    else setTimeout(() => $("#admin-password").focus(), 120);
  });
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
}

initSettings();
initControls();
initJoin();
