# Application

## Über mich

Mein Name ist Seth Krämer, ich bin 25 Jahre alt und studiere Physik im Bachelor an der Uni-Köln.
Ich bin gebürtiger Kölner und interessiere mich schon länger für Softwareentwicklung und KI. Im Rahmen meines Physikstudiums lerne ich das systematische Denken und Prozessoptimierung und freue mich dieses in der echten Arbeitswelt zu erproben.
In meiner Freizeit beschäftige ich mich mit Spielentwicklung/App-Entwicklung und Ideen des Effektiven Altruismus sowie philosophischen Texten.

Social Value interessiert mich da Sie sich für soziale Projekte einsetzen, und das über technologisch gestützte Abstimmungen. Damit können die Menschen, welche selbst dort arbeiten oder davon betroffen sind, aktiv mitentscheiden. Sie wirken für mich dadurch als menschennah und aufgeschlossen und das finde ich sehr wichtig. Ich sehe in Social Value also die Möglichkeit, in praktischer Erfahrung, Ideen des Effektiven Altruismus im Geschäftsalltag zu erforschen.

Workshop-Präsenz und Sprint-Planung ist für mich kein Problem. Teilzeit passt mir sehr gut, da ich noch studiere. Ich habe an 15 Std./Woche gedacht, kann aber auch auf 20 Std./Woche hochgehen. Zu Klausurenphasen wäre ich allerdings etwas im Studium eingespannt. Das ist meist zu Ende der Vorlesungszeit ca. 2 Wochen.
Der Start im Dezember passt mir gut.

Ich arbeite selber schon länger mit LLMs. Zuerst habe ich recht viel mit GPT 3 und 4 gearbeitet. Zu diesem Zeitpunkt waren die Modelle noch recht schwach, aber es war trotzdem spannend kleinere Python-Programme zu schreiben. Später hab ich dann mit Gemini gearbeitet und Prompt Engineering gelernt im Rahmen von "Gems". Diese habe ich auf mein Studium zugeschnitten.
Jetzt seit ca. 1 Jahr arbeite ich mit Claude Code. Hierbei habe ich verschiedene kleine Applikationen erstellt sowie auch größere Projekte in Angriff genommen. 
Im Verlauf des Jahres haben KIs enorm an Kompetenz zugenommen, einhergehend damit aber auch die Gefahr von Cognitive Offloading. Daher pflege ich selbst den Umgang, dass ich darauf achte mich in die Themen und konzeptionelle Struktur vorher einzuarbeiten und das Human-in-the-Loop-Prinzip beizubehalten. So kann ich die KIs effizienter lenken durch präzise Prompts und darauf achten, dass ich stets die Kontrolle behalte.
Außerdem arbeite ich mit eigenen spezialisierten Claude-Code-Umgebungen, um KV-Cache zu optimieren und Context-Drift zu vermeiden.
Ein paar Beispiele meiner Projekte finden Sie in diesem Repository sowie ein Projekt, welches auf SocialValue etwas zugeschnitten ist.

Ich freue mich von Ihnen zu hören und hoffe, dass ich Ihr Team unterstützen kann.

## About this repository

Showcase repo for a full-stack (TypeScript / Node.js) job application. It holds
code samples extracted from larger private projects, one write-up, and a small
service built from scratch. Each piece says plainly what it is, how finished it
is, and which parts are TypeScript and which are Node.js.

## At a glance

| Piece | What it is | Status | Language | Tests |
|---|---|---|---|---|
| [`whitesea-core/`](whitesea-core/) | Simulation core of a hex-grid strategy game | **Work in progress**: the game is unfinished, this is the engine part as it stands | TypeScript (strict) | 227 (vitest) |
| [`voicepptx/`](voicepptx/) | Telegram bot: voice message in, PowerPoint out | **Quick trial**: a prototype to see whether the idea works end to end, not a hardened product. The original runs on a small server | JavaScript (ESM) on Node.js | 18 (`node:test`) |
| [`workflow/`](workflow/) | Write-up of how AI tools are used with control | Written from the real setup | Markdown (the tooling it describes is Python and shell) | n/a |
| [`vote-service/`](vote-service/) | Small vote-counting service with integrity rules and an SMS confirmation step (sender mocked) | **Working, not deployed.** Built from scratch, one layer at a time, with a small voting page and a Features page. Its README lists what it does not stop | TypeScript (strict) on Node.js and in the browser, no runtime dependencies | 143 (`node:test`) |

## How the repository is laid out

```
application/
├── README.md          this page: what each piece is and how finished it is
├── vote-service/      written for this repo: TypeScript / Node.js vote counter plus a small page
│   └── DESIGN.md      in German: the design choices, their trade-offs, and an attacker's view of the service
├── whitesea-core/     extract: simulation core of a hex-grid strategy game (TypeScript)
├── voicepptx/         extract: voice-message-to-PowerPoint Telegram bot (JavaScript on Node.js)
├── workflow/          write-up of the AI workflow, with SOURCES.md tracing each claim to a file
├── docs/system/       OVERVIEW.md: how vote-service is built today, plus the traps already found
├── STATE.md           where the last work session stopped and what comes next
├── CLAUDE.md          standing instructions the AI assistant reads at the start of every session
└── .claude/           turns on the shared plugin (skills and hooks) that the workflow write-up describes
```

**The three code pieces** are independent: each has its own `package.json`, its own tests and its own README, and
none imports from another. Each installs and tests on its own with `npm install` and `npm test` (voicepptx's deck
step is the exception, see below). If you only have five minutes, read `vote-service/README.md`, then
`vote-service/src/store.ts` and its test file: that is where the rules that must not break are enforced.
`vote-service/DESIGN.md` (German) says why it is built this way and what it does not stop.

**Inside `vote-service/`**, one file per layer, with its test beside it: `server.ts` (HTTP), `ratelimit.ts` and
`identity.ts` (who is asking, how often), `validate.ts` (is the request well-formed), `store.ts` (SQLite and its
constraints), and `src/client/` plus `public/` (the page). `vote-service/README.md` has the full table and the
request path.

The working files (`STATE.md`, `CLAUDE.md`, `docs/system/OVERVIEW.md`) are part of the workflow that `workflow/`
describes, so they are left in on purpose: they answer "how does the next session know where this stands". The
fuller set the workflow uses elsewhere (vision, roadmap, glossary, decision log, archive) is left out of this repo
to keep it small.

## Where the Node.js and the TypeScript are

The two code samples are different on purpose, and neither is both.

**TypeScript: `whitesea-core/`**
- About 3,000 lines in `src/` and 2,900 lines of tests, compiled with `strict: true`.
- It is pure TypeScript with **no Node.js APIs and no runtime dependencies**.
  Nothing in `src/` imports `fs`, `process` or any `node:` module.
- Node.js appears only as tooling: `npm` installs it, `tsc` typechecks it, and
  `vitest` runs the tests on Node. In the full project's web build the same code
  runs in the browser, under a rendering layer that is not included here.
- What it shows: modelling a domain with types (a `Result` type for malformed input,
  a clock the simulation is driven by, pure functions in place of hidden state), and
  testing that logic.

**Node.js: `voicepptx/`**
- About 1,800 lines in `src/` plus 380 lines of tests and scripts, in plain JavaScript.
  **It is not TypeScript**, so nothing checks the shape of its data at compile time.
- It uses Node built-ins directly: `node:fs/promises` for state files,
  `node:child_process` to run the `claude` CLI, `node:path`, `node:os`, and
  `node:test` for its tests.
- Packages: `telegraf` (Telegram), `openai` (speech to text and back), the MCP SDK,
  `pptxgenjs` (building the deck).
- What it shows: an async server that stays responsive while a slow job runs for
  minutes, a timeout that had to be raised, an atomic state write (temp file plus
  rename), and recovery of half-finished sessions on start-up.

**Both: `vote-service/`**
- About 1,960 lines in `src/` (620 of them the two browser pages) and 1,870 lines of tests,
  compiled with `strict: true`. It uses
  Node's built-in `node:http`, `node:sqlite`, `node:crypto` and `node:test`, so the
  only dependencies are the dev-only `typescript` and `@types/node`.
- What it shows: a typed HTTP backend where the rules that must not break (one vote
  per voter and per phone number, a vote only for a listed option) are enforced by the database schema,
  with request validation, a server-issued signed-cookie identity, size limits and
  rate limits in front of it. The page it serves is plain TypeScript with no framework,
  under a strict Content-Security-Policy.
- It is the one piece written for this repo. The back ends I have built elsewhere
  are in Python (a FastAPI service and two bots), and none of that code is included here.

## How to read the status labels

- **whitesea-core is unfinished.** WhiteSea is a game still in design and build.
  Only the engine layer is extracted here. There is no UI, no rendering and no
  finished game around it, and parts of its design are still open.
- **voicepptx is a trial.** It works end to end, but it has 4 test files, stores
  sessions as JSON files, and is not covered by CI. Its README lists the limits and
  what would change.
- **Neither sample is runnable as a product from this repo.** whitesea-core
  typechecks and tests on its own. voicepptx passes its tests, but its deck step needs
  a folder that stays in the private source project.

Both samples were extracted by copying files into a fresh repo without history,
after a check for secrets and personal data. Each README lists what was left out.
