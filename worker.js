// GRIDWAR — turn-based multiplayer strategy for humans and AI agents.
// Cloudflare Worker + one Durable Object per match.
// Humans play in the browser; agents play via plain HTTP/JSON.

const SIZE = 9;                 // 9x9 board
const TURN_MS = 30000;          // 30s per turn, auto-move on timeout
const MAX_FORTIFY = 2;          // fortify charges per player

// ---------- board helpers ----------
function cellValue(r, c) {
  const dr = Math.abs(r - 4), dc = Math.abs(c - 4);
  const ring = Math.max(dr, dc);
  if (ring <= 1) return 3;      // center 3x3
  if (ring <= 2) return 2;      // center 5x5
  return 1;
}
function neighbors(r, c) {
  const out = [];
  if (r > 0) out.push([r - 1, c]);
  if (r < SIZE - 1) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c < SIZE - 1) out.push([r, c + 1]);
  return out;
}
function neighborsIdx(i) {
  const r = Math.floor(i / SIZE), c = i % SIZE;
  return neighbors(r, c).map(([rr, cc]) => rr * SIZE + cc);
}
const SPAWNS = [[0, 0], [8, 8], [0, 8], [8, 0]];
const SEAT_COLORS = ['#22D3EE', '#FB7185', '#FFB800', '#A78BFA'];

function newGame(maxPlayers) {
  const board = new Array(SIZE * SIZE).fill(null); // null | {seat, fortified}
  const pl = [];
  for (let s = 0; s < maxPlayers; s++) {
    const [r, c] = SPAWNS[s];
    board[r * SIZE + c] = { seat: s, fortified: false };
    pl.push({ seat: s, name: `Seat ${s + 1}`, isBot: false, token: null, fortify: MAX_FORTIFY, score: 0, open: true });
  }
  const g = {
    id: null, phase: 'lobby', players: pl, board, maxPlayers,
    turn: 0, turnCount: 0, deadline: null, winner: null, log: [], seedTurn: 0,
    createdAt: Date.now(),
  };
  return g;
}

function legalMoves(g, seat) {
  const moves = [];
  const mine = [];
  for (let i = 0; i < g.board.length; i++) if (g.board[i] && g.board[i].seat === seat) mine.push(i);
  const mySet = new Set(mine);
  const canExpand = new Set(), canStrike = new Set();
  for (const i of mine) {
    for (const j of neighborsIdx(i)) {
      const cell = g.board[j];
      if (!cell) canExpand.add(j);
      else if (cell.seat !== seat && !cell.fortified && !(cell.immuneUntil && g.turnCount < cell.immuneUntil)) {
        // strike requires >=2 orthogonal neighbors of mine (flanking)
        let n = 0;
        for (const k of neighborsIdx(j)) if (mySet.has(k)) n++;
        if (n >= 2) canStrike.add(j);
      }
    }
  }
  for (const j of canExpand) moves.push({ type: 'expand', cell: j, value: cellValue(Math.floor(j / SIZE), j % SIZE) });
  for (const j of canStrike) moves.push({ type: 'strike', cell: j, value: cellValue(Math.floor(j / SIZE), j % SIZE) });
  const p = g.players.find(x => x.seat === seat);
  if (p && p.fortify > 0) {
    for (const i of mine) {
      if (!g.board[i].fortified) moves.push({ type: 'fortify', cell: i, value: 0 });
    }
  }
  return moves;
}

function scores(g) {
  const sc = g.players.map(() => 0);
  for (let i = 0; i < g.board.length; i++) {
    const cell = g.board[i];
    if (cell) sc[cell.seat] += cellValue(Math.floor(i / SIZE), i % SIZE);
  }
  return sc;
}

function applyMove(g, seat, move) {
  if (!move || typeof move.cell !== 'number' || move.cell < 0 || move.cell >= g.board.length) {
    return { ok: false, error: 'invalid_move' };
  }
  const legal = legalMoves(g, seat);
  const match = legal.find(m => m.type === move.type && m.cell === move.cell);
  if (!match) return { ok: false, error: 'illegal_move', legal: legal.slice(0, 200) };
  if (move.type === 'expand') {
    g.board[move.cell] = { seat, fortified: false };
  } else if (move.type === 'strike') {
    // freshly captured cells are immune for one full round (prevents strike ping-pong)
    g.board[move.cell] = { seat, fortified: false, immuneUntil: g.turnCount + g.players.length };
  } else if (move.type === 'fortify') {
    g.board[move.cell].fortified = true;
    g.players.find(p => p.seat === seat).fortify--;
  } else {
    return { ok: false, error: 'unknown_move_type' };
  }
  g.log.push({ turn: g.turnCount, seat, move: move.type, cell: move.cell, at: Date.now() });
  return { ok: true };
}

function botPick(g, seat) {
  const legal = legalMoves(g, seat);
  if (!legal.length) return null;
  const expand = legal.filter(m => m.type === 'expand');
  const strike = legal.filter(m => m.type === 'strike');
  const fortify = legal.filter(m => m.type === 'fortify');
  // 1. strike high-value enemy cells when available
  if (strike.length) {
    strike.sort((a, b) => b.value - a.value);
    if (strike[0].value >= 2) return strike[0];
  }
  // 2. fortify a valuable owned cell under threat
  if (fortify.length) {
    const threatened = fortify.filter(m => {
      let enemyNear = 0;
      for (const j of neighborsIdx(m.cell)) {
        const cell = g.board[j];
        if (cell && cell.seat !== seat) enemyNear++;
      }
      return enemyNear >= 2;
    });
    if (threatened.length) {
      threatened.sort((a, b) => cellValue(Math.floor(b.cell / SIZE), b.cell % SIZE) - cellValue(Math.floor(a.cell / SIZE), a.cell % SIZE));
      return threatened[0];
    }
  }
  // 3. expand toward the center, prefer high value
  if (expand.length) {
    expand.sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      const ca = Math.hypot(Math.floor(a.cell / SIZE) - 4, (a.cell % SIZE) - 4);
      const cb = Math.hypot(Math.floor(b.cell / SIZE) - 4, (b.cell % SIZE) - 4);
      return ca - cb;
    });
    return expand[0];
  }
  // 4. any strike
  if (strike.length) return strike[0];
  return fortify[0] || null;
}

function checkEnd(g) {
  const full = g.board.every(c => c !== null);
  let anyMove = false;
  for (const p of g.players) if (legalMoves(g, p.seat).length) { anyMove = true; break; }
  if (full || !anyMove || g.turnCount > 500) {
    g.phase = 'done';
    const sc = scores(g);
    let best = -1, bestSeat = null, tie = false;
    g.players.forEach((p, i) => {
      if (sc[i] > best) { best = sc[i]; bestSeat = i; tie = false; }
      else if (sc[i] === best) tie = true;
    });
    g.winner = tie ? null : bestSeat;
    g.finalScores = sc;
    g.deadline = null;
    return true;
  }
  return false;
}

function advanceTurn(g) {
  g.turn = (g.turn + 1) % g.players.length;
  g.turnCount++;
  g.deadline = Date.now() + TURN_MS;
}

function publicState(g, seat) {
  return {
    matchId: g.id,
    phase: g.phase,
    size: SIZE,
    maxPlayers: g.maxPlayers,
    board: g.board.map((c) => c ? { owner: c.seat, fortified: c.fortified, immune: !!(c.immuneUntil && g.turnCount < c.immuneUntil) } : null),
    players: g.players.map(p => ({ seat: p.seat, name: p.name, isBot: p.isBot, fortify: p.fortify, open: p.open })),
    turn: g.turn,
    turnCount: g.turnCount,
    deadline: g.deadline,
    winner: g.winner,
    finalScores: g.finalScores || null,
    yourSeat: seat,
    legalMoves: (seat !== null && seat !== undefined && g.phase === 'playing') ? legalMoves(g, seat) : [],
    scores: scores(g),
  };
}

// ---------- Durable Object ----------
export class MatchDO {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.game = null;
  }
  async load() {
    if (!this.game) this.game = (await this.storage.get('game')) || null;
    return this.game;
  }
  async save() { await this.storage.put('game', this.game); }
  json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
  }
  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // :id action  |  init
    const action = parts[parts.length - 1] || null;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });
    }
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }

    // ---- init (called by worker on match creation) ----
    if (action === 'init') {
      if (!body.game || !body.game.id) return this.json({ error: 'bad_init' }, 400);
      this.game = body.game;
      await this.save();
      return this.json({ ok: true, matchId: this.game.id });
    }

    // ---- lobby ----
    if (action === 'join') {
      const g = this.game;
      if (!g) return this.json({ error: 'no_match' }, 404);
      if (g.phase !== 'lobby') return this.json({ error: 'already_started' }, 409);
      const p = g.players.find(x => x.open);
      if (!p) return this.json({ error: 'full' }, 409);
      p.name = (body.name || `Player ${p.seat + 1}`).slice(0, 24);
      p.token = crypto.randomUUID();
      p.isBot = false;
      p.open = false;
      await this.save();
      return this.json({ ok: true, seat: p.seat, token: p.token, state: publicState(g, p.seat) });
    }
    if (action === 'bot') {
      const g = this.game;
      if (!g) return this.json({ error: 'no_match' }, 404);
      if (g.phase !== 'lobby') return this.json({ error: 'already_started' }, 409);
      const p = g.players.find(x => x.open);
      if (!p) return this.json({ error: 'full' }, 409);
      p.name = (body.name || `Bot ${p.seat + 1}`).slice(0, 24);
      p.isBot = true;
      p.open = false;
      await this.save();
      return this.json({ ok: true, state: publicState(g, null) });
    }
    if (action === 'start') {
      const g = this.game;
      if (!g) return this.json({ error: 'no_match' }, 404);
      if (g.phase !== 'lobby') return this.json({ error: 'already_started' }, 409);
      if (g.players.some(p => p.open)) return this.json({ error: 'seats_open', open: g.players.filter(p => p.open).map(p => p.seat) }, 409);
      if (g.players.length < 2) return this.json({ error: 'need_two_players' }, 409);
      g.phase = 'playing';
      g.turn = 0; g.turnCount = 0;
      g.deadline = Date.now() + TURN_MS;
      g.log.push({ turn: -1, seat: null, move: 'start', at: Date.now() });
      await this.save();
      await this.state.storage.setAlarm(g.deadline + 500);
      if (g.players[0].isBot) await this.maybeAutoPlay();
      return this.json({ ok: true, state: publicState(g, null) });
    }

    // ---- play ----
    const token = (url.searchParams.get('token') || body.token || '');
    let seat = null;
    if (this.game && token) {
      const p = this.game.players.find(p => p.token && p.token === token);
      if (p) seat = p.seat;
    }
    if (action === 'state') {
      if (!this.game) return this.json({ error: 'no_match' }, 404);
      return this.json(publicState(this.game, seat));
    }
    if (action === 'log') {
      if (!this.game) return this.json({ error: 'no_match' }, 404);
      return this.json({ matchId: this.game.id, log: this.game.log });
    }
    if (action === 'move') {
      const g = this.game;
      if (!g) return this.json({ error: 'no_match' }, 404);
      if (g.phase !== 'playing') return this.json({ error: 'not_playing', phase: g.phase }, 409);
      if (seat === null) return this.json({ error: 'bad_token' }, 403);
      if (seat !== g.turn) return this.json({ error: 'not_your_turn', turn: g.turn, yourSeat: seat }, 409);
      const res = applyMove(g, seat, body.move || {});
      if (!res.ok) return this.json(res, 400);
      advanceTurn(g);
      checkEnd(g);
      await this.save();
      if (g.phase === 'playing') {
        await this.state.storage.setAlarm(g.deadline + 500);
        await this.maybeAutoPlay();
      }
      return this.json({ ok: true, state: publicState(g, seat) });
    }
    return this.json({ error: 'not_found' }, 404);
  }

  // if it's a bot's turn, play immediately (chained)
  async maybeAutoPlay() {
    const g = this.game;
    let guard = 0;
    while (g && g.phase === 'playing' && g.players[g.turn] && g.players[g.turn].isBot && guard++ < 50) {
      const mv = botPick(g, g.turn);
      if (mv) applyMove(g, g.turn, mv);
      advanceTurn(g);
      checkEnd(g);
    }
    if (g && g.phase === 'playing') {
      const stillBot = g.players[g.turn] && g.players[g.turn].isBot;
      await this.state.storage.setAlarm(stillBot ? Date.now() + 200 : g.deadline + 500);
    }
    await this.save();
  }

  // turn timer: auto-play for the timed-out seat (bot strategy), then advance
  async alarm() {
    await this.load();
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    const cur = g.players[g.turn];
    if (cur && cur.isBot) {
      // still a bot's turn — keep the match moving without waiting for the deadline
      await this.maybeAutoPlay();
      return;
    }
    if (Date.now() < g.deadline - 200) {
      await this.state.storage.setAlarm(g.deadline + 500);
      return;
    }
    const mv = botPick(g, g.turn);
    if (mv) {
      applyMove(g, g.turn, mv);
      g.log.push({ turn: g.turnCount, seat: g.turn, move: 'timeout_auto', at: Date.now() });
    }
    advanceTurn(g);
    checkEnd(g);
    await this.save();
    if (g.phase === 'playing') await this.maybeAutoPlay(); // sets its own alarm
  }
}

// ---------- Worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api' && parts[1] === 'matches') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });
      }
      // POST /api/matches → create
      if (!parts[2]) {
        if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { 'content-type': 'application/json' } });
        let body = {};
        try { body = await request.json(); } catch {}
        const players = Math.min(4, Math.max(2, parseInt(body.players) || 2));
        const code = Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
        const id = env.MATCH.idFromName(code);
        const stub = env.MATCH.get(id);
        const init = newGame(players);
        init.id = code;
        await stub.fetch('https://do/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ game: init }) });
        return new Response(JSON.stringify({ ok: true, matchId: code, joinUrl: `${url.origin}/m/${code}`, api: `${url.origin}/api/matches/${code}` }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
      }
      const code = parts[2].toUpperCase();
      const id = env.MATCH.idFromName(code);
      const stub = env.MATCH.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = '/' + parts.slice(2).join('/');
      return stub.fetch(new Request(doUrl.toString(), request));
    }
    // static assets (index.html etc.)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};
