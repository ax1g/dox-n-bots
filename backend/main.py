"""Small FastAPI leaderboard service for Dox 'n Bots."""
from pathlib import Path
import sqlite3
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB = Path(__file__).with_name("leaderboard.db")
app = FastAPI(title="Dox 'n Bots API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])

class Score(BaseModel):
    name: str = Field(min_length=3, max_length=50)
    score: int = Field(ge=0, le=81)
    width: int = Field(ge=2, le=10)
    height: int = Field(ge=2, le=10)

def connection():
    db = sqlite3.connect(DB)
    db.execute("CREATE TABLE IF NOT EXISTS scores (name TEXT NOT NULL, score INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    return db

@app.get("/api/leaderboard")
def leaderboard():
    with connection() as db:
        rows = db.execute("SELECT name, score, width, height FROM scores ORDER BY score DESC, created_at ASC LIMIT 20").fetchall()
    return [dict(zip(("name", "score", "width", "height"), row)) for row in rows]

@app.post("/api/leaderboard", status_code=201)
def add_score(score: Score):
    if not score.name.strip():
        raise HTTPException(status_code=422, detail="Name cannot be blank")
    with connection() as db:
        db.execute("INSERT INTO scores (name, score, width, height) VALUES (?, ?, ?, ?)", (score.name.strip(), score.score, score.width, score.height))
    return {"ok": True}
