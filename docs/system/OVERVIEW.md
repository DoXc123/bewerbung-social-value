---
covers: [vote-service/src/**, vote-service/public/**, vote-service/package.json, vote-service/tsconfig*.json]
verified: 5bf8944
---
# Application — system overview
<!-- cap 150 lines; present tense. Subsystems get their own docs/system/<subsystem>.md (cap 300). -->

## What it does
The repo is a showcase for a full-stack (TypeScript / Node.js) job application.
It holds two code samples extracted from private projects (`whitesea-core/`,
`voicepptx/`), a write-up (`workflow/`), and one service built from scratch,
`vote-service/`. The root `README.md` says what each piece is and how finished it
is. This overview covers the one live subsystem, `vote-service/`.

`vote-service` counts votes in contests. A contest has a fixed list of options. A
voter, identified by a server-issued signed cookie, may cast one vote per contest,
and each phone number one vote per contest. A vote counts only after a 6-digit
code sent by SMS is confirmed; the SMS is mocked (logged, and in `SMS_MODE=demo`
also shown on the page). It serves two small pages: the vote, and a Features page that explains its rules. The seeded contest, "Seth Krämer eine Chance geben"
with the options Yes / Absolutely / For Sure, is a joke whose tally means nothing;
it exists to show the machinery.

## How it's built (components, data flow)
Plain functions, one per layer. Only `server.ts` knows about HTTP.

```
browser ──HTTP──► server.ts ─┬─ ratelimit.ts  (per-address and per-number counters)
 (public/ + app.js)          ├─ identity.ts   (signed cookie → voter id)
                             ├─ validate.ts   (unknown → VoteInput / ConfirmInput, phone → +49…/+44…)
                             ├─ verify.ts     (HMAC of number and code, new codes, masking)
                             ├─ sms.ts        (SmsSender; the only one is a logging mock)
                             └─ store.ts      (SQLite: contests, options, pending_votes, votes)
```

The page is `public/index.html` + `style.css` and a TypeScript client
(`src/client/app.ts` for the DOM, `view.ts` for logic that needs no browser,
`theme.ts` for the Auto / Light / Dark switch, which sets `data-theme` on `<html>`). It is
compiled by its own config (`tsconfig.client.json`, DOM types) into `dist/public/`.
A second page, `/features` (`public/features.html` + `src/client/features.ts`), shows each
rule with the live settings from `GET /settings` and the code that enforces it, from
`snippets.json`. The build cuts that file from `// feature:<id>` … `// end feature`
regions in `src/` (`build-snippets.ts`, `snippets.ts`) and fails on a missing or broken marker.
`server.ts` reads the page files once at startup and serves them only at the exact
paths in `PAGE_FILES` (`/`, `/features`, their scripts, `/style.css`, `/snippets.json`) with a strict
`Content-Security-Policy`.

`POST /votes` runs: rate limit, identity (new-voter rate limit if no valid
cookie), content type, body size, JSON parse, `parseVote` (normalises the number),
codes-per-number limit (keyed by the number's hash), `store.startVote`, then
`sms.send`. It answers `202` with the masked number and, in demo mode, the code.
Nothing is counted yet. `POST /votes/confirm` runs: rate limit, `identity.peek`
(no cookie: nothing to confirm, and no identity is issued), content type, size,
parse, `parseConfirm`, `store.confirmVote`. Cheapest checks come first. Refusals
carry a `reason` word the page maps to a sentence (`view.ts` `refusal`). `GET /contests/:id` returns the contest, its tally and `yourVote`
(`identity.peek` reads the cookie without issuing one, so a read never creates a voter), plus `smsDemo: true` in demo
mode, which makes the page suggest test numbers (07700 900001, …). `GET /settings` returns the non-secret settings
(SMS mode, code rules, the named `limits`, proxy trust) for the Features page.

Integrity lives in the schema (`store.ts`): `UNIQUE (contest_id, voter_id)`,
`UNIQUE (contest_id, phone_hash)` and `FOREIGN KEY (contest_id, choice) → options`
(on `pending_votes` too). `cast` also checks the contest exists and is open, and
maps the database's constraint errors to `duplicate`, `phone_used` and
`unknown_option`. `startVote` refuses up front what could never be confirmed, so no
SMS is sent for it, and replaces an earlier pending vote of the same voter (new
code, attempts reset). `confirmVote` runs in one `BEGIN IMMEDIATE` transaction:
expired → delete; wrong code → count the attempt, the fifth deletes; right code →
delete the pending row and `cast` it. Numbers and codes are stored only as HMACs
with `VOTE_SECRET` (`verify.ts`); the code hash is bound to contest and voter. Contests are created by `createContest` (owner code: the seed
script), in one transaction with their options.

`main.ts` reads settings with `config.ts`, builds the store, identity, verifier,
the logging SMS sender and the server, and shuts down on SIGINT/SIGTERM.
`config.ts` refuses `SMS_MODE=demo` together with `NODE_ENV=production`. `seed.ts` and `close.ts` are the owner's commands
for creating and closing contests. Node runs the compiled `dist/*.js`, never the
`.ts` files.

## Run / test
- `npm test` (in `vote-service/`): build (server `tsc`, client `tsc`, copy `public/`, cut `snippets.json`),
  then `node --test "dist/**/*.test.js"`. 143 tests. The server tests start a real
  server on a free port and use `fetch`.
- `npm run build && npm run seed -- contests.json && npm start` with `VOTE_SECRET`
  set, then open the printed address. Settings and the API are in `vote-service/README.md`.

Mutation check (2026-10-07): `python3 scripts/mutation-check.py` in `vote-service/` applies one-line mutants to
`store.ts` and `contests-file.ts`, one rule broken at a time, and reports what caught each (a test, the
compiler, a timeout) or that it survived. The first run found 5 survivors among the first 33 mutants (title
length and whitespace, no ROLLBACK after a refused contest, the status CHECK); each now has a test. The SMS
step added 19 mutants (2026-10-07); one survived (the "duplicate beats phone_used" ordering, which relied on
`ORDER BY … LIMIT 1` that no test could pin) and was fixed in the code by an aggregate. Current run: 53
mutants, 48 killed by a test, 5 by the compiler, none survived (re-run after the feature markers went into
`store.ts`). Re-run it after changing either file: it fails (exit 1) on a survivor and
exits 2 when a mutant's text no longer matches the source, which means the list needs updating. `server.ts` was
checked by hand earlier and is not in the script.

## Traps (subsystem-specific, don't rediscover)
- **This machine's Node 22.22 has no TypeScript support**, even with
  `--experimental-strip-types`. The build is `tsc` to `dist/`. TypeScript is 7.0.2.
- **SQLite foreign keys are off by default in SQLite itself.** `node:sqlite` turns
  them on; a test goes around `store.ts` to keep that true.
- **`node:sqlite` rows have no prototype**, so strict `deepEqual` fails on them.
  The store maps rows to plain objects.
- **A unique violation is reported before a foreign-key violation.** A voter who
  already voted and sends an unlisted option gets `duplicate`, not `unknown_option`.
  The vote is refused either way.
- **`node:sqlite` is experimental** and prints a warning on start.
- **When both UNIQUE rules on `votes` break, SQLite names the phone one.** Same voter and same number
  again reported `phone_used`. `cast` decides by looking up the voter's own vote instead of parsing
  the error message.
- **`CREATE TABLE IF NOT EXISTS` keeps an old table as it was.** A `votes.sqlite` from before the SMS
  step has no `phone_hash`; `openStore` checks `pragma_table_info('votes')` and refuses to start on it.
- **The page is served from `dist/public/`.** A CSS or HTML edit is invisible until `npm run build`
  copies `public/` again. A stale copy once made the new forms look unstyled in a browser check.
- **Behind a proxy, trust the LAST `X-Forwarded-For` entry.** Earlier entries are
  client-supplied. `TRUST_PROXY` is off unless set to exactly `1`.
- **An empty `PORT=` used to parse as 0** (a random port). `config.ts` requires digits.
- **Server tests must register their server for cleanup** (`cleanups` in
  `server.test.ts`). A failing assertion otherwise leaves a server open and the whole
  run hangs.
- **The pages' DOM code has no automated test.** `view.ts` is unit-tested; `app.ts`, `theme.ts` and
  `features.ts` were checked in headless Chromium driven over the DevTools protocol (a throwaway script,
  not in the repo), light and dark. Re-check in a browser after changing them.
- **The mutation check leaves `dist/` built from its last mutant.** It restores the source, not the build.
  Run `npm run build` before `npm start` after a mutation run.
- **Feature markers are live comments.** `// feature:<id>` … `// end feature` (and `-- ` inside the SQL in
  `store.ts`) decide what the Features page shows. Moving a rule means moving its markers; the build fails
  if one goes missing.
- **The result bars only animate if they start at 0.** `render` in `app.ts` sets every `.fill` to `0%`, forces a
  layout (`offsetWidth`), then sets the real width. Skip that and the CSS transition has nothing to grow from.
  A screenshot taken straight after load catches the bars mid-growth.
- **The CSP blocks `style="..."` attributes and inline scripts.** Setting
  `element.style.width = …` from script is allowed (CSSOM), `setAttribute("style", …)`
  is not. The page also uses `textContent` only, never `innerHTML`.
- **Two TypeScript configs.** `tsconfig.json` (Node, no DOM types) excludes
  `src/client/app.ts`, `theme.ts` and `features.ts`; `tsconfig.client.json` (DOM, no Node types) excludes tests.
  `view.ts` is compiled by both and must import nothing from Node.
- **A new `VOTE_SECRET` makes every voter look new** and lets them vote again.
  Restarting with the same secret keeps them (checked by hand).
- **`HEAD /` is 405.** Use GET when checking headers (`curl -D -`, not `curl -I`).
