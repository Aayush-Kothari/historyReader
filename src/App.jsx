// Optional keyless relay to qbreader's public API.
// The app calls qbreader directly first; it only falls back to this if the browser blocks the cross-site request.
const ALLOW = new Set(["random-tossup", "random-bonus", "check-answer", "frequency-list", "query"]);

export default async function handler(req, res) {
  const { path, ...rest } = req.query || {};
  if (!ALLOW.has(path)) {
    res.status(400).json({ error: "That qbreader endpoint isn't relayed" });
    return;
  }
  const qs = new URLSearchParams(rest).toString();
  try {
    const r = await fetch(`https://www.qbreader.org/api/${path}?${qs}`, { headers: { accept: "application/json" } });
    const data = await r.json().catch(() => ({}));
    res.setHeader("Cache-Control", "no-store");
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: `Couldn't reach qbreader: ${e.message}` });
  }
}
