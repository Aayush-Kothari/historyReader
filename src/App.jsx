import { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ------------------------------------------------------------------
   History Room (no keys) — pyramidal history practice for NAQT and IAC formats
   Questions come from qbreader's public database or from packets you paste in.
   Stats persist in this browser's localStorage.
------------------------------------------------------------------- */

const SUBCATS = ["American", "European", "World", "Ancient", "Other"];
const QB_SUBCAT = { American: "American History", European: "European History", World: "World History", Ancient: "Ancient History", Other: "Other History" };
const FROM_QB = Object.fromEntries(Object.entries(QB_SUBCAT).map(([k, v]) => [v, k]));
const DIFFS = [
  { id: "regular", label: "Regular", note: "IS-set level (qbreader 2 to 3)", qb: [2, 3] },
  { id: "hard", label: "Hard", note: "regional playoff level (qbreader 4)", qb: [4] },
  { id: "nationals", label: "Nationals", note: "HSNCT and NSC level (qbreader 5)", qb: [5] },
];
const MODES = [
  { id: "naqt", label: "NAQT tossup", note: "15 in power, 10, −5 on a wrong interrupt", needsPackets: false },
  { id: "q4", label: "IAC fourth quarter", note: "30, 20 or 10 by buzz point, no negs", needsPackets: false },
  { id: "q1", label: "IAC first quarter", note: "short questions worth 10, no negs", needsPackets: true },
  { id: "bee", label: "IAC History Bee", note: "1 point each, exit at 8", needsPackets: true },
  { id: "lightning", label: "IAC 60-second round", note: "8 questions on one theme, 20 for a sweep", needsPackets: true },
];
const TARGETS = { conv: 0.7, power: 0.5, neg: 0.2, cel: 0.45 };
const STORE = { results: "hr:results", settings: "hr:settings", players: "hr:players", drill: "hr:drill", packets: "hr:packets", seen: "hr:seen" };
const DEFAULT_SETTINGS = {
  source: "qbreader",
  mode: "naqt",
  difficulty: "nationals",
  subcats: [...SUBCATS],
  minYear: 2019,
  excludeSets: "",
  wpm: 155,
  allowSkip: false,
  autoAdvance: false,
  teamMode: false,
  bonuses: true,
  sound: false,
  theme: "light",
  focus: false,
  textScale: 1,
  title: "History Room",
};

/* ---------- storage ---------- */
function loadKey(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return Promise.resolve(v ? JSON.parse(v) : fallback);
  } catch (e) {
    return Promise.resolve(fallback);
  }
}
function saveKey(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("storage", e);
  }
  return Promise.resolve();
}
const uid = () => Math.random().toString(36).slice(2, 10);
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.07;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.12);
  } catch (e) { /* no audio */ }
}
function downloadCsv(results) {
  const cols = ["ts", "sessionId", "kind", "mode", "difficulty", "source", "subcat", "outcome", "tier", "interrupted", "pts", "celerity", "answer", "given", "set", "player", "theme", "correct", "parts"];
  const esc = (v) => (v === undefined || v === null ? "" : `"${String(v).replace(/"/g, '""')}"`);
  const lines = [cols.join(","), ...results.map((r) => cols.map((c) => esc(c === "ts" ? new Date(r.ts).toISOString() : r[c])).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "history-room-stats.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- local answer checking (fallback when qbreader's judge is unreachable) ---------- */
function normalize(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an|of|de|von|van|der|le|la|el|di|da|du|des)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const GENERIC = new Set("war wars battle battles treaty dynasty empire revolution revolutions act acts kingdom republic party compromise movement era period age siege plan doctrine rebellion revolt uprising crisis affair scandal massacre conference congress council peace pact league union company expedition campaign invasion conquest reformation restoration purchase proclamation amendment declaration constitution charter code edict bull church order state city house tribe people culture civilization system laws law reforms reform crusade crusades plague famine strike riot riots trial election dynasties emperor emperors king kings queen president presidents general".split(" "));
function splitAnswerline(raw) {
  // "Otto von Bismarck [accept Bismarck; prompt on Otto]" -> main answer plus accepted alternates
  const line = (raw || "").replace(/<[^>]+>/g, "");
  const main = line.split(/[\[(]/)[0].trim();
  const accept = [];
  const re = /(?:accept|or)\s+([^;\]\)]+)/gi;
  let m;
  while ((m = re.exec(line))) accept.push(m[1].replace(/\b(before|until|after)\b.*$/i, "").trim());
  return { main: main || line, accept: accept.filter(Boolean) };
}
function isCorrectLocal(user, q) {
  const u = normalize(user);
  if (!u) return false;
  const { main, accept } = splitAnswerline(q.answerline);
  const cands = [main, ...accept].map(normalize).filter(Boolean);
  const uw = u.split(" ");
  const last = uw[uw.length - 1];
  for (const c of cands) {
    if (u === c) return true;
    const cw = c.split(" ");
    const covered = uw.every((w) => cw.includes(w));
    if (covered && last.length >= 3 && last === cw[cw.length - 1] && !GENERIC.has(last)) return true;
    if (covered && uw.length >= 2 && uw.length >= cw.length - 1) return true;
    const cng = cw.filter((w) => !GENERIC.has(w));
    if (cng.length && cng.every((w) => uw.includes(w))) return true;
    if (c.length >= 5 && u.includes(c)) return true;
  }
  return false;
}

/* ---------- qbreader client ---------- */
const QB_BASE = "https://www.qbreader.org/api";
let qbUseRelay = false;
async function qb(path, params) {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  });
  const direct = `${QB_BASE}/${path}?${qs.toString()}`;
  const relay = `/api/qb?path=${path}&${qs.toString()}`;
  if (!qbUseRelay) {
    try {
      const r = await fetch(direct, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`qbreader returned ${r.status}`);
      return await r.json();
    } catch (e) {
      qbUseRelay = true;
    }
  }
  const r = await fetch(relay);
  if (!r.ok) throw new Error(`qbreader is unreachable (status ${r.status}). If this site has no /api relay, host it on Vercel or try again later.`);
  return r.json();
}
function fromQbTossup(t) {
  return {
    id: t._id,
    text: t.question_sanitized || (t.question || "").replace(/<[^>]+>/g, ""),
    answerline: t.answer || t.answer_sanitized || "",
    display: splitAnswerline(t.answer_sanitized || t.answer || "").main,
    subcategory: FROM_QB[t.subcategory] || "Other",
    set: t.set ? `${t.set.name}${t.packet && t.packet.number ? `, packet ${t.packet.number}` : ""}` : "",
    year: t.set ? t.set.year : null,
    qbDifficulty: t.difficulty,
    source: "qbreader",
  };
}
async function judgeAnswer(q, text) {
  if (!text || !text.trim()) return { directive: "reject", directedPrompt: null };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const qs = new URLSearchParams({ answerline: q.answerline, givenAnswer: text });
    const url = qbUseRelay ? `/api/qb?path=check-answer&${qs}` : `${QB_BASE}/check-answer?${qs}`;
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error("judge unavailable");
    const data = await r.json();
    if (data && data.directive) return data;
    throw new Error("judge unavailable");
  } catch (e) {
    return { directive: isCorrectLocal(text, q) ? "accept" : "reject", directedPrompt: null, local: true };
  }
}

/* ---------- packet parsing ---------- */
function cleanText(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function parsePacket(text) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const tossups = [];
  const bonuses = [];
  const rounds = [];
  let buffer = [];
  let bonus = null;
  let round = null;
  const partMark = /\[\s*(?:\d+|[a-z])\s*[a-z]?\s*\]/i;
  const flushBonus = () => { if (bonus && bonus.parts.length) bonuses.push(bonus); bonus = null; };
  const piece = (rawText, answer) => {
    const t = cleanText(rawText.replace(/^\s*(?:\d+|TB|Tiebreaker)[.):]\s*/i, ""));
    if (!t) return;
    if (round) { round.questions.push({ q: t, answerline: cleanText(answer), display: splitAnswerline(answer).main }); return; }
    if (partMark.test(t)) {
      const idx = t.search(partMark);
      const before = t.slice(0, idx).trim();
      const after = t.slice(idx).replace(partMark, "").trim();
      if (bonus && !before) {
        bonus.parts.push({ text: after, answerline: cleanText(answer), display: splitAnswerline(answer).main });
      } else {
        flushBonus();
        bonus = { id: uid(), leadin: before, parts: [{ text: after, answerline: cleanText(answer), display: splitAnswerline(answer).main }] };
      }
      return;
    }
    flushBonus();
    tossups.push({ id: uid(), text: t, answerline: cleanText(answer), display: splitAnswerline(answer).main, source: "packet" });
  };
  for (const line of lines) {
    const header = line.match(/^\s*(?:lightning|60[ -]?second(?: round)?)\s*[:\-–—]\s*(.+)$/i);
    if (header) { flushBonus(); if (round && round.questions.length) rounds.push(round); round = { id: uid(), theme: header[1].trim(), questions: [] }; buffer = []; continue; }
    if (/^\s*---+\s*$/.test(line)) { if (round && round.questions.length) rounds.push(round); round = null; buffer = []; continue; }
    const ans = line.match(/^\s*ANSWER\s*:\s*(.*)$/i);
    if (ans) { piece(buffer.join(" "), ans[1]); buffer = []; continue; }
    buffer.push(line);
  }
  flushBonus();
  if (round && round.questions.length) rounds.push(round);
  return { tossups, bonuses, rounds: rounds.filter((r) => r.questions.length >= 4) };
}

/* ---------- reading helpers ---------- */
function tokenize(text) {
  const words = [];
  let power = null;
  let thirty = null;
  (text || "").split(/\s+/).forEach((tok) => {
    if (tok === "(*)") power = words.length;
    else if (tok === "(**)") thirty = words.length;
    else if (tok.startsWith("(*)")) { power = words.length; words.push(tok.slice(3)); }
    else if (tok.endsWith("(*)")) { words.push(tok.slice(0, -3)); power = words.length; }
    else if (tok.startsWith("(**)")) { thirty = words.length; words.push(tok.slice(4)); }
    else if (tok.endsWith("(**)")) { words.push(tok.slice(0, -4)); thirty = words.length; }
    else if (tok) words.push(tok);
  });
  return { words, power, thirty };
}
function prepare(q, mode) {
  const { words, power, thirty } = tokenize(q.text);
  let p = power;
  let t = thirty;
  if (mode === "q4") {
    if (p === null) p = Math.round(words.length * 0.6);
    if (t === null) t = Math.round((p || words.length * 0.6) * 0.5);
  }
  return { ...q, mode, words, power: p, thirty: t, unmarked: mode === "naqt" && power === null };
}
function scoreTossup({ mode, q, correct, buzzIdx, interrupted }) {
  if (mode === "naqt") {
    if (correct) {
      const power = q.power !== null && buzzIdx !== null && buzzIdx <= q.power;
      return { outcome: "correct", tier: power ? "power" : "ten", pts: power ? 15 : 10 };
    }
    return { outcome: "wrong", tier: interrupted ? "neg" : "zero", pts: interrupted ? -5 : 0 };
  }
  if (mode === "q4") {
    if (correct) {
      const thirty = q.thirty !== null && buzzIdx !== null && buzzIdx <= q.thirty;
      const twenty = !thirty && q.power !== null && buzzIdx !== null && buzzIdx <= q.power;
      return { outcome: "correct", tier: thirty ? "30" : twenty ? "20" : "10", pts: thirty ? 30 : twenty ? 20 : 10 };
    }
    return { outcome: "wrong", tier: "zero", pts: 0 };
  }
  if (mode === "q1") return correct ? { outcome: "correct", tier: "10", pts: 10 } : { outcome: "wrong", tier: "zero", pts: 0 };
  return correct ? { outcome: "correct", tier: "1", pts: 1 } : { outcome: "wrong", tier: "zero", pts: 0 };
}

/* ---------- stats ---------- */
function summarize(rows, deep = true) {
  const t = rows.filter((r) => r.kind === "tossup");
  const n = t.length;
  const correct = t.filter((r) => r.outcome === "correct");
  const wrong = t.filter((r) => r.outcome === "wrong");
  const dead = t.filter((r) => r.outcome === "dead");
  const negs = wrong.filter((r) => r.interrupted);
  const buzzes = correct.length + wrong.length;
  const powers = correct.filter((r) => r.tier === "power" || r.tier === "30");
  const cels = correct.filter((r) => typeof r.celerity === "number");
  const pts = rows.reduce((a, r) => a + (r.pts || 0), 0);
  const bySub = {};
  if (deep) {
    SUBCATS.forEach((s) => {
      const rs = t.filter((r) => r.subcat === s);
      if (rs.length) bySub[s] = summarize(rs, false);
    });
  }
  return {
    n,
    correct: correct.length,
    wrong: wrong.length,
    dead: dead.length,
    negs: negs.length,
    buzzes,
    powers: powers.length,
    conv: n ? correct.length / n : 0,
    negRate: buzzes ? negs.length / buzzes : 0,
    powerRate: correct.length ? powers.length / correct.length : 0,
    cel: cels.length ? cels.reduce((a, r) => a + r.celerity, 0) / cels.length : 0,
    pts,
    pp20: n ? (t.reduce((a, r) => a + (r.pts || 0), 0) / n) * 20 : 0,
    bySub: Object.keys(bySub).length ? bySub : null,
  };
}
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const shuffle = (a) => [...a].sort(() => Math.random() - 0.5);

/* ---------- styles ---------- */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&family=Atkinson+Hyperlegible:wght@400;700&display=swap');
.hr { --paper:#EDEFE9; --paper-2:#E1E5DE; --ink:#16232C; --ink-2:#3E4C56; --muted:#6E7A82; --rule:#C4CBC5;
  --slate:#22303A; --slate-2:#2C3D49; --slate-3:#3A4C59; --amber:#F0B33A; --amber-2:#9A6B12; --green:#2F8F63; --red:#CC4A2E;
  --field:#FFFFFF; --card:rgba(255,255,255,.55); --card-2:rgba(34,48,58,.06); --pressed:#22303A; --scale:1;
  font-family:"Atkinson Hyperlegible","Avenir Next","Segoe UI",system-ui,sans-serif; color:var(--ink); background:var(--paper); min-height:100vh; }
.hr[data-theme="dark"] { --paper:#161C21; --paper-2:#1D252C; --ink:#E6EBEE; --ink-2:#C0CAD1; --muted:#8B98A3; --rule:#37434D;
  --slate:#0E1316; --slate-2:#1A2229; --slate-3:#2A353E; --amber-2:#E2A93A; --green:#4FB283; --red:#E06A50;
  --field:#0F1519; --card:rgba(255,255,255,.06); --card-2:rgba(255,255,255,.05); --pressed:#3A4C59; }
.hr * { box-sizing:border-box; }
.hr .serif { font-family:Literata,"Iowan Old Style","Palatino Linotype",Georgia,serif; }
.hr button { font:inherit; cursor:pointer; }
.hr button:focus-visible, .hr input:focus-visible, .hr select:focus-visible, .hr textarea:focus-visible { outline:3px solid var(--amber); outline-offset:2px; }
.hr .top { background:var(--slate); color:#F3F5F2; padding:12px 22px; display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
.hr .top h1 { margin:0; font-size:1.35rem; font-weight:600; letter-spacing:.01em; }
.hr .titlebtn { background:none; border:0; color:inherit; font:inherit; padding:0; cursor:pointer; }
.hr .titlebtn:hover { color:var(--amber); }
.hr .top .sub { color:#B9C4CC; font-size:.9rem; }
.hr .tabs { margin-left:auto; display:flex; gap:4px; }
.hr .tab { background:transparent; color:#D7DEE3; border:0; padding:8px 12px; border-radius:6px; }
.hr .tab[aria-current="page"] { background:var(--slate-3); color:#fff; }
.hr .tools { display:flex; gap:6px; align-items:center; margin-left:10px; }
.hr .tool { background:transparent; color:#D7DEE3; border:1px solid rgba(255,255,255,.22); border-radius:6px; padding:5px 9px; font-size:.85rem; }
.hr .tool:hover { border-color:var(--amber); color:#fff; }
.hr .main { display:grid; grid-template-columns:290px 1fr; min-height:calc(100vh - 62px); }
.hr .main[data-focus="true"] { grid-template-columns:1fr; }
.hr .main[data-focus="true"] .rail { display:none; }
.hr .rail { background:var(--paper-2); border-right:1px solid var(--rule); padding:18px 18px 40px; }
.hr .rail h2, .hr .panel h2 { font-size:.95rem; margin:20px 0 8px; font-weight:700; color:var(--ink-2); }
.hr .rail h2:first-child { margin-top:0; }
.hr .choice { display:block; width:100%; text-align:left; background:transparent; border:1px solid transparent; border-radius:6px; padding:7px 9px; color:var(--ink); margin-bottom:2px; }
.hr .choice:hover { background:rgba(127,127,127,.12); }
.hr .choice[aria-pressed="true"] { background:var(--pressed); color:#fff; }
.hr .choice:disabled { opacity:.45; cursor:default; }
.hr .choice small { display:block; color:inherit; opacity:.7; font-size:.78rem; }
.hr .chips { display:flex; flex-wrap:wrap; gap:6px; }
.hr .chip { border:1px solid var(--rule); background:transparent; border-radius:999px; padding:4px 11px; font-size:.85rem; color:var(--ink); }
.hr .chip[aria-pressed="true"] { background:var(--pressed); color:#fff; border-color:var(--pressed); }
.hr .row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:6px 0; font-size:.9rem; }
.hr .toggle { width:42px; height:24px; border-radius:12px; border:0; background:#8F9A95; position:relative; flex:none; }
.hr .toggle[aria-checked="true"] { background:var(--green); }
.hr .toggle::after { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .15s; }
.hr .toggle[aria-checked="true"]::after { left:21px; }
@media (prefers-reduced-motion: reduce) { .hr .toggle::after { transition:none; } }
.hr input[type=range] { width:100%; accent-color:var(--pressed); }
.hr .field { width:100%; font:inherit; padding:8px 10px; border:1px solid var(--rule); border-radius:6px; background:var(--field); color:var(--ink); }
.hr textarea.field { min-height:220px; font-family:Literata,Georgia,serif; line-height:1.5; }
.hr .stage { padding:26px 34px 40px; max-width:980px; }
.hr .meta { color:var(--muted); font-size:.9rem; margin-bottom:10px; display:flex; gap:14px; flex-wrap:wrap; }
.hr .packet { font-size:calc(1.3rem * var(--scale)); line-height:1.7; max-width:68ch; min-height:6em; margin:0; }
.hr .packet .mark { display:inline-block; width:2px; height:1em; background:var(--amber-2); vertical-align:-0.15em; margin:0 6px; }
.hr .packet .after { color:var(--ink-2); }
.hr .empty { color:var(--ink-2); font-size:calc(1.05rem * var(--scale)); line-height:1.6; max-width:58ch; }
.hr .console { display:flex; align-items:center; gap:22px; margin-top:26px; flex-wrap:wrap; }
.hr .hint { color:var(--muted); font-size:.9rem; margin:10px 0 0; }
.hr .buzzer { width:104px; height:104px; border-radius:50%; border:7px solid #33434F; background:radial-gradient(circle at 40% 35%, #4C5F6D, #26343E 70%); color:#DDE4E8; font-weight:700; font-size:1rem; letter-spacing:.02em; box-shadow:0 0 0 0 rgba(240,179,58,0); }
.hr .buzzer[data-state="armed"] { border-color:#B78A2A; }
.hr .buzzer[data-state="late"] { border-color:#7A6A3A; color:#F3E3B6; }
.hr .buzzer[data-state="buzzed"], .hr .buzzer[data-state="judging"] { border-color:var(--amber); box-shadow:0 0 0 8px rgba(240,179,58,.25), 0 0 34px rgba(240,179,58,.7); color:#fff; }
.hr .buzzer[data-state="correct"] { border-color:var(--green); box-shadow:0 0 0 8px rgba(47,143,99,.22), 0 0 30px rgba(47,143,99,.55); }
.hr .buzzer[data-state="wrong"] { border-color:var(--red); box-shadow:0 0 0 8px rgba(204,74,46,.22), 0 0 30px rgba(204,74,46,.55); }
.hr .buzzer:disabled { cursor:default; }
.hr .answer { display:flex; gap:8px; flex:1; min-width:260px; align-items:center; flex-wrap:wrap; }
.hr .answer input { flex:1; min-width:200px; font-size:calc(1.1rem * var(--scale)); padding:10px 12px; border:1px solid var(--rule); border-radius:6px; background:var(--field); color:var(--ink); }
.hr .btn { background:var(--pressed); color:#fff; border:0; border-radius:6px; padding:10px 16px; font-weight:700; }
.hr .btn.primary { padding:12px 22px; font-size:1.05rem; }
.hr .btn.quiet { background:transparent; color:var(--ink); border:1px solid var(--rule); font-weight:400; }
.hr .btn.small { padding:6px 10px; font-size:.85rem; }
.hr .btn:disabled { opacity:.45; cursor:default; }
.hr .clock { color:var(--amber-2); font-weight:700; min-width:3ch; text-align:right; }
.hr .prompt { color:var(--amber-2); font-weight:700; margin-top:10px; font-size:calc(1rem * var(--scale)); }
.hr .verdict { margin-top:22px; padding:14px 16px 14px 18px; border-left:5px solid var(--rule); background:var(--card); border-radius:0 8px 8px 0; max-width:68ch; font-size:calc(1rem * var(--scale)); }
.hr .verdict[data-tone="correct"] { border-left-color:var(--green); }
.hr .verdict[data-tone="wrong"] { border-left-color:var(--red); }
.hr .verdict[data-tone="dead"] { border-left-color:var(--muted); }
.hr .verdict .head { font-weight:700; font-size:1.05em; }
.hr .verdict .hook { color:var(--ink-2); margin-top:6px; line-height:1.5; }
.hr .verdict .actions { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; font-size:.9rem; }
.hr .bonus { margin-top:18px; padding:14px 16px; background:var(--card-2); border-radius:8px; max-width:68ch; font-size:calc(1rem * var(--scale)); }
.hr .bonus p { margin:6px 0; line-height:1.55; }
.hr .ticker { position:sticky; bottom:0; margin:28px -34px 0; padding:11px 34px; background:var(--slate); color:#E8EDF0; font-size:.95rem; line-height:1.45; border-top:3px solid var(--amber); z-index:2; }
.hr .ticker b { color:#fff; }
.hr .panel { padding:26px 34px 40px; max-width:980px; }
.hr table { border-collapse:collapse; width:100%; font-size:.93rem; margin:8px 0 18px; }
.hr th { text-align:left; font-weight:700; color:var(--ink-2); border-bottom:2px solid var(--ink); padding:6px 8px 6px 0; }
.hr td { border-bottom:1px solid var(--rule); padding:7px 8px 7px 0; }
.hr td.num, .hr th.num { text-align:right; }
.hr .gauges { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:14px; margin:10px 0 22px; }
.hr .gauge { background:var(--card); border-radius:8px; padding:12px 14px; }
.hr .gauge .val { font-size:1.6rem; font-weight:700; }
.hr .gauge .val[data-ok="true"] { color:var(--green); }
.hr .gauge .val[data-ok="false"] { color:var(--red); }
.hr .gauge .bar { height:6px; background:var(--rule); border-radius:3px; margin-top:8px; overflow:hidden; }
.hr .gauge .bar i { display:block; height:100%; background:var(--pressed); }
.hr .gauge small { color:var(--muted); display:block; margin-top:4px; }
.hr .list { list-style:none; padding:0; margin:8px 0; }
.hr .list li { display:flex; gap:12px; align-items:flex-start; padding:9px 0; border-bottom:1px solid var(--rule); line-height:1.5; }
.hr .list li .a { font-weight:700; min-width:180px; }
.hr .list li .h { color:var(--ink-2); flex:1; }
.hr .note { color:var(--muted); font-size:.9rem; line-height:1.5; max-width:64ch; }
.hr .err { color:var(--red); margin-top:12px; line-height:1.5; }
.hr .lightning-q { font-size:calc(1.3rem * var(--scale)); line-height:1.6; margin:18px 0 12px; max-width:60ch; }
.hr .lightning-time { font-size:2.4rem; font-weight:700; color:var(--amber-2); }
.hr .players input { font:inherit; padding:8px 10px; border:1px solid var(--rule); border-radius:6px; background:var(--field); color:var(--ink); margin-right:8px; }
.hr pre.sample { background:var(--card); padding:12px 14px; border-radius:8px; font-size:.85rem; line-height:1.5; white-space:pre-wrap; max-width:64ch; }
@media (max-width: 880px) {
  .hr .main { grid-template-columns:1fr; }
  .hr .rail { border-right:0; border-bottom:1px solid var(--rule); }
  .hr .stage, .hr .panel { padding:20px 18px 40px; }
  .hr .ticker { margin:24px -18px 0; padding:10px 18px; }
  .hr .tabs { margin-left:0; }
}
`;

/* ------------------------------------------------------------------
   Question supply
------------------------------------------------------------------- */
function activeTossups(packets) {
  return packets.filter((p) => p.active).flatMap((p) => p.tossups.map((t) => ({ ...t, subcategory: p.subcat === "Mixed" ? "Other" : p.subcat, set: p.name, packetId: p.id })));
}
function activeBonuses(packets) {
  return packets.filter((p) => p.active).flatMap((p) => p.bonuses.map((b) => ({ ...b, set: p.name })));
}
function activeRounds(packets) {
  return packets.filter((p) => p.active).flatMap((p) => p.rounds.map((r) => ({ ...r, set: p.name })));
}

async function supplyQbTossups({ settings, seen, drillAnswers }) {
  const diff = DIFFS.find((d) => d.id === settings.difficulty).qb;
  const exclude = settings.excludeSets.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const keep = (t) => !seen.has(t._id) && !(t.set && exclude.some((x) => t.set.name.toLowerCase().includes(x)));
  if (drillAnswers && drillAnswers.length) {
    const picks = shuffle(drillAnswers).slice(0, 3);
    const out = [];
    for (const ans of picks) {
      try {
        const data = await qb("query", { queryString: ans, searchType: "answer", questionType: "tossup", randomize: true, maxReturnLength: 3, categories: "History", difficulties: diff, minYear: settings.minYear });
        const arr = (data.tossups && data.tossups.questionArray) || [];
        const fresh = arr.filter(keep);
        if (fresh.length) out.push(fromQbTossup(fresh[0]));
        else if (arr.length) out.push(fromQbTossup(arr[Math.floor(Math.random() * arr.length)]));
      } catch (e) { /* skip this answer */ }
    }
    if (!out.length) throw new Error("qbreader has no tossups on those answerlines at this difficulty. Try a different difficulty or year range.");
    return out;
  }
  const data = await qb("random-tossup", {
    difficulties: diff,
    categories: "History",
    subcategories: settings.subcats.map((s) => QB_SUBCAT[s]),
    number: 12,
    minYear: settings.minYear,
    powermarkOnly: settings.mode === "naqt",
    standardOnly: true,
  });
  const arr = (data.tossups || []).filter(keep);
  if (!arr.length) throw new Error("qbreader returned nothing new for these filters. Widen the year range or difficulty, or clear the seen list in Stats.");
  return arr.slice(0, 6).map(fromQbTossup);
}

/* ------------------------------------------------------------------
   Reading engine
------------------------------------------------------------------- */
function PacketText({ q, revealed, done }) {
  if (!q) return null;
  const parts = [];
  q.words.forEach((w, i) => {
    if (i >= revealed && !done) return;
    if (done && q.mode === "q4" && q.thirty === i) parts.push(<span key={`t${i}`} className="mark" title="30-point line" />);
    if (done && q.power === i && !q.unmarked) parts.push(<span key={`p${i}`} className="mark" title={q.mode === "q4" ? "20-point line" : "power mark"} />);
    const after = done && q.power !== null && i >= q.power;
    parts.push(<span key={i} className={after ? "after" : undefined}>{w}{" "}</span>);
  });
  return <p className="packet serif">{parts}</p>;
}

function ReadView({ settings, players, results, sessionId, addResult, replaceResult, drill, packets, seen, markSeen }) {
  const [phase, setPhase] = useState("idle"); // idle loading reading buzzed judging window result
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [revealed, setRevealed] = useState(0);
  const [buzzIdx, setBuzzIdx] = useState(null);
  const [interrupted, setInterrupted] = useState(false);
  const [answer, setAnswer] = useState("");
  const [verdict, setVerdict] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [player, setPlayer] = useState(null);
  const [promptText, setPromptText] = useState("");
  const [error, setError] = useState("");
  const [drillMode, setDrillMode] = useState(false);
  const [retry, setRetry] = useState(0);
  const [bonus, setBonus] = useState(null);
  const [bonusMarks, setBonusMarks] = useState([]);
  const [bonusRevealed, setBonusRevealed] = useState(0);
  const [bonusScored, setBonusScored] = useState(false);
  const [usedIds, setUsedIds] = useState(() => new Set());

  const readTimer = useRef(null);
  const windowTimer = useRef(null);
  const answerTimer = useRef(null);
  const tickTimer = useRef(null);
  const fetching = useRef(false);
  const inputRef = useRef(null);
  const phaseRef = useRef(phase);
  const currentRef = useRef(current);
  const revealedRef = useRef(revealed);
  const buzzRef = useRef(null);
  const interruptedRef = useRef(false);
  const playerRef = useRef(null);
  const promptedRef = useRef(false);
  const lastId = useRef(null);
  const submitRef = useRef(null);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => { revealedRef.current = revealed; }, [revealed]);

  const { source, mode, difficulty, subcats, wpm, allowSkip, autoAdvance, teamMode, bonuses, minYear, excludeSets, sound, focus } = settings;
  const configKey = `${source}|${mode}|${difficulty}|${subcats.join(",")}|${drillMode}|${minYear}|${excludeSets}`;
  const drillAnswers = useMemo(() => drill.map((d) => d.answer), [drill]);
  const pool = useMemo(() => activeTossups(packets), [packets]);

  const clearTimers = useCallback(() => {
    [readTimer, windowTimer, answerTimer, tickTimer].forEach((t) => {
      if (t.current) { clearInterval(t.current); clearTimeout(t.current); t.current = null; }
    });
  }, []);
  useEffect(() => () => clearTimers(), [clearTimers]);

  // Reset the queue when the setup changes.
  useEffect(() => {
    setQueue([]);
    clearTimers();
    setError("");
    const p = phaseRef.current;
    if (p !== "idle" && p !== "result") { setCurrent(null); setVerdict(null); setPhase("idle"); }
  }, [configKey, clearTimers]);

  // Keep a few questions ready.
  useEffect(() => {
    if (mode === "lightning") return;
    if (queue.length >= 2 || fetching.current) return;
    if (drillMode && !drillAnswers.length) return;
    if (source === "packets" && !drillMode) {
      const fresh = shuffle(pool.filter((t) => !usedIds.has(t.id)));
      if (!fresh.length) {
        setError(pool.length ? "You've read every tossup in your active packets this session. Add or re-enable packets, or start a new session by reloading." : "No packets yet. Paste some under the Packets tab, or switch the source to qbreader.");
        return;
      }
      setQueue((old) => [...old, ...fresh.filter((t) => !old.some((o) => o.id === t.id)).slice(0, 5)]);
      return;
    }
    fetching.current = true;
    supplyQbTossups({ settings, seen, drillAnswers: drillMode ? drillAnswers : null })
      .then((qs) => { setQueue((old) => [...old, ...qs.filter((q) => !old.some((o) => o.id === q.id))]); setError(""); })
      .catch((e) => setError(e.message))
      .finally(() => { fetching.current = false; });
  }, [queue.length, configKey, mode, source, drillMode, drillAnswers, phase, retry, pool, usedIds, settings, seen]);

  const startReading = useCallback((q) => {
    const full = prepare(q, mode);
    setCurrent(full);
    setRevealed(0);
    setBuzzIdx(null);
    setInterrupted(false);
    setAnswer("");
    setVerdict(null);
    setPromptText("");
    promptedRef.current = false;
    setBonus(null);
    setBonusMarks([]);
    setBonusRevealed(0);
    setBonusScored(false);
    setPlayer(null);
    setPhase("reading");
    setUsedIds((s) => new Set([...s, q.id]));
    if (q.source === "qbreader") markSeen(q.id);
    clearTimers();
    readTimer.current = setInterval(() => setRevealed((r) => r + 1), Math.round(60000 / wpm));
  }, [wpm, clearTimers, mode, markSeen]);

  useEffect(() => {
    if (phase !== "loading" || !queue.length) return;
    const [q, ...rest] = queue;
    setQueue(rest);
    startReading(q);
  }, [phase, queue, startReading]);

  const record = useCallback((row) => {
    const id = uid();
    lastId.current = id;
    addResult({ id, ts: Date.now(), sessionId, kind: "tossup", mode, difficulty, source, ...row });
  }, [addResult, sessionId, mode, difficulty, source]);

  const resolveDead = useCallback(() => {
    const q = currentRef.current;
    if (!q) return;
    clearTimers();
    setVerdict({ outcome: "dead", tier: "dead", pts: 0, correct: false });
    record({ subcat: q.subcategory, outcome: "dead", tier: "dead", interrupted: false, pts: 0, celerity: null, answer: q.display, set: q.set, player: null });
    setPhase("result");
  }, [clearTimers, record]);

  useEffect(() => {
    if (phase !== "reading" || !current) return;
    if (revealed >= current.words.length) {
      if (readTimer.current) { clearInterval(readTimer.current); readTimer.current = null; }
      setPhase("window");
      windowTimer.current = setTimeout(resolveDead, 5000);
    }
  }, [revealed, phase, current, resolveDead]);

  const armAnswerClock = useCallback(() => {
    setCountdown(8);
    tickTimer.current = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    answerTimer.current = setTimeout(() => submitRef.current && submitRef.current(""), 8000);
    setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
  }, []);

  const submit = useCallback(async (text) => {
    if (phaseRef.current !== "buzzed") return;
    const q = currentRef.current;
    clearTimers();
    setPhase("judging");
    const j = await judgeAnswer(q, text);
    if (j.directive === "prompt" && !promptedRef.current && text.trim()) {
      promptedRef.current = true;
      setPromptText(j.directedPrompt ? `Prompt: ${j.directedPrompt}` : "Prompt. Be more specific.");
      setAnswer("");
      setPhase("buzzed");
      armAnswerClock();
      return;
    }
    const correct = j.directive === "accept";
    const wasInterrupted = interruptedRef.current;
    const bi = buzzRef.current;
    const s = scoreTossup({ mode, q, correct, buzzIdx: bi, interrupted: wasInterrupted });
    const celerity = 1 - bi / q.words.length;
    setVerdict({ ...s, correct, celerity, given: text, localJudge: !!j.local });
    record({ subcat: q.subcategory, outcome: s.outcome, tier: s.tier, interrupted: wasInterrupted, pts: s.pts, celerity, answer: q.display, set: q.set, given: text, player: playerRef.current });
    setPhase("result");
  }, [mode, clearTimers, record, armAnswerClock]);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  const buzz = useCallback((who) => {
    const p = phaseRef.current;
    if (p !== "reading" && p !== "window") return;
    clearTimers();
    buzzRef.current = revealedRef.current;
    setBuzzIdx(revealedRef.current);
    setInterrupted(p === "reading");
    interruptedRef.current = p === "reading";
    setPlayer(who || null);
    playerRef.current = who || null;
    if (sound) beep();
    setPhase("buzzed");
    armAnswerClock();
  }, [clearTimers, armAnswerClock, sound]);

  const next = useCallback(() => {
    clearTimers();
    setVerdict(null);
    setAnswer("");
    setBonus(null);
    setCurrent(null);
    setPromptText("");
    setPhase("loading");
  }, [clearTimers]);

  const skip = useCallback(() => {
    if (!allowSkip) return;
    const p = phaseRef.current;
    if (p !== "reading" && p !== "window") return;
    resolveDead();
  }, [allowSkip, resolveDead]);

  const override = useCallback(() => {
    if (!verdict || !current || verdict.outcome === "dead") return;
    const correct = !verdict.correct;
    const s = scoreTossup({ mode, q: current, correct, buzzIdx, interrupted });
    setVerdict({ ...verdict, ...s, correct });
    replaceResult(lastId.current, { outcome: s.outcome, tier: s.tier, pts: s.pts });
  }, [verdict, current, mode, buzzIdx, interrupted, replaceResult]);

  useEffect(() => {
    if (phase !== "result" || !autoAdvance || bonus) return;
    const t = setTimeout(next, 2600);
    return () => clearTimeout(t);
  }, [phase, autoAdvance, next, bonus]);

  // Team bonus after a correct tossup.
  useEffect(() => {
    if (phase !== "result" || !teamMode || !bonuses || !verdict || !verdict.correct || !current || bonus) return;
    if (mode !== "naqt" && mode !== "q1") return;
    let live = true;
    if (source === "packets") {
      const pool2 = activeBonuses(packets).filter((b) => !usedIds.has(b.id));
      if (pool2.length) {
        const b = pool2[Math.floor(Math.random() * pool2.length)];
        setUsedIds((s) => new Set([...s, b.id]));
        setBonus({ leadin: b.leadin, parts: mode === "q1" ? b.parts.slice(0, 1) : b.parts });
      }
      return;
    }
    const diff = DIFFS.find((d) => d.id === difficulty).qb;
    qb("random-bonus", { difficulties: diff, categories: "History", subcategories: QB_SUBCAT[current.subcategory] ? [QB_SUBCAT[current.subcategory]] : undefined, number: 1, minYear, standardOnly: true })
      .then((data) => {
        const b = data.bonuses && data.bonuses[0];
        if (!live || !b) return;
        const parts = (b.parts_sanitized || []).map((p, i) => ({ text: p, answerline: (b.answers_sanitized || [])[i] || "", display: splitAnswerline((b.answers_sanitized || [])[i] || "").main }));
        setBonus({ leadin: b.leadin_sanitized || "", parts: mode === "q1" ? parts.slice(0, 1) : parts });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [phase, teamMode, bonuses, verdict, current, mode, difficulty, bonus, source, packets, usedIds, minYear]);

  const scoreBonus = useCallback(() => {
    if (!bonus || bonusScored) return;
    const pts = bonusMarks.filter(Boolean).length * 10;
    addResult({ id: uid(), ts: Date.now(), sessionId, kind: "bonus", mode, difficulty, pts, parts: bonus.parts.length });
    setBonusScored(true);
  }, [bonus, bonusScored, bonusMarks, addResult, sessionId, mode, difficulty]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const p = phaseRef.current;
      if (p === "reading" || p === "window") {
        if (!teamMode && e.code === "Space") { e.preventDefault(); buzz(null); return; }
        if (teamMode && /^[1-4]$/.test(e.key)) {
          const who = players[Number(e.key) - 1];
          if (who && who.name) { e.preventDefault(); buzz(who.name); }
          return;
        }
        if (e.key.toLowerCase() === "s" && !typing) { e.preventDefault(); skip(); }
        return;
      }
      if ((p === "result" || p === "idle") && !typing && (e.key === "Enter" || e.key.toLowerCase() === "n")) { e.preventDefault(); next(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [buzz, next, skip, teamMode, players]);

  const session = useMemo(() => summarize(results.filter((r) => r.sessionId === sessionId && r.mode === mode)), [results, sessionId, mode]);
  const beeExit = useMemo(() => {
    if (mode !== "bee") return null;
    let c = 0;
    const rows = results.filter((r) => r.sessionId === sessionId && r.mode === "bee" && r.kind === "tossup");
    for (let i = 0; i < rows.length; i++) { if (rows[i].outcome === "correct") c++; if (c >= 8) return i + 1; }
    return null;
  }, [mode, results, sessionId]);

  const buzzerState = phase === "reading" ? "armed" : phase === "window" ? "late" : phase === "buzzed" ? "buzzed" : phase === "judging" ? "judging" : verdict ? (verdict.correct ? "correct" : verdict.outcome === "dead" ? "idle" : "wrong") : "idle";
  const modeInfo = MODES.find((m) => m.id === mode);
  const diffInfo = DIFFS.find((d) => d.id === difficulty);

  if (mode === "lightning") return <LightningView settings={settings} sessionId={sessionId} addResult={addResult} packets={packets} />;

  return (
    <div className="stage">
      <div className="meta">
        <span>{current ? `Tossup ${session.n + (phase === "result" ? 0 : 1)}` : "Ready"}</span>
        {current && <span>{current.subcategory} history</span>}
        {current && current.set && phase === "result" && <span>{current.set}</span>}
        <span>{modeInfo.label}, {source === "packets" ? "your packets" : diffInfo.label.toLowerCase()}</span>
        {focus && source === "qbreader" && <span>{subcats.length === SUBCATS.length ? "all subcategories" : subcats.join(", ")}, sets from {minYear}, {wpm} wpm</span>}
        {drillMode && <span>Drilling your misses</span>}
      </div>

      {phase === "idle" && !current && (
        <div className="empty serif">
          <p>Press <b>Read</b> (or Enter) to start. {source === "qbreader" ? `Questions come from released sets in qbreader's database at ${diffInfo.label.toLowerCase()} difficulty, ${minYear} onward, skipping anything you've already been read here.` : "Questions come from the packets you pasted under Packets."}</p>
          <p><b>Space</b> buzzes{teamMode ? " (in team mode, players buzz with 1 to 4)" : ""}. After you buzz you have eight seconds to type an answer and press Enter; prompts work like a real moderator's. Every question is read to the end and counted. There is no skip unless you turn one on, and a skip counts as dead.</p>
        </div>
      )}
      {phase === "loading" && !current && <p className="empty serif">Pulling questions…</p>}

      {current && <PacketText q={current} revealed={revealed} done={phase === "result"} />}

      <div className="console">
        <button className="buzzer" data-state={buzzerState} onClick={() => buzz(teamMode && players[0] ? players[0].name : null)} disabled={phase !== "reading" && phase !== "window"} aria-label="Buzz">
          {phase === "buzzed" ? (player || "Buzzed") : phase === "judging" ? "Judging" : phase === "window" ? "Late buzz" : "Buzz"}
        </button>
        {phase === "buzzed" || phase === "judging" ? (
          <form className="answer" onSubmit={(e) => { e.preventDefault(); submit(answer); }}>
            <input ref={inputRef} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={player ? `${player}'s answer` : "Answer"} autoComplete="off" aria-label="Your answer" disabled={phase === "judging"} />
            <span className="clock" aria-live="polite">{phase === "judging" ? "" : countdown}</span>
            <button className="btn" type="submit" disabled={phase === "judging"}>Answer</button>
          </form>
        ) : (
          <div className="answer">
            <button className="btn primary" onClick={next} disabled={phase === "reading" || phase === "window" || (phase === "loading" && !queue.length)}>
              {phase === "loading" ? "Pulling…" : current ? "Read next" : "Read"}
            </button>
            {allowSkip && (phase === "reading" || phase === "window") && <button className="btn quiet" onClick={skip}>Skip (counts as dead)</button>}
            {drillAnswers.length > 0 && (
              <button className="btn quiet" onClick={() => setDrillMode((d) => !d)} disabled={phase === "reading" || phase === "window"}>
                {drillMode ? "Back to the full distribution" : `Drill your ${drillAnswers.length} misses`}
              </button>
            )}
          </div>
        )}
      </div>
      {promptText && (phase === "buzzed" || phase === "judging") && <p className="prompt">{promptText}</p>}
      <p className="hint">
        {phase === "idle" && "Enter reads. Space buzzes."}
        {(phase === "reading" || phase === "window") && (teamMode ? "Players buzz with 1 to 4." : "Space to buzz.")}
        {phase === "buzzed" && "Type the answer and press Enter."}
        {phase === "judging" && "Checking…"}
        {phase === "result" && "Enter for the next question."}
        {phase === "loading" && "Pulling the next question…"}
      </p>
      {error && <p className="err">{error} <button className="btn small quiet" onClick={() => { setError(""); setRetry((r) => r + 1); }}>Try again</button></p>}

      {verdict && current && (
        <div className="verdict" data-tone={verdict.outcome}>
          <div className="head">
            {verdict.outcome === "dead" && "Nobody buzzed. "}
            {verdict.outcome === "correct" && (verdict.tier === "power" ? "Power, 15. " : verdict.tier === "30" ? "Thirty. " : verdict.tier === "20" ? "Twenty. " : verdict.tier === "ten" || verdict.tier === "10" ? "Ten. " : "Correct. ")}
            {verdict.outcome === "wrong" && (verdict.tier === "neg" ? "Neg, minus 5. " : interrupted ? "Wrong; locked out. " : "Wrong after the end, no penalty. ")}
            The answer was <span className="serif">{current.display}</span>{verdict.given ? ` (you said “${verdict.given}”)` : ""}.
            {typeof verdict.celerity === "number" && ` Celerity ${verdict.celerity.toFixed(2)}.`}
          </div>
          <div className="hook">Full answerline: {current.answerline.replace(/<[^>]+>/g, "")}</div>
          <div className="actions">
            {verdict.outcome !== "dead" && <button className="btn small quiet" onClick={override}>{verdict.correct ? "Mark it wrong" : "Mark it correct"}</button>}
            {verdict.localJudge && <span className="note">Judged locally; qbreader's judge was unreachable.</span>}
            {current.unmarked && <span className="note">This question has no power mark, so no power was possible.</span>}
            {!current.unmarked && (mode === "naqt" || mode === "q4") && <span className="note">Vertical marks show the scoring lines.</span>}
          </div>
        </div>
      )}

      {bonus && (
        <div className="bonus">
          {bonus.leadin && <p className="serif"><b>Bonus.</b> {bonus.leadin}</p>}
          {bonus.parts.slice(0, bonusRevealed + 1).map((part, i) => (
            <div key={i}>
              <p className="serif">{part.text}</p>
              {i < bonusRevealed || bonusScored ? (
                <p className="note">Answer: {part.display}. {bonusMarks[i] ? "Got it." : "Missed."}</p>
              ) : (
                <p style={{ display: "flex", gap: 8 }}>
                  <button className="btn small" onClick={() => { setBonusMarks((m) => { const c = [...m]; c[i] = true; return c; }); setBonusRevealed(i + 1); }}>Got it</button>
                  <button className="btn small quiet" onClick={() => { setBonusMarks((m) => { const c = [...m]; c[i] = false; return c; }); setBonusRevealed(i + 1); }}>Missed</button>
                </p>
              )}
            </div>
          ))}
          {bonusRevealed >= bonus.parts.length && !bonusScored && <button className="btn small" onClick={scoreBonus}>Record {bonusMarks.filter(Boolean).length * 10} bonus points</button>}
        </div>
      )}

      <div className="ticker" aria-live="polite">
        {session.n === 0 ? (
          <span>Nothing read yet this session. Your line will build here as you go.</span>
        ) : mode === "bee" ? (
          <span>Bee round: <b>{session.correct}</b> correct on <b>{session.n}</b> heard, <b>{session.wrong}</b> wrong. {beeExit ? `You exited at question ${beeExit}: about ${8 + Math.max(0, Math.min(7, Math.round((35 - beeExit) / 4)))} points with the exit bonus (approximate).` : "Exit at 8 correct; the earlier you exit, the bigger the bonus."}</span>
        ) : mode === "q4" ? (
          <span>This session: <b>{session.correct}</b> of <b>{session.n}</b> ({pct(session.conv)}), {session.powers} thirties, <b>{session.pts}</b> points, celerity <b>{session.cel.toFixed(2)}</b>.</span>
        ) : (
          <span>
            This session: <b>{session.powers}/{session.correct - session.powers}/{session.negs}</b> on <b>{session.n}</b> heard, {pct(session.conv)} converted, negs <b>{pct(session.negRate)}</b> of buzzes, celerity <b>{session.cel.toFixed(2)}</b>, <b>{session.pp20.toFixed(1)}</b> per 20.
            {session.buzzes >= 8 && session.negRate >= TARGETS.neg && " Negs are above the 20% line."}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   IAC 60-second round (from pasted packets)
------------------------------------------------------------------- */
function LightningView({ settings, sessionId, addResult, packets }) {
  const [phase, setPhase] = useState("idle");
  const [round, setRound] = useState(null);
  const [idx, setIdx] = useState(0);
  const [time, setTime] = useState(60);
  const [answer, setAnswer] = useState("");
  const [marks, setMarks] = useState([]);
  const [used, setUsed] = useState(() => new Set());
  const timer = useRef(null);
  const inputRef = useRef(null);
  const recorded = useRef(false);
  const rounds = useMemo(() => activeRounds(packets), [packets]);

  const finish = useCallback(() => { if (timer.current) { clearInterval(timer.current); timer.current = null; } setPhase("done"); }, []);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  useEffect(() => { if (phase === "running" && time <= 0) finish(); }, [phase, time, finish]);
  useEffect(() => {
    if (phase !== "done" || !round || recorded.current) return;
    recorded.current = true;
    const correct = marks.filter(Boolean).length;
    addResult({ id: uid(), ts: Date.now(), sessionId, kind: "lightning", mode: "lightning", difficulty: settings.difficulty, theme: round.theme, correct, pts: correct * 10 + (correct === round.questions.length ? 20 : 0) });
  }, [phase, round, marks, addResult, sessionId, settings.difficulty]);

  const start = () => {
    const fresh = rounds.filter((r) => !used.has(r.id));
    const r = (fresh.length ? fresh : rounds)[Math.floor(Math.random() * (fresh.length ? fresh.length : rounds.length))];
    if (!r) return;
    recorded.current = false;
    setUsed((s) => new Set([...s, r.id]));
    setRound({ theme: r.theme, questions: r.questions.slice(0, 8) });
    setIdx(0); setMarks([]); setAnswer(""); setTime(60); setPhase("running");
    timer.current = setInterval(() => setTime((t) => Math.max(0, t - 1)), 1000);
    setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
  };
  const respond = async (text) => {
    if (phase !== "running" || !round) return;
    const q = round.questions[idx];
    const j = text === null ? { directive: "reject" } : await judgeAnswer({ answerline: q.answerline }, text);
    const m = [...marks, j.directive === "accept"];
    setMarks(m);
    setAnswer("");
    if (idx + 1 >= round.questions.length) finish(); else setIdx(idx + 1);
  };
  const correct = marks.filter(Boolean).length;

  return (
    <div className="stage">
      <div className="meta"><span>IAC 60-second round</span><span>{rounds.length} round{rounds.length === 1 ? "" : "s"} in your active packets</span></div>
      {phase === "idle" && (
        <div className="empty serif">
          {rounds.length ? (
            <div>
              <p>Press <b>Start a round</b>. You'll get a theme and up to eight questions, ten points each, sixty seconds for all of them. Eight for eight earns a twenty-point sweep. Passing fast beats stalling.</p>
              <button className="btn" onClick={start}>Start a round</button>
            </div>
          ) : (
            <p>60-second rounds come from your pasted packets. Under Packets, add a block that starts with a line like <b>Lightning: Roman emperors</b> followed by numbered questions with ANSWER lines.</p>
          )}
        </div>
      )}
      {(phase === "running" || phase === "done") && round && (
        <div>
          <p className="serif" style={{ fontSize: "1.1rem", margin: 0 }}>Theme: <b>{round.theme}</b></p>
          <div className="lightning-time" aria-live="polite">{time}</div>
          {phase === "running" ? (
            <div>
              <p className="lightning-q serif">{idx + 1}. {round.questions[idx].q}</p>
              <form className="answer" onSubmit={(e) => { e.preventDefault(); respond(answer); }}>
                <input ref={inputRef} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer" autoComplete="off" aria-label="Answer" />
                <button className="btn" type="submit">Answer</button>
                <button className="btn quiet" type="button" onClick={() => respond(null)}>Pass</button>
              </form>
              <p className="note">{correct} correct so far.</p>
            </div>
          ) : (
            <div>
              <p className="serif" style={{ fontSize: "1.15rem" }}>{correct} of {round.questions.length}: <b>{correct * 10 + (correct === round.questions.length ? 20 : 0)} points</b>{correct === round.questions.length ? ", with the sweep bonus." : "."}</p>
              <ul className="list">
                {round.questions.map((q, i) => (
                  <li key={i}><span className="a" style={{ color: marks[i] ? "var(--green)" : "var(--red)" }}>{marks[i] ? "Got" : i < marks.length ? "Missed" : "Ran out"}</span><span className="h">{q.q} <b>{q.display}</b></span></li>
                ))}
              </ul>
              <button className="btn" onClick={start}>Another round</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
   Stats
------------------------------------------------------------------- */
function Gauge({ label, value, target, higherIsBetter, format, note }) {
  const ok = higherIsBetter ? value >= target : value < target;
  const fill = Math.max(0, Math.min(1, higherIsBetter ? value / (target * 1.25) : 1 - value / (target * 2)));
  return (
    <div className="gauge">
      <div>{label}</div>
      <div className="val" data-ok={ok}>{format(value)}</div>
      <div className="bar"><i style={{ width: `${fill * 100}%` }} /></div>
      <small>{note}</small>
    </div>
  );
}

function StatsView({ results, sessionId, drill, addDrill, clearAll, seenCount, clearSeen }) {
  const [scope, setScope] = useState("session");
  const [confirm, setConfirm] = useState(false);
  const rows = useMemo(() => results.filter((r) => scope === "all" || r.sessionId === sessionId), [results, scope, sessionId]);
  const tossups = useMemo(() => rows.filter((r) => r.kind === "tossup"), [rows]);
  const nat = useMemo(() => tossups.filter((r) => r.difficulty === "nationals" && (r.mode === "naqt" || r.mode === "q4")), [tossups]);
  const scored = nat.length >= 10 ? nat : tossups;
  const s = summarize(scored);
  const all = summarize(tossups);
  const bonuses = rows.filter((r) => r.kind === "bonus");
  const ppb = bonuses.length ? bonuses.reduce((a, r) => a + r.pts, 0) / bonuses.length : null;
  const lightning = rows.filter((r) => r.kind === "lightning");
  const missed = useMemo(() => {
    const m = {};
    tossups.filter((r) => r.outcome !== "correct" && r.answer).forEach((r) => {
      m[r.answer] = m[r.answer] || { answer: r.answer, subcat: r.subcat, count: 0 };
      m[r.answer].count++;
    });
    return Object.values(m).sort((a, b) => b.count - a.count).slice(0, 25);
  }, [tossups]);
  const inDrill = new Set(drill.map((d) => d.answer));
  const gap = all.bySub && all.bySub.American && all.bySub.European ? all.bySub.American.conv - all.bySub.European.conv : null;

  return (
    <div className="panel">
      <div className="chips" style={{ marginBottom: 18 }}>
        <button className="chip" aria-pressed={scope === "session"} onClick={() => setScope("session")}>This session</button>
        <button className="chip" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All time</button>
      </div>
      {!tossups.length ? (
        <p className="empty serif">No questions recorded {scope === "session" ? "this session" : "yet"}. Read a few and come back.</p>
      ) : (
        <div>
          <h2>Discipline {nat.length >= 10 ? "on nationals-difficulty tossups" : "(all tossups; the targets are meant for nationals difficulty)"}</h2>
          <div className="gauges">
            <Gauge label="Converted" value={s.conv} target={TARGETS.conv} higherIsBetter format={pct} note={`${s.correct} of ${s.n} heard; target 70%`} />
            <Gauge label="Powers, share of gets" value={s.powerRate} target={TARGETS.power} higherIsBetter format={pct} note={`${s.powers} of ${s.correct}; target 50%`} />
            <Gauge label="Negs, share of buzzes" value={s.negRate} target={TARGETS.neg} higherIsBetter={false} format={pct} note={`${s.negs} wrong interrupts in ${s.buzzes} buzzes; keep under 20%`} />
            <Gauge label="Celerity on gets" value={s.cel} target={TARGETS.cel} higherIsBetter format={(v) => v.toFixed(2)} note="share of the question left when you buzzed; target 0.45" />
          </div>
          {gap !== null && (
            <p className="note">American converts {pct(all.bySub.American.conv)}, European {pct(all.bySub.European.conv)}. {Math.abs(gap) > 0.1 ? "That gap is wider than ten points; the weaker one is the study list." : "Within ten points of each other, which is where you want them."}</p>
          )}
          <h2>By subcategory</h2>
          <table>
            <thead><tr><th>Subcategory</th><th className="num">Heard</th><th className="num">Got</th><th className="num">Converted</th><th className="num">Powers</th><th className="num">Negs</th><th className="num">Dead</th><th className="num">Celerity</th></tr></thead>
            <tbody>
              {SUBCATS.filter((k) => all.bySub && all.bySub[k]).map((k) => { const v = all.bySub[k]; return (
                <tr key={k}><td>{k}</td><td className="num">{v.n}</td><td className="num">{v.correct}</td><td className="num">{pct(v.conv)}</td><td className="num">{v.powers}</td><td className="num">{v.negs}</td><td className="num">{v.dead}</td><td className="num">{v.cel.toFixed(2)}</td></tr>
              ); })}
              <tr><td><b>All</b></td><td className="num"><b>{all.n}</b></td><td className="num"><b>{all.correct}</b></td><td className="num"><b>{pct(all.conv)}</b></td><td className="num"><b>{all.powers}</b></td><td className="num"><b>{all.negs}</b></td><td className="num"><b>{all.dead}</b></td><td className="num"><b>{all.cel.toFixed(2)}</b></td></tr>
            </tbody>
          </table>
          {(ppb !== null || lightning.length > 0) && (
            <p className="note">
              {ppb !== null && `Bonus conversion: ${ppb.toFixed(1)} points per bonus over ${bonuses.length}. `}
              {lightning.length > 0 && `60-second rounds: ${lightning.length}, averaging ${(lightning.reduce((a, r) => a + r.correct, 0) / lightning.length).toFixed(1)} correct.`}
            </p>
          )}
          <h2>Answers you missed or negged</h2>
          {missed.length ? (
            <div>
              <ul className="list">
                {missed.map((m) => (
                  <li key={m.answer}>
                    <span className="a">{m.answer}</span>
                    <span className="h">{m.subcat} history{m.count > 1 ? `, missed ${m.count} times` : ""}</span>
                    {inDrill.has(m.answer) ? <span className="note">In your drill list</span> : <button className="btn small quiet" onClick={() => addDrill({ answer: m.answer, subcat: m.subcat })}>Add to drill</button>}
                  </li>
                ))}
              </ul>
              <button className="btn quiet" onClick={() => missed.filter((m) => !inDrill.has(m.answer)).forEach((m) => addDrill({ answer: m.answer, subcat: m.subcat }))}>Add all to the drill list</button>
            </div>
          ) : <p className="note">Nothing missed in this scope.</p>}
        </div>
      )}
      <h2 style={{ marginTop: 34 }}>Housekeeping</h2>
      <p className="note">{seenCount} qbreader questions are marked as already read on this device and won't come up again. <button className="btn small quiet" onClick={clearSeen}>Forget them</button></p>
      <p className="note">Every recorded question, as a spreadsheet: <button className="btn small quiet" onClick={() => downloadCsv(results)} disabled={!results.length}>Download CSV</button></p>
      {!confirm ? (
        <button className="btn quiet" onClick={() => setConfirm(true)}>Clear all saved stats</button>
      ) : (
        <div className="chips">
          <span className="note">This deletes every recorded question on this device. </span>
          <button className="btn small" onClick={() => { clearAll(); setConfirm(false); }}>Yes, clear them</button>
          <button className="btn small quiet" onClick={() => setConfirm(false)}>Keep them</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
   Frequency lists (from qbreader) and the drill list
------------------------------------------------------------------- */
function ListsView({ settings, drill, addDrill, removeDrill }) {
  const [subcat, setSubcat] = useState("European");
  const [difficulty, setDifficulty] = useState(settings.difficulty);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inDrill = new Set(drill.map((d) => d.answer));

  const load = async () => {
    setBusy(true); setError("");
    try {
      const data = await qb("frequency-list", { subcategory: QB_SUBCAT[subcat], difficulties: DIFFS.find((d) => d.id === difficulty).qb, limit: 60, questionType: "tossup", minYear: settings.minYear });
      setItems((data.frequencyList || []).map((f) => ({ answer: f.answer, frequency: f.frequency })));
    } catch (e) {
      setError(`Couldn't load the list: ${e.message}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <p className="note" style={{ marginTop: 0 }}>These are qbreader's real frequency lists: the answerlines that come up most in {subcat.toLowerCase()} history tossups at the chosen level, sets from {settings.minYear} onward. Anything you couldn't answer a tossup on goes to your drill list, and the reader pulls real tossups on those answerlines.</p>
      <div className="chips" style={{ margin: "14px 0" }}>{SUBCATS.map((s) => <button key={s} className="chip" aria-pressed={subcat === s} onClick={() => { setSubcat(s); setItems([]); }}>{s}</button>)}</div>
      <div className="chips" style={{ marginBottom: 14 }}>{DIFFS.map((d) => <button key={d.id} className="chip" aria-pressed={difficulty === d.id} onClick={() => { setDifficulty(d.id); setItems([]); }}>{d.label}</button>)}</div>
      <button className="btn" onClick={load} disabled={busy}>{busy ? "Loading…" : "Load the sixty most frequent"}</button>
      {error && <p className="err">{error}</p>}
      {items.length > 0 && (
        <ul className="list">
          {items.map((it, i) => (
            <li key={`${it.answer}-${i}`}>
              <span className="a serif">{i + 1}. {it.answer}</span>
              <span className="h">{it.frequency} tossup{it.frequency === 1 ? "" : "s"}</span>
              {inDrill.has(it.answer) ? <span className="note">In your drill list</span> : <button className="btn small quiet" onClick={() => addDrill({ answer: it.answer, subcat })}>Can't name it</button>}
            </li>
          ))}
        </ul>
      )}
      <h2 style={{ marginTop: 34 }}>Your drill list ({drill.length})</h2>
      {drill.length ? (
        <ul className="list">
          {drill.map((d) => (
            <li key={d.answer}><span className="a">{d.answer}</span><span className="h">{d.subcat} history</span><button className="btn small quiet" onClick={() => removeDrill(d.answer)}>Learned it</button></li>
          ))}
        </ul>
      ) : <p className="note">Empty. Misses from the reader and unknowns from the lists land here.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------
   Packets you paste in
------------------------------------------------------------------- */
const SAMPLE = `1. This treaty's signatories agreed to the principle of cuius regio, eius religio ... (*) ... For 10 points, name this 1648 peace that ended the Thirty Years' War.
ANSWER: Peace of Westphalia [accept Treaty of Westphalia]

2. Leadin for a bonus. For 10 points each:
[10] Part one text.
ANSWER: first answer
[10] Part two text.
ANSWER: second answer
[10] Part three text.
ANSWER: third answer

Lightning: Roman emperors
1. First emperor of Rome.
ANSWER: Augustus
2. Emperor who built a namesake wall in Britain.
ANSWER: Hadrian
---`;

function PacketsView({ packets, setPackets }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [subcat, setSubcat] = useState("Mixed");
  const [preview, setPreview] = useState(null);

  const parsed = useMemo(() => (text.trim() ? parsePacket(text) : null), [text]);
  const add = () => {
    if (!parsed || (!parsed.tossups.length && !parsed.rounds.length)) return;
    setPackets((ps) => [...ps, { id: uid(), name: name.trim() || `Packet ${ps.length + 1}`, subcat, active: true, added: Date.now(), tossups: parsed.tossups, bonuses: parsed.bonuses, rounds: parsed.rounds }]);
    setName(""); setText(""); setPreview(null);
  };

  return (
    <div className="panel">
      <p className="note" style={{ marginTop: 0 }}>Paste packet text in the usual format: numbered questions, each followed by an <b>ANSWER:</b> line. Bonuses with [10] parts are picked up for team mode. For IAC 60-second rounds, start a block with a line like <b>Lightning: Roman emperors</b> and end it with a line of three dashes. Use <b>(*)</b> for a power mark and, in fourth-quarter questions, <b>(**)</b> for the 30-point line; unmarked fourth-quarter questions get lines at 30% and 60%. Packets stay in this browser only.</p>
      <div className="row" style={{ maxWidth: 560, justifyContent: "flex-start" }}>
        <input className="field" style={{ maxWidth: 260 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Packet name (e.g. 2025 Cal Cup round 3)" aria-label="Packet name" />
        <select className="field" style={{ maxWidth: 200 }} value={subcat} onChange={(e) => setSubcat(e.target.value)} aria-label="Subcategory for this packet">
          <option value="Mixed">Mixed history</option>
          {SUBCATS.map((s) => <option key={s} value={s}>{s} history</option>)}
        </select>
      </div>
      <textarea className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the packet here" aria-label="Packet text" style={{ marginTop: 10, maxWidth: 760 }} />
      <div className="chips" style={{ marginTop: 10 }}>
        <button className="btn" onClick={add} disabled={!parsed || (!parsed.tossups.length && !parsed.rounds.length)}>Add packet</button>
        <button className="btn quiet" onClick={() => setPreview(preview ? null : SAMPLE)}>{preview ? "Hide the format example" : "Show the format example"}</button>
        {parsed && <span className="note">Found {parsed.tossups.length} tossups, {parsed.bonuses.length} bonuses, {parsed.rounds.length} 60-second rounds.</span>}
      </div>
      {preview && <pre className="sample">{preview}</pre>}
      <h2 style={{ marginTop: 30 }}>Your packets ({packets.length})</h2>
      {packets.length ? (
        <ul className="list">
          {packets.map((p) => (
            <li key={p.id}>
              <span className="a">{p.name}</span>
              <span className="h">{p.tossups.length} tossups, {p.bonuses.length} bonuses, {p.rounds.length} rounds, {p.subcat === "Mixed" ? "mixed" : p.subcat.toLowerCase()} history</span>
              <button className="btn small quiet" onClick={() => setPackets((ps) => ps.map((x) => (x.id === p.id ? { ...x, active: !x.active } : x)))}>{p.active ? "Active" : "Off"}</button>
              <button className="btn small quiet" onClick={() => setPackets((ps) => ps.filter((x) => x.id !== p.id))}>Remove</button>
            </li>
          ))}
        </ul>
      ) : <p className="note">No packets yet.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------
   Team
------------------------------------------------------------------- */
function TeamView({ settings, setSettings, players, setPlayers, results, sessionId }) {
  const rows = results.filter((r) => r.sessionId === sessionId && r.kind === "tossup" && r.player);
  const byPlayer = players.filter((p) => p.name).map((p) => ({ name: p.name, ...summarize(rows.filter((r) => r.player === p.name)) }));
  const bonuses = results.filter((r) => r.sessionId === sessionId && r.kind === "bonus");
  const teamPts = results.filter((r) => r.sessionId === sessionId && r.kind !== "lightning").reduce((a, r) => a + (r.pts || 0), 0);
  const setName = (i, name) => setPlayers((ps) => { const c = [...ps]; c[i] = { ...c[i], name }; return c; });
  return (
    <div className="panel">
      <p className="note" style={{ marginTop: 0 }}>Team practice runs on one screen: you read, players buzz with the number keys, the buzzing player's name shows on the buzzer, and whoever buzzed types the answer. In NAQT mode a bonus follows each correct tossup (three parts from qbreader, or from your pasted packets); in IAC first-quarter mode it's a one-part bonus, as in the second quarter.</p>
      <div className="row" style={{ maxWidth: 420 }}><span>Team mode</span><button className="toggle" role="switch" aria-checked={settings.teamMode} onClick={() => setSettings((s) => ({ ...s, teamMode: !s.teamMode }))} aria-label="Team mode" /></div>
      <div className="row" style={{ maxWidth: 420 }}><span>Read bonuses after correct tossups</span><button className="toggle" role="switch" aria-checked={settings.bonuses} onClick={() => setSettings((s) => ({ ...s, bonuses: !s.bonuses }))} aria-label="Bonuses" /></div>
      <h2>Players and buzz keys</h2>
      <div className="players">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="row" style={{ justifyContent: "flex-start", maxWidth: 420 }}>
            <span style={{ width: 48 }}>Key {i + 1}</span>
            <input value={(players[i] && players[i].name) || ""} onChange={(e) => setName(i, e.target.value)} placeholder={i === 0 ? "Captain" : "Player name"} aria-label={`Player ${i + 1} name`} />
          </div>
        ))}
      </div>
      <h2>This session</h2>
      {byPlayer.length > 0 && rows.length > 0 ? (
        <table>
          <thead><tr><th>Player</th><th className="num">Heard</th><th className="num">Got</th><th className="num">Powers</th><th className="num">Negs</th><th className="num">Points</th><th className="num">Celerity</th></tr></thead>
          <tbody>{byPlayer.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{p.n}</td><td className="num">{p.correct}</td><td className="num">{p.powers}</td><td className="num">{p.negs}</td><td className="num">{p.pts}</td><td className="num">{p.cel.toFixed(2)}</td></tr>)}</tbody>
        </table>
      ) : <p className="note">No team buzzes recorded yet this session.</p>}
      <p className="note">Team points this session: {teamPts}{bonuses.length ? `, including ${bonuses.reduce((a, r) => a + r.pts, 0)} on ${bonuses.length} bonuses (${(bonuses.reduce((a, r) => a + r.pts, 0) / bonuses.length).toFixed(1)} per bonus)` : ""}. Heard counts only the questions a player buzzed on.</p>
    </div>
  );
}

/* ------------------------------------------------------------------
   App
------------------------------------------------------------------- */
export default function HistoryRoom() {
  const [tab, setTab] = useState("read");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [results, setResults] = useState([]);
  const [players, setPlayers] = useState([{ name: "" }, { name: "" }, { name: "" }, { name: "" }]);
  const [drill, setDrill] = useState([]);
  const [packets, setPackets] = useState([]);
  const [seenList, setSeenList] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [sessionId] = useState(() => Date.now());
  const seen = useMemo(() => new Set(seenList), [seenList]);

  useEffect(() => {
    (async () => {
      const [s, r, p, d, pk, sn] = await Promise.all([
        loadKey(STORE.settings, null), loadKey(STORE.results, []), loadKey(STORE.players, null), loadKey(STORE.drill, []), loadKey(STORE.packets, []), loadKey(STORE.seen, []),
      ]);
      if (s) setSettings({ ...DEFAULT_SETTINGS, ...s });
      if (Array.isArray(r)) setResults(r);
      if (Array.isArray(p) && p.length === 4) setPlayers(p);
      if (Array.isArray(d)) setDrill(d);
      if (Array.isArray(pk)) setPackets(pk);
      if (Array.isArray(sn)) setSeenList(sn);
      setLoaded(true);
    })();
  }, []);
  useEffect(() => { if (loaded) saveKey(STORE.settings, settings); }, [settings, loaded]);
  useEffect(() => { if (loaded) saveKey(STORE.results, results); }, [results, loaded]);
  useEffect(() => { if (loaded) saveKey(STORE.players, players); }, [players, loaded]);
  useEffect(() => { if (loaded) saveKey(STORE.drill, drill); }, [drill, loaded]);
  useEffect(() => { if (loaded) saveKey(STORE.packets, packets); }, [packets, loaded]);
  useEffect(() => { if (loaded) saveKey(STORE.seen, seenList); }, [seenList, loaded]);

  const addResult = useCallback((row) => setResults((r) => [...r, row].slice(-6000)), []);
  const replaceResult = useCallback((id, patch) => setResults((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x))), []);
  const addDrill = useCallback((item) => setDrill((d) => (d.some((x) => x.answer === item.answer) ? d : [...d, item])), []);
  const removeDrill = useCallback((answer) => setDrill((d) => d.filter((x) => x.answer !== answer)), []);
  const clearAll = useCallback(() => setResults([]), []);
  const markSeen = useCallback((id) => setSeenList((l) => (l.includes(id) ? l : [...l, id].slice(-6000))), []);
  const clearSeen = useCallback(() => setSeenList([]), []);
  const toggleSubcat = (s) => setSettings((st) => {
    const next = st.subcats.includes(s) ? st.subcats.filter((x) => x !== s) : [...st.subcats, s];
    return { ...st, subcats: next.length ? next : st.subcats };
  });
  const setSource = (source) => setSettings((st) => {
    const m = MODES.find((x) => x.id === st.mode);
    return { ...st, source, mode: source === "qbreader" && m.needsPackets ? "naqt" : st.mode };
  });

  const tabs = [["read", "Read"], ["stats", "Stats"], ["lists", "Lists"], ["packets", "Packets"], ["team", "Team"]];

  return (
    <div className="hr" data-theme={settings.theme} style={{ "--scale": settings.textScale }}>
      <style>{CSS}</style>
      <header className="top">
        <h1 className="serif"><button className="titlebtn" onClick={() => { setTab("read"); window.scrollTo(0, 0); }} aria-label="Back to the reader">{settings.title}</button></h1>
        <span className="sub">History tossups in NAQT and IAC formats, from real sets, scored like a match.</span>
        <nav className="tabs" aria-label="Sections">{tabs.map(([id, label]) => <button key={id} className="tab" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
        <div className="tools">
          <button className="tool" onClick={() => setSettings((s) => ({ ...s, textScale: Math.max(0.85, Math.round((s.textScale - 0.1) * 100) / 100) }))} aria-label="Smaller text">A−</button>
          <button className="tool" onClick={() => setSettings((s) => ({ ...s, textScale: Math.min(1.8, Math.round((s.textScale + 0.1) * 100) / 100) }))} aria-label="Larger text">A+</button>
          <button className="tool" onClick={() => setSettings((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }))}>{settings.theme === "dark" ? "Light" : "Dark"}</button>
          {tab === "read" && <button className="tool" onClick={() => setSettings((s) => ({ ...s, focus: !s.focus }))}>{settings.focus ? "Show setup" : "Hide setup"}</button>}
        </div>
      </header>
      {tab === "read" && (
        <div className="main" data-focus={settings.focus}>
          <aside className="rail">
            <h2>Questions from</h2>
            <button className="choice" aria-pressed={settings.source === "qbreader"} onClick={() => setSource("qbreader")}>qbreader's database<small>released sets, filtered by level and year</small></button>
            <button className="choice" aria-pressed={settings.source === "packets"} onClick={() => setSource("packets")}>Your pasted packets<small>{packets.filter((p) => p.active).length} active</small></button>
            <h2>Format</h2>
            {MODES.map((m) => {
              const off = settings.source === "qbreader" && m.needsPackets;
              return (
                <button key={m.id} className="choice" aria-pressed={settings.mode === m.id} disabled={off} onClick={() => setSettings((s) => ({ ...s, mode: m.id }))}>
                  {m.label}<small>{off ? "needs pasted packets" : m.note}</small>
                </button>
              );
            })}
            {settings.source === "qbreader" && (
              <p className="note">The short IAC formats need packets you paste in. <button className="btn small quiet" onClick={() => setTab("packets")}>Add packets</button></p>
            )}
            {settings.source === "qbreader" && (
              <div>
                <h2>Difficulty</h2>
                {DIFFS.map((d) => <button key={d.id} className="choice" aria-pressed={settings.difficulty === d.id} onClick={() => setSettings((s) => ({ ...s, difficulty: d.id }))}>{d.label}<small>{d.note}</small></button>)}
                <h2>Subcategories</h2>
                <div className="chips">{SUBCATS.map((s) => <button key={s} className="chip" aria-pressed={settings.subcats.includes(s)} onClick={() => toggleSubcat(s)}>{s}</button>)}</div>
                <h2>Sets from</h2>
                <input className="field" type="number" min="2005" max="2030" value={settings.minYear} onChange={(e) => setSettings((s) => ({ ...s, minYear: Number(e.target.value) || 2010 }))} aria-label="Earliest set year" />
                <h2>Skip sets containing</h2>
                <input className="field" value={settings.excludeSets} onChange={(e) => setSettings((s) => ({ ...s, excludeSets: e.target.value }))} placeholder="e.g. PACE NSC, HFT" aria-label="Skip sets containing" />
                <p className="note">Comma-separated. Use it for sets you've already played through.</p>
              </div>
            )}
            <h2>Reading speed: {settings.wpm} words a minute</h2>
            <input type="range" min="110" max="220" step="5" value={settings.wpm} onChange={(e) => setSettings((s) => ({ ...s, wpm: Number(e.target.value) }))} aria-label="Reading speed" />
            <div className="chips" style={{ margin: "6px 0 8px" }}>
              {[["Regional", 140], ["Nationals", 160], ["Fast", 185]].map(([label, v]) => (
                <button key={label} className="chip" aria-pressed={settings.wpm === v} onClick={() => setSettings((s) => ({ ...s, wpm: v }))}>{label} {v}</button>
              ))}
            </div>
            <p className="note">Moderators at nationals read around 150 to 170. Slower than that inflates your numbers.</p>
            <h2>Options</h2>
            <div className="row"><span>Team mode (buzz with 1 to 4)</span><button className="toggle" role="switch" aria-checked={settings.teamMode} onClick={() => setSettings((s) => ({ ...s, teamMode: !s.teamMode }))} aria-label="Team mode" /></div>
            <div className="row"><span>Auto-read the next question</span><button className="toggle" role="switch" aria-checked={settings.autoAdvance} onClick={() => setSettings((s) => ({ ...s, autoAdvance: !s.autoAdvance }))} aria-label="Auto-advance" /></div>
            <div className="row"><span>Allow skipping (skips count as dead)</span><button className="toggle" role="switch" aria-checked={settings.allowSkip} onClick={() => setSettings((s) => ({ ...s, allowSkip: !s.allowSkip }))} aria-label="Allow skipping" /></div>
            <div className="row"><span>Buzzer sound</span><button className="toggle" role="switch" aria-checked={settings.sound} onClick={() => setSettings((s) => ({ ...s, sound: !s.sound }))} aria-label="Buzzer sound" /></div>
            <h2>Name this room</h2>
            <input className="field" value={settings.title} onChange={(e) => setSettings((s) => ({ ...s, title: e.target.value || "History Room" }))} aria-label="Room name" />
          </aside>
          <ReadView settings={settings} players={players} results={results} sessionId={sessionId} addResult={addResult} replaceResult={replaceResult} drill={drill} packets={packets} seen={seen} markSeen={markSeen} />
        </div>
      )}
      {tab === "stats" && <StatsView results={results} sessionId={sessionId} drill={drill} addDrill={addDrill} clearAll={clearAll} seenCount={seenList.length} clearSeen={clearSeen} />}
      {tab === "lists" && <ListsView settings={settings} drill={drill} addDrill={addDrill} removeDrill={removeDrill} />}
      {tab === "packets" && <PacketsView packets={packets} setPackets={setPackets} />}
      {tab === "team" && <TeamView settings={settings} setSettings={setSettings} players={players} setPlayers={setPlayers} results={results} sessionId={sessionId} />}
    </div>
  );
}
