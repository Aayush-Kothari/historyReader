# History Room (no keys)

Pyramidal history practice in NAQT and IAC formats, with nothing to pay for and no API keys. Questions come from qbreader's public database (released sets, filtered by level, subcategory and year) or from packets you paste in. Answers are judged by qbreader's answer checker, with prompts, and fall back to a local checker if it's unreachable. Stats persist in the browser.

## Deploy

Any static host works: Vercel, Netlify, GitHub Pages, or a folder on a school server.

- **Vercel (recommended):** push this folder to GitHub, import it in Vercel, deploy. Nothing to configure. The `api/qb.js` relay is included automatically and is only used if a browser blocks the direct request to qbreader.
- **Static host without functions:** run `npm install` then `npm run build`, and upload the `dist` folder. If a browser blocks direct calls to qbreader, questions won't load there; use Vercel instead.

## Run locally

`npm install`, then `npm run dev`.

## Pasting packets

Under Packets, paste text in the usual packet format:

```
1. Question text ... (*) ... For 10 points, name this ...
ANSWER: Otto von Bismarck [accept Bismarck]

2. Bonus leadin. For 10 points each:
[10] Part one.
ANSWER: first answer
[10] Part two.
ANSWER: second answer
[10] Part three.
ANSWER: third answer

Lightning: Roman emperors
1. First emperor of Rome.
ANSWER: Augustus
...
---
```

- `(*)` marks power. In fourth-quarter questions, `(**)` marks the 30-point line and `(*)` the 20-point line; unmarked fourth-quarter questions get lines at 30% and 60% of the way through.
- A block starting with `Lightning: <theme>` and ending with `---` becomes a 60-second round.
- Packets are stored in the browser only. Don't paste sets you aren't allowed to have.

## What's where

- `src/App.jsx`: the whole app.
- `api/qb.js`: optional keyless relay to qbreader.
