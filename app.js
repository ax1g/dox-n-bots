const canvas = document.querySelector("#board");
const ctx = canvas.getContext("2d");
const $ = (selector) => document.querySelector(selector);
const localKey = "dox-n-bots-scores";
const themeKey = "dox-n-bots-theme";
let sound = true;
let audio;
let game;
let hover = null;
let mode = null;
let socket;
let seat;
let roomId;
let roomToken = null;
let leftRoom = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastServerMessage = 0;
let reportedResult = false;
let pendingEdge = null;
let syncedRoom = null;
let lastMine = null;
let lastRival = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const id = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const edgeList = () => {
  const out = [];
  for (let y = 0; y < game.rows; y++)
    for (let x = 0; x < game.cols; x++) {
      const a = y * game.cols + x;
      if (x < game.cols - 1) out.push([a, a + 1]);
      if (y < game.rows - 1) out.push([a, a + game.cols]);
    }
  return out;
};
const tone = (frequency, duration = 0.045, type = "sine", volume = 0.13) => {
  if (!sound) return;
  audio ??= new AudioContext();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, audio.currentTime);
  gain.gain.setValueAtTime(volume, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + duration);
};
const CLAIM = "sounds/mixkit-arcade-rising-231.wav";
const WIN = "sounds/mixkit-game-level-completed-2059.wav";
const GAME_OVER = "sounds/alphix-game-over-417465.mp3";
const samples = {};
const sample = (file, volume = 0.5, rate = 1) => {
  if (!sound) return;
  try {
    const el = (samples[file] ??= new Audio(file));
    el.volume = volume;
    el.playbackRate = rate;
    el.currentTime = 0;
    el.play().catch(() => {});
  } catch {}
};
const clickSound = () => {
  tone(520, 0.03, "sine", 0.06);
};
const drawSound = (mine) => tone(mine ? 660 : 420, 0.05, "triangle", 0.12);
const claimSound = (mine) => {
  tone(mine ? 780 : 540, 0.07, "triangle", 0.14);
  setTimeout(() => tone(mine ? 990 : 680, 0.06, "sine", 0.1), 45);
};
const color = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#theme").textContent = `DARK: ${dark ? "ON" : "OFF"}`;
  $("#theme").setAttribute("aria-pressed", String(dark));
  localStorage.setItem(themeKey, dark ? "dark" : "light");
  draw();
}

function showScreen(name) {
  document
    .querySelectorAll(".screen")
    .forEach((screen) => screen.classList.toggle("active", screen.id === name));
  if (name === "scores") loadScores();
  if (name === "game") requestAnimationFrame(draw);
  if (name !== "game") {
    leftRoom = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    $("#room-notice").hidden = true;
    if (socket) {
      socket.close();
      socket = null;
    }
  }
  if (name !== "game") hideResult();
}

function hideResult() {
  $("#result").classList.remove("show");
  $("#result").setAttribute("aria-hidden", "true");
}
function showResult(result, score, winner) {
  const overlay = $("#result");
  const confetti = $("#confetti");
  $("#result-kicker").textContent = winner
    ? "GRID DOMINATED"
    : "MATCH COMPLETE";
  $("#result-title").innerHTML =
    result === "DRAW"
      ? "IT'S A<br><em>DRAW.</em>"
      : winner
        ? "YOU<br><em>WIN.</em>"
        : "RIVAL<br><em>WINS.</em>";
  $("#result-copy").textContent =
    `${score} BOX${score === 1 ? "" : "ES"} CLAIMED. PLAY AGAIN?`;
  confetti.replaceChildren();
  for (let index = 0; index < 42; index++) {
    const piece = document.createElement("i");
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.setProperty(
      "--drift",
      `${Math.round((Math.random() - 0.5) * 260)}px`,
    );
    piece.style.animationDelay = `${Math.random() * 0.35}s`;
    confetti.append(piece);
  }
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
  if (winner) sample(WIN, 0.6);
  else if (result === "DRAW") sample(WIN, 0.4);
  else sample(GAME_OVER, 0.6);
}

function dimensions(cols, rows) {
  return {
    cols: clamp(Math.round(Number(cols) || 5), 2, 10),
    rows: clamp(Math.round(Number(rows) || 5), 2, 10),
  };
}
function createGame(cols, rows, names = { player: "YOU", rival: "BOT" }) {
  return {
    ...dimensions(cols, rows),
    edges: new Set(),
    boxes: new Map(),
    player: 0,
    bot: 0,
    playerTurn: true,
    finished: false,
    names,
    status: "active",
  };
}
function dot(index) {
  return { x: index % game.cols, y: Math.floor(index / game.cols) };
}
function geometry() {
  const rect = canvas.getBoundingClientRect();
  const ratio = devicePixelRatio || 1;
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const pad = Math.max(16, Math.min(rect.width, rect.height) * 0.06);
  return {
    w: rect.width,
    h: rect.height,
    pad,
    sx: (rect.width - pad * 2) / (game.cols - 1),
    sy: (rect.height - pad * 2) / (game.rows - 1),
    ox: pad,
    oy: pad,
  };
}
function point(index, layout) {
  const position = dot(index);
  return {
    x: layout.ox + position.x * layout.sx,
    y: layout.oy + position.y * layout.sy,
  };
}
function boxEdges(x, y) {
  const a = y * game.cols + x;
  return [
    id(a, a + 1),
    id(a, a + game.cols),
    id(a + 1, a + game.cols + 1),
    id(a + game.cols, a + game.cols + 1),
  ];
}
function completed(edge) {
  const [a, b] = edge;
  const first = dot(a);
  const second = dot(b);
  const candidates = [];
  if (first.y === second.y) {
    for (const y of [first.y - 1, first.y])
      if (y >= 0 && y < game.rows - 1)
        candidates.push([Math.min(first.x, second.x), y]);
  } else {
    for (const x of [first.x - 1, first.x])
      if (x >= 0 && x < game.cols - 1)
        candidates.push([x, Math.min(first.y, second.y)]);
  }
  return candidates.filter(
    ([x, y]) =>
      !game.boxes.has(`${x}:${y}`) &&
      boxEdges(x, y).every((item) => game.edges.has(item)),
  );
}

function draw() {
  if (!game || !$("#game").classList.contains("active")) return;
  const layout = geometry();
  ctx.clearRect(0, 0, layout.w, layout.h);
  for (const [key, owner] of game.boxes) {
    const [x, y] = key.split(":").map(Number);
    ctx.fillStyle =
      owner === "player" || owner === seat
        ? color("--claimed-player")
        : color("--claimed-rival");
    ctx.fillRect(
      layout.ox + x * layout.sx + 4,
      layout.oy + y * layout.sy + 4,
      layout.sx - 8,
      layout.sy - 8,
    );
    const claimer =
      owner === "player" || owner === seat
        ? game.names.player
        : game.names.rival;
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${clamp(Math.min(layout.sx, layout.sy) * 0.2, 10, 24)}px "Barlow Condensed"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      claimer.slice(0, 8).toUpperCase(),
      layout.ox + (x + 0.5) * layout.sx,
      layout.oy + (y + 0.5) * layout.sy,
      layout.sx - 12,
    );
  }
  const line = (edge, color, width = 4) => {
    const [a, b] = edge;
    const p = point(a, layout);
    const q = point(b, layout);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  };
  edgeList().forEach((edge) => {
    if (game.edges.has(id(...edge))) line(edge, color("--ink"), 5);
  });
  if (lastRival && game.edges.has(id(...lastRival)))
    line(lastRival, color("--claimed-rival"), 6);
  if (lastMine && game.edges.has(id(...lastMine)))
    line(lastMine, color("--claimed-player"), 6);
  if (hover && !game.edges.has(id(...hover))) line(hover, color("--hover"), 6);
  for (let index = 0; index < game.cols * game.rows; index++) {
    const p = point(index, layout);
    ctx.fillStyle = color("--ink");
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  $("#player-score b").textContent = game.player;
  $("#bot-score b").textContent = game.bot;
  $("#player-score").firstChild.textContent = `${game.names.player} `;
  $("#bot-score").firstChild.textContent = `${game.names.rival} `;
  $("#turn").textContent = game.finished
    ? "GAME OVER"
    : game.status !== "active"
      ? game.status.toUpperCase()
      : game.playerTurn
        ? "YOUR TURN"
        : mode === "online"
          ? "RIVAL TURN"
          : "BOT THINKING";
  const wrap = document.querySelector(".board-wrap");
  wrap.classList.toggle("turn-mine", !game.finished && game.playerTurn);
  wrap.classList.toggle("turn-rival", !game.finished && !game.playerTurn);
}

function chooseHover(event) {
  if (!game || game.finished || !game.playerTurn || game.status !== "active")
    return null;
  const rect = canvas.getBoundingClientRect();
  const layout = geometry();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let closest = null;
  let best = Infinity;
  for (const edge of edgeList()) {
    if (game.edges.has(id(...edge))) continue;
    const [a, b] = edge;
    const p = point(a, layout);
    const q = point(b, layout);
    const vx = q.x - p.x;
    const vy = q.y - p.y;
    const t = clamp(
      ((x - p.x) * vx + (y - p.y) * vy) / (vx * vx + vy * vy),
      0,
      1,
    );
    const distance = Math.hypot(x - (p.x + t * vx), y - (p.y + t * vy));
    if (distance < best) {
      best = distance;
      closest = edge;
    }
  }
  return best < (event.pointerType === "touch"
    ? Math.max(44, Math.min(layout.sx, layout.sy) * 0.5)
    : Math.max(28, Math.min(layout.sx, layout.sy) * 0.38))
    ? closest
    : null;
}
function endLocalGame() {
  const result =
    game.player === game.bot
      ? "DRAW"
      : game.player > game.bot
        ? "YOU WIN"
        : "BOT WINS";
  const winner = result === "YOU WIN";
  $("#board-hint").textContent =
    `${result}. ${game.player} BOXES FOR ${game.names.player}.`;
  showResult(result, game.player, winner);
  saveScore(
    game.names.player,
    game.player,
    game.cols,
    game.rows,
    game.names.rival,
    result === "YOU WIN"
      ? game.names.player
      : result === "BOT WINS"
        ? game.names.rival
        : "DRAW",
    Math.abs(game.player - game.bot),
    "SOLO",
    $("#difficulty").value.toUpperCase(),
  );
}
function take(edge, owner) {
  game.edges.add(id(...edge));
  const won = completed(edge);
  won.forEach(([x, y]) => game.boxes.set(`${x}:${y}`, owner));
  if (owner === "player") {
    game.player += won.length;
    lastMine = edge;
  } else {
    game.bot += won.length;
    lastRival = edge;
  }
  if (won.length) claimSound(owner === "player");
  else drawSound(owner === "player");
  if (!won.length) game.playerTurn = !game.playerTurn;
  if (game.boxes.size === (game.cols - 1) * (game.rows - 1)) {
    game.finished = true;
    endLocalGame();
  }
  draw();
  if (!game.playerTurn && !game.finished) setTimeout(botMove, 360);
}
function risk(edge) {
  const temporary = new Set(game.edges);
  temporary.add(id(...edge));
  let thirds = 0;
  for (let y = 0; y < game.rows - 1; y++)
    for (let x = 0; x < game.cols - 1; x++)
      if (boxEdges(x, y).filter((item) => temporary.has(item)).length === 3)
        thirds++;
  return thirds;
}
function botMove() {
  if (!game || game.playerTurn || game.finished || mode !== "solo") return;
  const available = edgeList().filter((edge) => !game.edges.has(id(...edge)));
  const scoring = available.filter((edge) => completed(edge).length);
  let choice;
  const level = $("#difficulty").value;
  if (level === "noob")
    choice = available[Math.floor(Math.random() * available.length)];
  else if (scoring.length)
    choice = scoring.sort(
      (a, b) => completed(b).length - completed(a).length,
    )[0];
  else
    choice = available.sort(
      (a, b) =>
        risk(a) - risk(b) + (level === "casual" ? Math.random() * 0.7 : 0),
    )[0];
  take(choice, "bot");
}

async function saveScore(
  name,
  score,
  width,
  height,
  opponent = "BOT",
  winner = "BOT",
  margin = 0,
  gameMode = "SOLO",
  detail = "CASUAL",
) {
  const payload = {
    name,
    score,
    width,
    height,
    opponent,
    winner,
    margin,
    mode: gameMode,
    detail,
  };
  const local = JSON.parse(localStorage.getItem(localKey) || "[]");
  local.push(payload);
  localStorage.setItem(localKey, JSON.stringify(local));
  try {
    await fetch("/api/leaderboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {}
}
async function loadScores() {
  let scores;
  try {
    const response = await fetch("/api/leaderboard");
    if (!response.ok) throw Error();
    scores = await response.json();
  } catch {
    scores = JSON.parse(localStorage.getItem(localKey) || "[]")
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }
  const template = $("#score-row");
  const entries = scores.length
    ? scores
    : [{ name: "BE THE FIRST", score: "---" }];
  [$("#landing-scores"), $("#score-list")].forEach((list) => {
    list.replaceChildren();
    entries
      .slice(0, list.id === "landing-scores" ? 5 : 20)
      .forEach((entry, index) => {
        const row = template.content.cloneNode(true);
        const rank = row.querySelector(".rank");
        rank.textContent = `#${index + 1}`;
        rank.classList.toggle(`rank-${index + 1}`, index < 3);
        row.querySelector(".score-name").textContent =
          entry.score === "---"
            ? entry.name
            : `${entry.name} vs ${entry.opponent || "BOT"}`;
        const date = entry.created_at
          ? new Date(`${entry.created_at}Z`).toISOString().slice(0, 10)
          : "LOCAL";
        const margin = Number(entry.margin || 0);
        row.querySelector(".match-result").textContent =
          entry.score === "---"
            ? "START THE FIRST MATCH"
            : entry.winner === "BOT" && margin === 0
              ? `${date}  ARCHIVED SCORE`
              : `${date}  ${entry.winner || entry.name} won by ${margin} box${margin === 1 ? "" : "es"}`;
        row.querySelector(".mode-pill").textContent = entry.mode || "SOLO";
        row.querySelector(".size-pill").textContent =
          `${entry.width || "?"}x${entry.height || "?"}`;
        row.querySelector(".detail-pill").textContent =
          entry.detail || "CASUAL";
        row.querySelector(".score-points").textContent =
          entry.score === "---"
            ? "---"
            : `${entry.score} BOX${entry.score === 1 ? "" : "ES"}`;
        list.append(row);
      });
  });
}

function applyRemoteState(state) {
  const mine = state.players[seat];
  const rivalSeat = seat === "p1" ? "p2" : "p1";
  const rival = state.players[rivalSeat];
  const prev = game;
  game = {
    cols: state.cols,
    rows: state.rows,
    edges: new Set(state.edges),
    boxes: new Map(Object.entries(state.boxes)),
    player: state.scores[seat],
    bot: state.scores[rivalSeat],
    playerTurn: state.turn === seat,
    finished: state.status === "finished",
    status: state.status,
    names: { player: mine.name, rival: rival?.name || "WAITING" },
  };
  if (mode === "online" && prev && syncedRoom === roomId && !game.finished) {
    const fresh = [...game.edges].filter((edge) => !prev.edges.has(edge));
    const claimed = game.boxes.size > prev.boxes.size;
    const echoIndex = pendingEdge ? fresh.indexOf(pendingEdge) : -1;
    if (echoIndex >= 0) {
      lastMine = fresh[echoIndex].split(":").map(Number);
      pendingEdge = null;
      fresh.splice(echoIndex, 1);
    }
    if (fresh.length) {
      lastRival = fresh[fresh.length - 1].split(":").map(Number);
      if (claimed) claimSound(false);
      else drawSound(false);
    }
  }
  syncedRoom = roomId;
  const notice = $("#room-notice");
  if (mode === "online" && !game.finished && state.status !== "active") {
    notice.textContent =
      state.status === "waiting"
        ? "WAITING FOR YOUR RIVAL - SHARE YOUR INVITE LINK"
        : "YOUR RIVAL LEFT - THEY CAN REJOIN WITH THE SAME LINK";
    notice.hidden = false;
    if (state.status === "paused" && prev?.status !== "paused")
      tone(220, 0.15, "triangle", 0.1);
  } else notice.hidden = true;
  $("#board-hint").textContent =
    state.status === "waiting"
      ? `ROOM ${roomId}: WAITING FOR RIVAL`
      : state.status === "paused"
        ? "RIVAL DISCONNECTED - MATCH PAUSED"
        : `ROOM ${roomId}: ${rival?.connected ? "RIVAL CONNECTED" : "RIVAL DISCONNECTED"}`;
  if (game.finished && !reportedResult) {
    reportedResult = true;
    const result =
      game.player === game.bot
        ? "DRAW"
        : game.player > game.bot
          ? "YOU WIN"
          : "RIVAL WINS";
    $("#board-hint").textContent = `${result}. ${game.player} BOXES.`;
    showResult(result, game.player, result === "YOU WIN");
    saveScore(
      mine.name,
      game.player,
      game.cols,
      game.rows,
      rival?.name || "RIVAL",
      result === "YOU WIN"
        ? mine.name
        : result === "RIVAL WINS"
          ? rival?.name || "RIVAL"
          : "DRAW",
      Math.abs(game.player - game.bot),
      "ONLINE",
      "FRIEND",
    );
  }
  draw();
}
function inviteLink() {
  return `${location.origin}${location.pathname}?room=${roomId}`;
}
function scheduleReconnect() {
  if (leftRoom || game?.finished || mode !== "online") return;
  if (!$("#game").classList.contains("active")) return;
  if (reconnectAttempts >= 10) {
    $("#board-hint").textContent =
      "CONNECTION LOST. LEAVE AND REJOIN WITH YOUR INVITE LINK.";
    return;
  }
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
  reconnectAttempts++;
  $("#board-hint").textContent = "RECONNECTING...";
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!leftRoom) connectRoom(roomToken, true);
  }, delay);
}
function connectRoom(token, retry = false) {
  roomToken = token;
  leftRoom = false;
  if (!retry) {
    reconnectAttempts = 0;
    sessionStorage.setItem("dox-room", JSON.stringify({ roomId, seat, token }));
  }
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(
    `${scheme}://${location.host}/ws/rooms/${roomId}?token=${encodeURIComponent(token)}`,
  );
  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    lastServerMessage = Date.now();
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastServerMessage > 40000) socket.close();
      else socket.send(JSON.stringify({ type: "ping" }));
    }, 20000);
  });
  socket.addEventListener("message", (event) => {
    lastServerMessage = Date.now();
    const message = JSON.parse(event.data);
    if (message.type === "state") applyRemoteState(message);
    else if (message.type === "pong") return;
    else if (message.type === "error") {
      $("#board-hint").textContent = message.message;
      tone(110, 0.12, "sawtooth");
    }
  });
  socket.addEventListener("close", (event) => {
    clearInterval(heartbeatTimer);
    socket = null;
    if (leftRoom || game?.finished || event.code === 1008) return;
    scheduleReconnect();
  });
}
async function createRoom(event) {
  event.preventDefault();
  const name = $("#online-name").value.trim();
  if (name.length < 3) {
    $("#online-message").textContent = "NAME NEEDS 3-50 CHARACTERS.";
    tone(110, 0.12, "sawtooth");
    return;
  }
  const { cols, rows } = dimensions(
    $("#online-cols").value,
    $("#online-rows").value,
  );
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, cols, rows }),
    });
    if (!response.ok) throw Error();
    const room = await response.json();
    roomId = room.room_id;
    seat = room.seat;
    mode = "online";
    reportedResult = false;
    pendingEdge = null;
    syncedRoom = null;
    lastMine = null;
    lastRival = null;
    $("#room-code").value = roomId;
    $("#copy-room").hidden = false;
    $("#board-hint").textContent =
      `ROOM ${roomId}: SHARE YOUR INVITE LINK, THEN WAIT.`;
    showScreen("game");
    connectRoom(room.token);
  } catch {
    $("#online-message").textContent = "COULD NOT REACH THE GAME SERVER.";
    tone(110, 0.12, "sawtooth");
  }
}
async function joinRoom() {
  const name = $("#online-name").value.trim();
  let code = $("#room-code").value.trim().toUpperCase();
  const linkMatch = code.match(/ROOM=([A-Z0-9]+)/);
  if (linkMatch) code = linkMatch[1];
  if (name.length < 3 || !code) {
    $("#online-message").textContent = "ENTER YOUR NAME AND A ROOM CODE.";
    tone(110, 0.12, "sawtooth");
    return;
  }
  try {
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(code)}/join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (!response.ok) {
      $("#online-message").textContent =
        response.status === 410
          ? "THAT MATCH HAS ENDED. CREATE A NEW ROOM."
          : response.status === 409
            ? "ROOM IS FULL. WAIT FOR A SEAT TO FREE UP."
            : "ROOM NOT FOUND. CHECK THE CODE OR LINK.";
      tone(110, 0.12, "sawtooth");
      return;
    }
    const room = await response.json();
    roomId = room.room_id;
    seat = room.seat;
    mode = "online";
    reportedResult = false;
    pendingEdge = null;
    syncedRoom = null;
    lastMine = null;
    lastRival = null;
    history.replaceState(null, "", location.pathname);
    $("#copy-room").hidden = true;
    showScreen("game");
    connectRoom(room.token);
  } catch {
    $("#online-message").textContent = "ROOM NOT FOUND OR ALREADY FULL.";
    tone(110, 0.12, "sawtooth");
  }
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button,[data-screen]");
  if (!target) return;
  clickSound(target);
  const destination = target.dataset.screen;
  if (destination) {
    hover = null;
    showScreen(destination);
  }
});
document.addEventListener("change", (event) => {
  if (event.target.matches("input,select")) tone(260, 0.03, "sine");
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-grid-size]");
  if (!button) return;
  const toggle = button.closest(".size-toggle");
  const prefix = toggle.dataset.sizeFor === "online" ? "online-" : "";
  toggle.querySelectorAll("[data-grid-size]").forEach((option) => {
    option.setAttribute("aria-pressed", String(option === button));
  });
  $(`#${prefix}cols`).value = button.dataset.gridSize;
  $(`#${prefix}rows`).value = button.dataset.gridSize;
  tone(360, 0.06, "triangle", 0.14);
  setTimeout(() => tone(540, 0.035, "sine", 0.09), 28);
});
$("#solo-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#name").value.trim();
  if (name.length < 3) {
    $("#message").textContent = "NAME NEEDS 3-50 CHARACTERS.";
    tone(110, 0.12, "sawtooth");
    return;
  }
  const { cols, rows } = dimensions($("#cols").value, $("#rows").value);
  mode = "solo";
  game = createGame(cols, rows, { player: name.toUpperCase(), rival: "BOT" });
  reportedResult = false;
  lastMine = null;
  lastRival = null;
  hideResult();
  $("#board-hint").textContent =
    `VS ${$("#difficulty").value.toUpperCase()} BOT`;
  $("#copy-room").hidden = true;
  showScreen("game");
  tone(420, 0.1, "triangle", 0.1);
});
$("#online-form").addEventListener("submit", createRoom);
$("#join-room").addEventListener("click", joinRoom);
canvas.addEventListener("pointermove", (event) => {
  const next = chooseHover(event);
  if (next && (!hover || id(...next) !== id(...hover)))
    tone(470, 0.018, "sine", 0.035);
  hover = next;
  draw();
});
canvas.addEventListener("pointerleave", () => {
  hover = null;
  draw();
});
const placeEdge = (edge) => {
  if (!game || game.finished || game.status !== "active") return;
  if (!edge) return;
  if (!game.playerTurn) {
    $("#board-hint").textContent =
      `NOT YOUR TURN - WAIT FOR ${game.names.rival}.`;
    tone(140, 0.1, "sawtooth", 0.08);
    return;
  }
  if (mode === "online") {
    pendingEdge = id(...edge);
    drawSound(true);
    socket?.send(JSON.stringify({ type: "move", edge }));
  } else take(edge, "player");
};
canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const edge = chooseHover(event) ?? hover;
  hover = edge;
  placeEdge(edge);
});
$("#copy-room").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteLink());
    $("#board-hint").textContent = "INVITE LINK COPIED. SEND IT TO YOUR FRIEND.";
    tone(610, 0.06, "triangle");
  } catch {
    $("#board-hint").textContent = `SHARE THIS LINK: ${inviteLink()}`;
  }
});
$("#sound").addEventListener("click", () => {
  sound = !sound;
  $("#sound").textContent = `SOUND: ${sound ? "ON" : "OFF"}`;
  $("#sound").setAttribute("aria-pressed", String(sound));
});
$("#theme").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme !== "dark");
  tone(330, 0.08, "triangle", 0.1);
});
window.addEventListener("resize", draw);
setTheme(localStorage.getItem(themeKey) === "dark");
loadScores();
{
  const invited = new URLSearchParams(location.search).get("room");
  if (invited) {
    $("#room-code").value = invited.trim().toUpperCase();
    showScreen("online");
    $("#online-message").textContent =
      `YOU'RE INVITED TO ROOM ${invited.trim().toUpperCase()}. ENTER YOUR NAME AND HIT JOIN ROOM.`;
  }
}
