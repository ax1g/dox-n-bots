# Dox 'n Bots

A tactile, browser-based take on dots and boxes. Draw lines, claim boxes, and try not to hand the bot a chain.

## MVP

- Custom grid width and height (2–10 dots each way)
- Required player name (3–50 characters)
- Noob, Casual, and God-mode bots
- Proximity-based line preview with small Web Audio feedback
- Local fallback leaderboard plus a FastAPI/SQLite leaderboard API

## Run locally

Serve the root folder with any static server. For the shared leaderboard:

```bash
cd backend
uvicorn main:app --reload
```

During local development, proxy `/api` to the FastAPI server or serve the frontend from the same origin. Without the API, scores remain available in the browser's local storage.
