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
  win: () => { tone(660, 0.35, "sine", 220, 0.45); },
  lose: () => tone(180, 0.4, "sine", -80, 0.45),
  bust: () => tone(140, 0.35, "square", -60, 0.45),
  push: () => tone(420, 0.2, "sine", 0, 0.3),
  pity: () => { tone(500, 0.15, "sine", 100, 0.4); setTimeout(() => tone(700, 0.25, "sine", 150, 0.4), 120); },
};
function play(name) {
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
  const wasCount = container.childElementCount;
  container.innerHTML = "";
  cards.forEach((c) => container.appendChild(buildCard(c, small)));
  if (cards.length > wasCount) play("deal");
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
    wireButton(btn, () => send({ type: "chip", amount }));
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
      $("#join-error").textContent = "";
      localStorage.setItem("bj_username_hint", loggedUsername);
      return;
    }
    if (msg.type === "joined") {
      myId = msg.id;
      myRoom = msg.room;
      $("#room-chip").textContent = "TABLE " + myRoom;
      $("#profile-name").textContent = msg.username || loggedUsername || "PLAYER";
      showScreen("#screen-table");
      return;
    }
    if (msg.type === "kicked") {
      if (ws) ws.close();
      $("#room-error").textContent = msg.message || "You were kicked.";
      showScreen("#screen-join");
      $("#auth-form").classList.add("hidden");
      $("#room-form").classList.remove("hidden");
      return;
    }
    if (msg.type === "balance") {
      $("#balance-chip").textContent = "$" + msg.balance;
      return;
    }
    if (msg.type === "admin_ok") {
      isAdmin = true;
      $("#admin-login-box").classList.add("hidden");
      $("#admin-dashboard").classList.remove("hidden");
      return;
    }
    if (msg.type === "admin_data") {
      renderAdminUsers(msg.users || []);
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
    showScreen("#screen-join");
    $("#auth-form").classList.add("hidden");
    $("#room-form").classList.remove("hidden");
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
    $("#profile-name").textContent = me.username || loggedUsername || me.name;
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
    play("win");
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

function renderAdminUsers(users) {
  const box = $("#admin-users");
  box.innerHTML = "";
  users.forEach((u) => {
    const row = el("div", "admin-user");
    const info = el("div", null, `${u.username}  •  $${u.money}`);
    const actions = el("div", "admin-user-actions");
    const input = document.createElement("input");
    input.type = "number"; input.min = "0"; input.placeholder = "Amount";
    const add = el("button", "kick-btn", "+ MONEY");
    const set = el("button", "kick-btn", "SET");
    const reset = el("button", "kick-btn", "RESET");
    add.addEventListener("click", () => {
      const n = parseInt(input.value, 10); if (n > 0) send({type:"admin_add_money", username:u.username, amount:n});
    });
    set.addEventListener("click", () => {
      const n = parseInt(input.value, 10); if (Number.isFinite(n)) send({type:"admin_set_money", username:u.username, amount:n});
    });
    reset.addEventListener("click", () => send({type:"admin_reset_money", username:u.username}));
    actions.append(input, add, set, reset);
    row.append(info, actions);
    box.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Settings (dark mode + volume) — persisted locally for convenience
// ---------------------------------------------------------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  $("#toggle-dark").classList.toggle("on", dark);
  localStorage.setItem("bj_dark", dark ? "1" : "0");
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
  const savedVol = parseInt(localStorage.getItem("bj_volume") || "60", 10);
  applyVolume(savedVol);
  const savedScale = parseInt(localStorage.getItem("bj_scale") || "100", 10);
  applyScale(savedScale);

  $("#toggle-dark").addEventListener("click", () => {
    play("click");
    applyTheme(!(document.documentElement.getAttribute("data-theme") === "dark"));
  });
  $("#slider-volume").addEventListener("input", (e) => applyVolume(parseInt(e.target.value, 10)));
  $("#slider-scale").addEventListener("input", (e) => applyScale(parseInt(e.target.value, 10)));

  wireButton($("#btn-settings"), () => $("#settings-overlay").classList.add("open"));
  wireButton($("#btn-settings-close"), () => $("#settings-overlay").classList.remove("open"));
  wireButton($("#btn-leave-table"), () => {
    if (ws) ws.close();
    location.reload();
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
  wireButton($("#btn-hit"), () => send({ type: "hit" }));
  wireButton($("#btn-stand"), () => send({ type: "stand" }));
  wireButton($("#btn-double"), () => send({ type: "double" }));
}

function initJoin() {
  $("#auth-username").value = localStorage.getItem("bj_username_hint") || "";
  $("#tab-login").addEventListener("click", () => setAuthMode("login"));
  $("#tab-signup").addEventListener("click", () => setAuthMode("signup"));
  wireButton($("#btn-auth"), loginOrSignup);
  wireButton($("#btn-join"), () => {
    const room = $("#input-room").value.trim() || "public";
    $("#room-error").textContent = "";
    send({ type: "join", token: authToken, room });
  });
  wireButton($("#btn-logout"), () => {
    authToken = null; loggedUsername = null; myId = null;
    if (ws) ws.close();
    location.reload();
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
  wireButton($("#btn-admin-open"), () => {
    $("#admin-overlay").classList.add("open");
    $("#admin-login-box").classList.toggle("hidden", isAdmin);
    $("#admin-dashboard").classList.toggle("hidden", !isAdmin);
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
