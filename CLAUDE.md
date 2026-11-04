# Application

Showcase repo for a full-stack (TypeScript / Node.js) job application: a small vote service plus a write-up of the AI workflow behind it.
Shape: product.

## Where things are
| Path | What | Read when |
|---|---|---|
| STATE.md | now / next / questions | session start (/resume) |
| docs/system/OVERVIEW.md | current implementation + traps | session start, before debugging |

This repo is deliberately slimmer than the workspace it was built in: no VISION, ROADMAP, GLOSSARY, KNOWN-ISSUES,
decisions or archive. Hosting is decided: none, the service runs locally and stays "not deployed".

## Hard rules
- `vote-service/` has no runtime dependencies: Node built-ins only (`node:http`, `node:sqlite`, `node:crypto`).
  Dev-only `typescript` and `@types/node` are the whole `package.json`.
- The vote integrity rules live in the SQLite schema (`store.ts`: `UNIQUE`, `FOREIGN KEY`), never only in app code.
  A rule that matters gets a test that goes around `store.ts`.
- One layer per file, and only `server.ts` knows HTTP. Cheapest check first on `POST /votes`.
- Data from outside (request bodies, the server's answer in the page) arrives as `unknown` and is parsed into a
  type before use.
- The page draws with `textContent` only (never `innerHTML`) and uses no inline style or script, because the CSP
  forbids both. Changing `src/client/app.ts` means re-checking it in a browser: it has no automated test.
- `whitesea-core/` and `voicepptx/` are extracts from private projects. Fix and describe them; don't grow them.
  `whitesea-core/src` stays free of Node APIs, and `voicepptx` stays plain JavaScript (the README says so).
- The README status labels (work in progress, quick trial, not deployed) stay honest. Re-measure test counts and
  line counts before quoting them; don't copy them from another doc.
- The README's `Über mich` section is the owner's words, in German, and stays at the top. Never write or reword
  it, only scaffold.
- No secrets or personal data in any commit. Run the sweep before any public flip, and flip only on the owner's yes.

## Commands
- test: `cd vote-service && npm test` (build, then `node --test`). The samples: `cd whitesea-core && npm test`,
  `cd voicepptx && npm test`.
- run: `cd vote-service && export VOTE_SECRET=<32+ chars> && npm run build && npm run seed -- contests.json && npm start`
  → http://127.0.0.1:3000. Same `VOTE_SECRET` between restarts.
