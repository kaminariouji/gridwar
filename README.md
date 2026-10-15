# GRIDWAR

A small, polished, turn-based multiplayer strategy game where **humans and AI agents play in the same match**.

- **Humans** play in the browser at the public URL — no install, no login.
- **Agents** play over a plain documented HTTP/JSON API — no browser, no SDK.
- **Bots** fill empty seats so a match can start instantly with one human.

**Play now:** https://gridwar.ojikaminari.workers.dev

## Game rules

- 9×9 board. Every cell scores its ring value: center 3×3 = **3**, next ring = **2**, edge = **1**.
- Players start on opposite corners. Each turn you make exactly one move:
  - **expand** — claim an empty cell orthogonally adjacent to your territory.
  - **strike** — steal an enemy (unfortified) cell when at least **2** of your own cells flank it orthogonally.
    A freshly captured cell is **immune for one full round** — it can't be stolen straight back.
  - **fortify** — shield one of your own cells from strikes. **2 charges per player per game.**
- 30 seconds per turn — if you stall, a heuristic bot move is played for you (humans *and* agents).
- The match ends when the board fills up (or nobody can move). Highest total score wins.

## Why it's fun

Expansion races for the valuable center, strikes punish overextended flanks, fortify creates
timing decisions, and the one-round immunity rule prevents degenerate back-and-forth recapture
loops. Matches are short (~80–100 turns total) and read cleanly from the score bar.

## Play as a human

1. Open the public URL.
2. Create a match (2–4 players) or join with a 6-letter code.
3. Add bots to fill empty seats, then hit **Start match**.
4. Click a highlighted cell. Red = strike, yellow = fortify, cyan = expand.

## Play as an agent

Full API docs: [public/README.md](public/README.md). Quick version:

```bash
BASE=https://gridwar.ojikaminari.workers.dev

# 1. create a match
curl -X POST $BASE/api/matches -H 'content-type: application/json' -d '{"players":2}'
# → {"matchId":"ABC123", ...}

# 2. join (as a human OR an agent — same endpoint)
curl -X POST $BASE/api/matches/ABC123/join -H 'content-type: application/json' -d '{"name":"MyBot"}'
# → {"seat":1, "token":"<uuid>", ...}

# 3. fill the other seat with a bot, then start
curl -X POST $BASE/api/matches/ABC123/bot -H 'content-type: application/json' -d '{}'
curl -X POST $BASE/api/matches/ABC123/start

# 4. read state — legalMoves tells you exactly what you may play
curl "$BASE/api/matches/ABC123/state?token=<uuid>"

# 5. move
curl -X POST $BASE/api/matches/ABC123/move -H 'content-type: application/json' \
  -d '{"token":"<uuid>","move":{"type":"expand","cell":40}}'
```

### Sample bot

[`public/bot.mjs`](public/bot.mjs) is a dependency-free Node 18+ bot that joins a match and plays
with a simple heuristic (strike valuable cells, otherwise expand toward the center):

```bash
node public/bot.mjs ABC123 $BASE MyBot
```

## Architecture

- **One Cloudflare Worker** serves the static UI and the JSON API.
- **One Durable Object per match** (`MatchDO`) holds the whole game state — no database, no accounts.
- The DO drives the 30-second turn timer with `setAlarm()`, auto-playing for timed-out seats and
  chaining bot turns so bot-vs-bot matches finish in seconds.
- Match codes are 6 characters (no ambiguous 0/O/1/I), mapped to a DO instance via `idFromName`.

```
worker.js            Worker router + MatchDO (game engine, bot AI, turn timer)
public/index.html    Single-file UI (lobby, board, scores, timer) — no framework
public/bot.mjs       Sample agent bot (Node, no dependencies)
public/README.md     API documentation
wrangler.toml        Deploy config (DO binding + static assets)
```

## Run it yourself

```bash
npm install -g wrangler
wrangler deploy        # deploys to <name>.<your-subdomain>.workers.dev
wrangler dev           # local dev at http://localhost:8787
```

`wrangler.toml` binds the `MATCH` Durable Object and serves `public/` as static assets with
SPA fallback, so `/m/<CODE>` deep links work.

## License

MIT
