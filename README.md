# History Reader

A buzzer-based history practice tool for quiz bowl players, covering NAQT tossups and every IAC History Bowl and History Bee format. Real questions from released sets, read pyramidally with a hidden power mark, judged like a match, tracked by subcategory. No accounts, no API keys, all free.

**Live site:** https://history-readder.vercel.app/

## Formats

| Format | Scoring | Source |
|---|---|---|
| NAQT tossup | 15 in power, 10 after, −5 for a wrong interrupt | qbreader or your packets |
| IAC fourth quarter | 30, 20 or 10 by buzz point, no negs | qbreader or your packets |
| IAC first quarter | Short questions worth 10, no negs | your packets |
| IAC History Bee | 1 point each, exit at 8, approximate exit bonus | your packets |
| IAC 60-second round | 8 questions on one theme, 60 seconds, 20-point sweep | your packets |

qbreader only holds released academic sets (PACE, housewrites, ACF), so the short IAC formats need packets you paste in yourself. Fourth-quarter practice on qbreader questions uses the packet's power mark as the 20-point line and adds a 30-point line at half that distance.

## Question sources

### qbreader's database

Pulled live through [qbreader's public API](https://www.qbreader.org/tools/api-docs/), filtered by:

- **Difficulty:** Regular (qbreader 2–3, IS-set level), Hard (4, regional playoffs), Nationals (5, HSNCT and NSC level).
- **Subcategory:** American, European, World, Ancient, Other, any combination.
- **Year:** a "sets from" cutoff, default 2019.
- **Set names to skip:** comma-separated substrings, for sets you've already played through.

Every question you've been read is remembered on your device and **never comes back**. NAQT mode only pulls questions that carry a power mark. Answers go to qbreader's own judge, which handles prompts the way a moderator does; if it's unreachable, a local checker takes over and the result is marked as locally judged.

### Your packets

Paste packet text under the Packets tab. The parser picks up tossups, bonuses with `[10]` parts (for team mode), and 60-second rounds. Packets stay in your browser. Don't paste sets you aren't allowed to have.

```
1. Question text ... (*) ... For 10 points, name this ...
ANSWER: Otto von Bismarck [accept Bismarck; prompt on Otto]

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
2. Emperor who built a namesake wall in Britain.
ANSWER: Hadrian
---
```

- `(*)` marks power. In fourth-quarter questions, `(**)` marks the 30-point line and `(*)` the 20-point line; unmarked fourth-quarter questions get lines at 30% and 60%.
- A block that starts with `Lightning: <theme>` and ends with a line of three dashes becomes a 60-second round.
- Tag a packet with a subcategory when you add it so its questions count in the right column of your stats.

## Keyboard

| Key | Does |
|---|---|
| Space | Buzz (solo mode) |
| 1, 2, 3, 4 | Buzz as that player (team mode) |
| Enter | Submit your answer; or read the next question |
| N | Read the next question |
| S | Skip, if skipping is turned on (counts as dead) |

## Stats and privacy

Everything is stored in the browser's localStorage: results, settings, packets, the drill list, and the list of questions already read. There is no server-side storage and no login. Each person who opens the site sees only their own numbers, and nothing leaves the device except the requests to qbreader. Clearing browser data, or using a private window, wipes them.


## Project layout

```
api/qb.js        optional keyless relay to qbreader
src/App.jsx      the whole app
src/main.jsx     React entry point
index.html
vite.config.js
package.json
```

Built with React and Vite. No other runtime dependencies.

## Credits

- Questions, frequency lists and answer judging come from [qbreader](https://www.qbreader.org), which serves released question sets to the community. This project is not affiliated with qbreader, NAQT, PACE or IAC; format names are used descriptively.
- Bee exit scoring is an approximation of IAC's; treat the Bee mode as buzz practice, not an official simulation.

## License

GPL-3.0. See `LICENSE`.
