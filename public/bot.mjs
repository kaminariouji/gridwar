#!/usr/bin/env node
// GRIDWAR sample bot — joins a match and plays with a simple heuristic.
// No dependencies. Requires Node 18+ (built-in fetch).
//
// Usage:
//   node bot.mjs <matchCode> [baseUrl] [botName]
//   node bot.mjs ABC123 https://gridwar.example.workers.dev MyBot
//
// Or create a match and add this bot to it:
//   curl -X POST $BASE/api/matches -d '{"players":2}'

const code = (process.argv[2] || "").toUpperCase();
const base = (process.argv[3] || "http://localhost:8787").replace(/\/$/, "");
const name = process.argv[4] || "SampleBot";

if (!code) {
  console.error("usage: node bot.mjs <matchCode> [baseUrl] [botName]");
  process.exit(1);
}

const api = (path, opts) =>
  fetch(`${base}/api/matches/${code}${path}`, opts).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `http_${r.status}`);
    return j;
  });

// --- heuristic: prefer strikes on valuable cells, then expand toward center ---
function pickMove(state) {
  const legal = state.legalMoves || [];
  if (!legal.length) return null;
  const strikes = legal.filter((m) => m.type === "strike").sort((a, b) => b.value - a.value);
  if (strikes.length && strikes[0].value >= 2) return strikes[0];
  const expands = legal
    .filter((m) => m.type === "expand")
    .sort((a, b) => b.value - a.value || centerDist(a.cell) - centerDist(b.cell));
  if (expands.length) return expands[0];
  if (strikes.length) return strikes[0];
  return legal.find((m) => m.type === "fortify") || null;
}
function centerDist(cell) {
  const r = Math.floor(cell / 9), c = cell % 9;
  return Math.hypot(r - 4, c - 4);
}

async function main() {
  let token = null, seat = null;

  // join (or resume if the match already started and we can't join)
  try {
    const j = await api("/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    token = j.token;
    seat = j.seat;
    console.log(`joined match ${code} as seat ${seat} (${name})`);
  } catch (e) {
    if (e.message === "already_started") {
      console.log(`match ${code} already started — spectating`);
    } else {
      console.error(`join failed: ${e.message}`);
      process.exit(1);
    }
  }

  // main loop
  let idle = 0;
  for (;;) {
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    let s;
    try {
      s = await api(`/state${q}`);
    } catch (e) {
      console.error(`state failed: ${e.message}`);
      await sleep(2000);
      continue;
    }

    if (s.phase === "done") {
      const sc = s.finalScores || s.scores;
      console.log("match over. scores:", sc.map((v, i) => `${s.players[i].name}=${v}`).join(" "));
      if (s.winner !== null) console.log(`winner: ${s.players[s.winner].name}`);
      return;
    }

    if (s.phase === "playing" && seat !== null && s.turn === seat) {
      const mv = pickMove(s);
      if (mv) {
        try {
          await api("/move", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, move: { type: mv.type, cell: mv.cell } }),
          });
          console.log(`turn ${s.turnCount}: ${mv.type} cell ${mv.cell} (value ${mv.value})`);
        } catch (e) {
          console.error(`move rejected: ${e.message}`);
        }
      }
      idle = 0;
    } else {
      idle++;
      if (idle % 10 === 0) console.log(`waiting… phase=${s.phase} turn=${s.turn}`);
    }
    await sleep(1500);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => { console.error(e); process.exit(1); });
