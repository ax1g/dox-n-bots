"""FastAPI service for the Dox 'n Bots leaderboard and live rooms."""

import asyncio
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DB = Path(__file__).with_name("leaderboard.db")
FRONTEND = Path(__file__).parent.parent
ROOM_TTL = 30 * 60
DISCONNECT_GRACE = 60
rooms: dict[str, "Room"] = {}


class Score(BaseModel):
    name: str = Field(min_length=3, max_length=50)
    score: int = Field(ge=0, le=81)
    width: int = Field(ge=2, le=10)
    height: int = Field(ge=2, le=10)
    opponent: str = Field(default="BOT", min_length=3, max_length=50)
    winner: str = Field(default="BOT", min_length=3, max_length=50)
    margin: int = Field(default=0, ge=0, le=81)
    mode: str = Field(default="SOLO", min_length=3, max_length=20)
    detail: str = Field(default="CASUAL", min_length=3, max_length=20)
    match_id: str = Field(default="", max_length=64)


class CreateRoom(BaseModel):
    name: str = Field(min_length=3, max_length=50)
    cols: int = Field(ge=2, le=10)
    rows: int = Field(ge=2, le=10)


class JoinRoom(BaseModel):
    name: str = Field(min_length=3, max_length=50)


@dataclass
class Player:
    name: str
    token: str
    connected: bool = False
    disconnected_at: float | None = None
    socket: WebSocket | None = None


@dataclass
class Room:
    room_id: str
    cols: int
    rows: int
    players: dict[str, Player]
    edges: set[str] = field(default_factory=set)
    boxes: dict[str, str] = field(default_factory=dict)
    scores: dict[str, int] = field(default_factory=lambda: {"p1": 0, "p2": 0})
    turn: str = "p1"
    status: str = "waiting"
    revision: int = 0
    updated_at: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def snapshot(self):
        return {
            "type": "state",
            "room_id": self.room_id,
            "revision": self.revision,
            "cols": self.cols,
            "rows": self.rows,
            "edges": sorted(self.edges),
            "boxes": self.boxes,
            "scores": self.scores,
            "turn": self.turn,
            "status": self.status,
            "players": {
                seat: {"name": player.name, "connected": player.connected}
                for seat, player in self.players.items()
            },
        }


def edge_id(a: int, b: int) -> str:
    return f"{min(a, b)}:{max(a, b)}"


def box_edges(room: Room, x: int, y: int) -> list[str]:
    a = y * room.cols + x
    return [
        edge_id(a, a + 1),
        edge_id(a, a + room.cols),
        edge_id(a + 1, a + room.cols + 1),
        edge_id(a + room.cols, a + room.cols + 1),
    ]


def completed_boxes(room: Room, a: int, b: int) -> list[str]:
    ax, ay = a % room.cols, a // room.cols
    bx, by = b % room.cols, b // room.cols
    candidates: list[tuple[int, int]] = []
    if ay == by:
        for y in (ay - 1, ay):
            if 0 <= y < room.rows - 1:
                candidates.append((min(ax, bx), y))
    else:
        for x in (ax - 1, ax):
            if 0 <= x < room.cols - 1:
                candidates.append((x, min(ay, by)))
    return [
        f"{x}:{y}"
        for x, y in candidates
        if f"{x}:{y}" not in room.boxes
        and all(edge in room.edges for edge in box_edges(room, x, y))
    ]


def legal_edge(room: Room, a: int, b: int) -> bool:
    limit = room.cols * room.rows
    if not (0 <= a < limit and 0 <= b < limit):
        return False
    ax, ay = a % room.cols, a // room.cols
    bx, by = b % room.cols, b // room.cols
    return abs(ax - bx) + abs(ay - by) == 1


async def broadcast(room: Room):
    payload = room.snapshot()
    stale = []
    for player in room.players.values():
        if player.socket:
            try:
                await player.socket.send_json(payload)
            except RuntimeError:
                stale.append(player)
    for player in stale:
        player.socket = None
        player.connected = False
        player.disconnected_at = time.monotonic()


async def expire_rooms():
    now = time.monotonic()
    for room_id, room in list(rooms.items()):
        async with room.lock:
            disconnected = any(
                player.disconnected_at
                and now - player.disconnected_at > DISCONNECT_GRACE
                for player in room.players.values()
            )
            if room.status in {"active", "paused"} and disconnected:
                room.status = "finished"
                room.revision += 1
                room.updated_at = now
                await broadcast(room)
            if now - room.updated_at > ROOM_TTL:
                del rooms[room_id]


async def room_cleaner():
    while True:
        await asyncio.sleep(10)
        await expire_rooms()


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(room_cleaner())
    yield
    task.cancel()


app = FastAPI(title="Dox 'n Bots API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def connection():
    db = sqlite3.connect(DB)
    db.execute(
        "CREATE TABLE IF NOT EXISTS scores (name TEXT NOT NULL, score INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, opponent TEXT NOT NULL DEFAULT 'BOT', winner TEXT NOT NULL DEFAULT 'BOT', margin INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'SOLO', detail TEXT NOT NULL DEFAULT 'CASUAL', created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    )
    columns = {row[1] for row in db.execute("PRAGMA table_info(scores)")}
    for name, definition in {
        "opponent": "TEXT NOT NULL DEFAULT 'BOT'",
        "winner": "TEXT NOT NULL DEFAULT 'BOT'",
        "margin": "INTEGER NOT NULL DEFAULT 0",
        "mode": "TEXT NOT NULL DEFAULT 'SOLO'",
        "detail": "TEXT NOT NULL DEFAULT 'CASUAL'",
        "match_id": "TEXT NOT NULL DEFAULT ''",
    }.items():
        if name not in columns:
            db.execute(f"ALTER TABLE scores ADD COLUMN {name} {definition}")
    return db


@app.get("/api/leaderboard")
def leaderboard():
    with connection() as db:
        rows = db.execute(
            "SELECT name, score, width, height, opponent, winner, margin, mode, detail, created_at, match_id FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY CASE WHEN match_id = '' THEN 'legacy-' || rowid ELSE match_id END ORDER BY CASE WHEN winner = name THEN 0 ELSE 1 END, score DESC, rowid ASC) AS rn FROM scores) WHERE rn = 1 ORDER BY CASE WHEN winner = name THEN 1 ELSE 0 END DESC, score DESC, margin DESC, created_at ASC LIMIT 20"
        ).fetchall()
    keys = (
        "name",
        "score",
        "width",
        "height",
        "opponent",
        "winner",
        "margin",
        "mode",
        "detail",
        "created_at",
        "match_id",
    )
    return [dict(zip(keys, row)) for row in rows]


@app.post("/api/leaderboard", status_code=201)
def add_score(score: Score):
    if not score.name.strip():
        raise HTTPException(status_code=422, detail="Name cannot be blank")
    with connection() as db:
        db.execute(
            "INSERT INTO scores (name, score, width, height, opponent, winner, margin, mode, detail, match_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                score.name.strip(),
                score.score,
                score.width,
                score.height,
                score.opponent.strip(),
                score.winner.strip(),
                score.margin,
                score.mode.strip(),
                score.detail.strip(),
                score.match_id.strip(),
            ),
        )
    return {"ok": True}


@app.post("/api/rooms", status_code=201)
async def create_room(request: CreateRoom):
    await expire_rooms()
    room_id = secrets.token_hex(3).upper()
    while room_id in rooms:
        room_id = secrets.token_hex(3).upper()
    token = secrets.token_urlsafe(24)
    rooms[room_id] = Room(
        room_id, request.cols, request.rows, {"p1": Player(request.name.strip(), token)}
    )
    return {"room_id": room_id, "seat": "p1", "token": token}


@app.post("/api/rooms/{room_id}/join")
async def join_room(room_id: str, request: JoinRoom):
    room = rooms.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    async with room.lock:
        if room.status == "finished":
            raise HTTPException(status_code=410, detail="Match has ended")
        seat = next(
            (
                key
                for key in ("p2", "p1")
                if key not in room.players or not room.players[key].connected
            ),
            None,
        )
        if seat is None:
            raise HTTPException(status_code=409, detail="Room is full")
        token = secrets.token_urlsafe(24)
        room.players[seat] = Player(request.name.strip(), token)
        room.revision += 1
        room.updated_at = time.monotonic()
        await broadcast(room)
    return {"room_id": room.room_id, "seat": seat, "token": token}


@app.websocket("/ws/rooms/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str, token: str):
    room = rooms.get(room_id.upper())
    seat = (
        next(
            (key for key, player in room.players.items() if player.token == token), None
        )
        if room
        else None
    )
    if not room or not seat:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    player = room.players[seat]
    async with room.lock:
        player.socket = websocket
        player.connected = True
        player.disconnected_at = None
        if (
            len(room.players) == 2
            and all(item.connected for item in room.players.values())
            and room.status in {"waiting", "paused"}
        ):
            room.status = "active"
        room.revision += 1
        room.updated_at = time.monotonic()
        await broadcast(room)
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if message.get("type") == "pong":
                continue
            if message.get("type") != "move":
                await websocket.send_json(
                    {"type": "error", "message": "Unknown game action."}
                )
                continue
            edge = message.get("edge")
            if (
                not isinstance(edge, list)
                or len(edge) != 2
                or not all(isinstance(value, int) for value in edge)
            ):
                await websocket.send_json({"type": "error", "message": "Invalid edge."})
                continue
            a, b = edge
            async with room.lock:
                if room.status != "active":
                    await websocket.send_json(
                        {"type": "error", "message": "Match is not active."}
                    )
                    continue
                if room.turn != seat:
                    await websocket.send_json(
                        {"type": "error", "message": "Wait for your turn."}
                    )
                    continue
                edge_key = edge_id(a, b)
                if not legal_edge(room, a, b) or edge_key in room.edges:
                    await websocket.send_json(
                        {"type": "error", "message": "That line is unavailable."}
                    )
                    continue
                room.edges.add(edge_key)
                boxes = completed_boxes(room, a, b)
                for box in boxes:
                    room.boxes[box] = seat
                room.scores[seat] += len(boxes)
                if not boxes:
                    room.turn = "p2" if seat == "p1" else "p1"
                if len(room.boxes) == (room.cols - 1) * (room.rows - 1):
                    room.status = "finished"
                room.revision += 1
                room.updated_at = time.monotonic()
                await broadcast(room)
    except WebSocketDisconnect:
        async with room.lock:
            if player.socket is websocket:
                player.socket = None
                player.connected = False
                player.disconnected_at = time.monotonic()
                if room.status == "active":
                    room.status = "paused"
                room.revision += 1
                room.updated_at = time.monotonic()
                await broadcast(room)


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
