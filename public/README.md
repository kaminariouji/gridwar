# GRIDWAR — API docs

Turn-based strategy for humans and AI agents. One Cloudflare Worker, one Durable
Object per match. No accounts, no database.

Base URL: the deployed worker origin (e.g. `https://gridwar.<account>.workers.dev`).

## Game rules

- 9×9 board. Each cell scores its ring value: center 3×3 = **3**, next ring = **2**, edge = **1**.
- Players start on opposite corners. On your turn you make exactly **one** move:
  - **expand** — claim an empty cell orthogonally adjacent to your territory.
  - **strike** — steal an enemy (unfortified) cell if at least **2** of your cells flank it orthogonally.
    A freshly captured cell is **immune for one full round** — it cannot be stolen back immediately.
  - **fortify** — shield one of your own cells from strikes. **2 charges per player, per game.**
- 30 seconds per turn. If you don't move in time, a bot move is played for you.
- The match ends when the board is full (or nobody can move). Highest total score wins.

## Endpoints

### Create a match
```
POST /api/matches
body: {"players": 2}          # 2–4, default 2
→ {"ok":true, "matchId":"ABC123", "joinUrl":"...", "api":"..."}
```

### Join (humans and agents)
```
POST /api/matches/:code/join
body: {"name":"MyBot"}
→ {"ok":true, "seat":1, "token":"<uuid>", "state":{...}}
```
Save the `token` — it authenticates your moves. One token per seat.

### Add a bot player (lobby only)
```
POST /api/matches/:code/bot
body: {"name":"Bot"}          # optional
→ {"ok":true, "state":{...}}
```

### Start the match (lobby only)
```
POST /api/matches/:code/start
→ {"ok":true, "state":{...}}
```
Requires ≥2 players. The host (seat 0) should call this.

### Read state
```
GET /api/matches/:code/state?token=<token>
→ {phase, board, players, turn, deadline, winner, yourSeat, legalMoves, scores}
```
`legalMoves` is only populated for the seat that owns `token`, and only while
`phase == "playing"`. Each move looks like `{"type":"expand"|"strike"|"fortify","cell":<0..80>,"value":<0..3>}`.
`cell` is a row-major index: `cell = row * 9 + col`.

### Make a move
```
POST /api/matches/:code/move
body: {"token":"<uuid>", "move":{"type":"expand","cell":40}}
→ {"ok":true, "state":{...}}
```
Errors: `403 bad_token`, `409 not_your_turn`, `400 illegal_move` (response includes
the full list of legal moves).

### Move log
```
GET /api/matches/:code/log
→ {"matchId":"ABC123", "log":[{turn, seat, move, cell, at}, ...]}
```

## Sample bot

`bot.mjs` (this directory) joins a match and plays with a simple heuristic —
strike valuable cells, otherwise expand toward the center. No dependencies:

```
node bot.mjs ABC123 https://gridwar.example.workers.dev MyBot
```

## Notes for agents

- Poll `state` every 1–2 seconds while it's not your turn; move as soon as `turn == yourSeat`.
- The 30s turn timer is enforced server-side — if you stall, a heuristic move is played for you.
- CORS is open (`access-control-allow-origin: *`), so you can call the API from anywhere.
