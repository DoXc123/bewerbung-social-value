# vote-service

**Status: working, tested, not deployed.** A small vote-counting service in
TypeScript on Node.js, with no runtime dependencies. It was built together with
the owner, one layer at a time, as the owner learned the TypeScript and Node.js
pieces. It is a showcase of how the integrity rules are layered, not a
production voting system (see [What it does not stop](#what-it-does-not-stop)).

- About 1,960 lines in `src/` (including about 620 lines of browser code in TypeScript
  for two pages), about 1,870 lines of tests, **143 tests** (`node:test`).
- A vote counts only after an **SMS code** confirms the phone number, and the
  database allows one vote per number per contest. The SMS is **mocked**: no
  message ever leaves the service (see [The SMS step](#the-sms-step)).
- `strict: true` TypeScript. The only dependencies are dev-only: `typescript`
  and `@types/node`.
- Storage is SQLite through Node's built-in `node:sqlite`. No web framework: the
  server is `node:http`.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
npm test                                   # typecheck, build, run the tests

export VOTE_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
npm run build
npm run seed -- contests.json              # create the contest (safe to repeat)
npm start                                  # open http://127.0.0.1:3000
npm run close -- chance                    # later: end the contest, keep its results
```

In the default `SMS_MODE=demo` the page shows the code that the SMS would have
carried, so you can vote without a phone. No real number is needed either: the
page suggests `07700 900001`, `07700 900002` and so on, a UK range Ofcom keeps for
fiction. Each number votes once per contest, so give every tester their own. A `votes.sqlite` made before the SMS
step is refused at start (it lacks the phone rule): move it away and seed again.

Keep `VOTE_SECRET` the same between restarts. A new secret makes every returning
voter look new, and they can vote again.

Settings come from environment variables: `VOTE_SECRET` (required, at least 32
characters), `PORT` (3000), `HOST` (`127.0.0.1`), `DB_PATH` (`votes.sqlite`),
`TRUST_PROXY=1` (only behind a reverse proxy you control), `NODE_ENV=production`
(turns on `Secure` cookies, which need HTTPS), `SMS_MODE` (`demo`: the code is
shown on the page and logged; `log`: only logged. `demo` is refused together
with `NODE_ENV=production`, because it hands every code to whoever asks).

## API

| Request | Does | Answers |
|---|---|---|
| `GET /` | The voting page (also `/app.js`, `/view.js`, `/style.css`) | `200` |
| `GET /contests/:id` | Title, options, status, tally, and `yourVote` (what the caller chose, or `null`); in demo mode also `smsDemo: true` | `200`, or `404` |
| `POST /votes` with `{"contestId": "...", "choice": "...", "phone": "..."}` | Step 1: keeps the vote as pending and sends a 6-digit code to the number. Counts nothing yet | `202`, `400`, `404`, `409`, `413`, `415`, `429`, `502` |
| `POST /votes/confirm` with `{"contestId": "...", "code": "123456"}` | Step 2: the right code turns the pending vote into a counted one | `201`, `400`, `404`, `409`, `410`, `413`, `415`, `429` |
| `GET /settings` | What this instance is set to, for the Features page: SMS mode, code length, expiry and tries, the rate limits, proxy trust. Never the secret, host or database path | `200` |
| `GET /features` | The Features page (also `/features.js`, `/snippets.json`) | `200` |

The voter is **never** in the request body. The server issues a signed cookie on
the first request and reads it back afterwards. A body containing `voterId` is a 400.
A refused vote answers `{"error": "...", "reason": "..."}`: the sentence is for
people, the `reason` (`phone_used`, `wrong_code`, `expired`, …) is for the page.

## The SMS step

Social voting campaigns usually confirm a vote by SMS: one phone number, one
vote. This service does the same, with the sending mocked.

1. `POST /votes` normalises the number (German mobiles `015x/016x/017x`, UK
   mobiles `07…`, typed with or without `+49`/`0049`/`+44`, spaces, dashes or a
   `(0)`) and refuses anything else, landlines included.
2. Before anything is sent, the database is asked whether this voter or this
   number has already voted in the contest, so no SMS is paid for a vote that
   could never count.
3. The vote is stored as **pending**, with a code that is valid for 10 minutes. A
   second request from the same browser replaces it (new code, new choice).
4. `POST /votes/confirm` with the right code moves it to `votes`. A wrong code
   uses one of 5 attempts. The fifth wrong code, or an expired one, deletes the
   pending vote, and the voter starts again with a new code.

What is stored: the number and the code only as **HMAC-SHA256 with the server's
secret** (`verify.ts`). There are only about a billion mobile numbers, so a plain
hash could be reversed by trying them all; a keyed one can't without the secret.
A test reads every row of the `votes` and `pending_votes` tables and checks that
neither a number nor a code is in them. The code hash is bound to the contest and
the voter, so a code read off someone else's screen does not work from another
browser.

The sender is an interface (`sms.ts`: `send(to, text)`, async, may fail). The only
implementation logs the message. A real provider would be one more implementation;
if it fails, the pending vote is dropped and the voter gets a `502`.

## The pages

Two pages, served by the same server, so the voter cookie works and no CORS is
needed. Plain HTML, CSS and TypeScript compiled by `tsc` (no framework). Both
have an Auto / Light / Dark switch (`theme.ts`); Auto follows the system.

- It draws everything with `textContent`, never `innerHTML`, so text from the
  server can't become markup.
- The server answers are checked before use (`parseContest`: unknown in, a typed
  `ContestView` out), the same rule as for incoming requests.
- A strict `Content-Security-Policy` allows only the page's own script and styles
  and connections to itself. Only the exact paths listed in `PAGE_FILES` are served, never a folder.
- After an option is clicked, the options give way to a phone form, then to a
  code form ("Confirm vote"). In demo mode the code appears in a dashed box,
  labelled as a demo. Every refusal has its own sentence ("Wrong code. 3 tries
  left.", "This phone number has already voted in this contest.").
- The seeded contest is a joke: *"Seth Krämer eine Chance geben"* with the options
  `Yes`, `Absolutely`, `For Sure`. Every option is a yes, so the tally means
  nothing. What it demonstrates is the machinery: one vote per phone number, and no
  way to vote for something that isn't an option.

**The Features page** (`/features`, linked under the results) explains each rule
in a sentence, shows what this running instance is set to (`GET /settings`), and
shows the code that enforces the rule. That code is not copied by hand: the
source marks each region with a `// feature:<id>` … `// end feature` comment pair
(`-- ` inside SQL), and `npm run build` cuts the regions into `snippets.json`
(`src/build-snippets.ts`, `src/snippets.ts`). A missing, unknown or unclosed
marker fails the build, so the page cannot show code that no longer runs.
`GET /settings` makes the rate limits public; that is fine for a demo, and the
limits are not a secret that keeps anyone out.

## How the integrity rules are layered

Each layer assumes the one above it can be bypassed. The request path for
`POST /votes`, cheapest check first:

1. **Rate limit per address** (`ratelimit.ts`): too many requests per minute
   (both POSTs share it), `429`.
2. **Identity** (`identity.ts`): a valid signed cookie keeps its voter. A missing
   or forged one gets a new voter, and each address may only create so many
   (`429`).
3. **Content type** must be JSON (`415`). A cross-site form can't send that
   without a CORS preflight, which is never approved.
4. **Body size** at most 1 KB, also while streaming (`413`).
5. **Shape** (`validate.ts`): `unknown` in, a typed `VoteInput` out, with the
   phone number normalised to `+49…`/`+44…` (`400`).
6. **Codes per number** (`ratelimit.ts`, keyed by the number's hash): 3 per hour,
   whichever browser asks (`429`). Every code is an SMS someone pays for.
7. **Rules the database enforces** (`store.ts`):
   - a vote must be for an option that exists in that contest (`FOREIGN KEY`,
     on pending votes too)
   - one vote per voter per contest (`UNIQUE (contest_id, voter_id)`)
   - **one vote per phone number per contest** (`UNIQUE (contest_id, phone_hash)`)
   - the contest must exist and be open

`POST /votes/confirm` runs layers 1, 3, 4 and 5 the same way. Instead of layer 2
it only reads the cookie (no cookie, nothing to confirm: `404`), and instead of
layer 6 the pending vote carries its own 5 attempts and 10-minute expiry.

Layer 7 is the one that can't be raced or forgotten: the constraints live in the
schema, so they hold across processes and even for code that bypasses `store.ts`
(tests do exactly that, for the option rule and the phone rule).

## What it does not stop

- **The SMS is mocked.** `SMS_MODE=demo` shows the code on the page, so in demo
  mode the phone step proves nothing about who holds the phone. It shows the
  mechanism. A real provider (and its cost and delivery failures) is not wired in.
- **One vote per number, not per person.** Someone with several SIM cards or
  virtual numbers gets several votes. Clearing cookies no longer helps (the number
  has voted), but each new number does.
- **The 409 tells whether a number has voted in a contest.** Anyone can type a
  number and learn that. Campaigns usually accept this, since the voter needs the
  answer; hiding it would make "why can't I vote?" unanswerable.
- **Someone can use up another person's codes.** Typing a stranger's number three
  times in an hour sends them three SMS and blocks codes to that number until the
  hour is over. The per-number limit bounds the harassment; it does not prevent it.
- **The rate limits are in memory.** They reset on restart, are per process, and
  use fixed windows (a burst of up to twice the limit across a window boundary).
  Several servers would need a shared store.
- **No HTTPS in the app.** A reverse proxy (Caddy, nginx) provides it. Behind one,
  set `TRUST_PROXY=1` so limits use the real client address.
- **Contests are made and closed by the owner, not over HTTP.** `npm run seed` and
  `npm run close` run on the machine with the database.
- **A vote can't be changed.** A second vote from the same voter is a `409`, even
  with a different choice.
- **Rotating `VOTE_SECRET` makes every voter look new**, and every number too: the
  phone hashes change, so each number could vote once more.
- **No CORS headers.** The page and the API must share an origin.
- **The page's DOM code is checked by hand, not by the test suite.** Its logic
  (`view.ts`) is unit-tested. The clicking and drawing (`app.ts`) was verified in
  headless Chromium, light and dark: once for the first page, again for the SMS
  step (pick, landline refused, code, wrong code, right code, same number after
  clearing cookies), and once more for the colour switch (Auto / Light / Dark, kept
  across a reload). `HEAD` requests to the page get `405`.
- **Never load-tested, never deployed, not security-audited.** `node:sqlite` is
  marked experimental in Node 22 and prints a warning at start.

## Mutation check

Passing tests say little about whether the tests would notice a broken rule. So
`scripts/mutation-check.py` breaks the rules on purpose, one at a time (drop the
`UNIQUE`, skip the closed check, turn a `LEFT JOIN` into a plain `JOIN`, accept any
SMS code, never expire one, and so on: 53 one-line edits to `store.ts` and
`contests-file.ts`), runs `npm test` for each and puts the file back. A mutant that **survives** is a rule without a test.

```bash
npm ci
python3 scripts/mutation-check.py          # all mutants, about four minutes
python3 scripts/mutation-check.py S06 C09  # only these
```

The first run found five survivors (whitespace-only title, the title length limit, no
`ROLLBACK` after a refused contest, the `status` constraint), and each now has a test.
The SMS step added 19 mutants. One survived: "you already voted" was meant to win over
"this number has voted" when both apply, but that relied on `ORDER BY … LIMIT 1`, and
no test could force the other row order. The query now uses `MAX(voter_id = ?)`, which
gives the same answer in any order, and the mutant is killed. Current run: 48 killed by
a test, 5 by the compiler, none survived. The 5 are stopped by TypeScript, not by a test; the script reports
those separately because the type system pinning a rule is not test coverage. The
script is Python with the standard library only, the one non-Node file in this
service. It refuses to run if the two target files have uncommitted changes. It covers
`store.ts` and `contests-file.ts` only; the server layer was checked by hand earlier.

## Files

| File | Job |
|---|---|
| `scripts/mutation-check.py` | The mutation check above |
| `src/server.ts` | The HTTP front door: two routes, calls the layers in order |
| `src/store.ts` | SQLite: contests, options, pending and counted votes, and their constraints |
| `src/validate.ts` | Request shape: `parseVote`, `parseConfirm`, `parsePhone` (DE and UK mobiles) and the shared text rules |
| `src/identity.ts` | Signed-cookie voter identity (HMAC-SHA256) |
| `src/ratelimit.ts` | Fixed-window counter per key |
| `src/verify.ts` | The SMS step's secrets: phone and code hashes (HMAC-SHA256), new codes, masking a number |
| `src/sms.ts` | The `SmsSender` interface and the one sender there is: a mock that logs |
| `src/config.ts` | Reads and checks the environment settings |
| `src/client/view.ts` | The page's logic with no browser needed: checks the server's answer, picks what to show |
| `src/client/app.ts` | The vote page's DOM code: fetch, draw, send a vote |
| `src/client/features.ts` | The Features page's DOM code: settings, sections, code blocks |
| `src/client/theme.ts` | The Auto / Light / Dark switch both pages share |
| `src/snippets.ts`, `src/build-snippets.ts` | Cut the marked code regions into `snippets.json` at build time |
| `public/` | `index.html`, `features.html` and `style.css`, copied beside the compiled scripts |
| `src/contests-file.ts` | Checks and seeds the contest list from JSON |
| `src/result.ts` | The `Result` type (success with a value, or failure with a reason) |
| `src/main.ts`, `src/seed.ts`, `src/close.ts` | Entry points: start the server, create contests, close a contest |

Each file has a `.test.ts` beside it (except `result.ts`, which is a type, and
the entry points, `app.ts`, `features.ts` and `theme.ts`, which only wire things together).
