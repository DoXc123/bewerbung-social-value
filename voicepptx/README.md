# voicepptx

A Telegram bot that turns a spoken brief into a PowerPoint deck: **voice message in, `.pptx` out**,
with a short spoken-style design conversation in between and a "talk to iterate" loop afterwards.

Plain JavaScript (ESM) on Node. About 1.9k lines in `src/` (2.3k with tests and scripts), 18 tests. Extracted from a private
monorepo with history dropped.

**Status: deployed, and built quickly.** The original has run as a systemd service on a small server since
2026-06-23. It was built fast to find out whether a voice-to-deck loop works end to end, and it does, but it
has few tests, no CI, JSON files for storage and unchecked data shapes. The "Honest limits" section below
lists them.

**Scope of this extract:** it is a code sample, not a runnable copy. The deck-generation step loads a
`pptx_skill/` folder from a reference directory of the original monorepo (see `config.l3Dir`), which is not
included here, so the bot cannot build decks from this checkout alone. The 18 tests do not need it
and pass on their own (`npm ci && npm test`).

**Left out of this extract:** the real `.env` and any secrets, the runtime `state/` and `out/` folders,
logs, `node_modules/`, and the systemd unit file (it names the server user and deploy path). A few comments
were reworded to remove personal context about the people it was built for. No code was changed; the edits
outside comments are `package.json`, which now lists `zod` (imported by the MCP server, but it used to
arrive only through the MCP SDK), and `package-lock.json`, after a non-breaking `npm audit fix`.

## What it does

1. You send a voice message. Whisper transcribes it (`src/transcribe.js`). In `translate` mode any
   spoken language comes out as English, so the deck is English either way.
2. A short conversation collects topic, slide count and colour preference, and captures every concrete
   fact you say into `brief.key_points` (`src/converse.js`, `prompts/conversation.md`).
3. An outline is drafted (`src/outline.js`) and read back to you. You can edit one slide at a time.
4. A deck is generated (`src/generate.js`) and sent back as a `.pptx`.
5. After delivery, each message is classified as edit / done / chat / clarify (`src/refine.js`).
   An edit rebuilds from the previous deck's script.

## Architecture

```
Telegram ──► bot.js (Telegraf handlers: /start /reset /echo, voice, text)
               │  auth.js     allowlist check, fails closed
               │  state.js    one JSON file per user: phase + history + brief
               ├─ transcribe.js ─► OpenAI Whisper
               ├─ converse.js / outline.js / refine.js ─► claude_json.js ─► `claude -p`
               └─ generate.js ─┬─ generate_claude.js ─► `claude -p` + MCP server (src/mcp/)
                               └─ generate_openai.js   (fallback: one-shot, render once)
```

- **State machine.** `state.js` keeps a session phase (`gathering` → `generating` → `refining`, plus
  a ready state) in `state/<userId>.json`.
- **Two generation engines.** The default `claude` engine runs a headless Claude Code agent that writes
  a pptxgenjs script, renders it, looks at the slides and fixes them. It does this through a small MCP
  server (`src/mcp/voicepptx_mcp.js`) exposing four tools: `get_brief`, `get_design_guide`,
  `find_sources` and `render_deck`. The `openai` engine is a one-shot fallback.
- **The brain runs on the `claude` CLI**, not an API key (`src/claude_cli.js`, `src/claude_json.js`).
  It needs a logged-in `claude` on the host, plus `soffice` and `pdftoppm` for the visual loop.
- **Prompts are files** in `prompts/`, not strings in code.

## Decisions, and why

**1. Handler timeout above generation time** (`src/config.js`, `src/bot.js`).
Telegraf wraps each update handler in a 90-second timeout. Deck generation runs *inside* the handler
and takes minutes (the first end-to-end run took 166 s, per the comment in `config.js`). The default
made Telegraf abort the handler mid-build, and `bot.catch` then told the user it had failed while the deck
was still being made. `handlerTimeoutMs` now defaults to 600 000 ms and is configurable (`0`/`off`
disables it). The generation is an `await` on a child process, so the bot stays responsive;
only the handler's promise outlives Telegraf's default.

**2. Atomic state writes** (`writeJsonAtomic` in `src/state.js`).
Write to a temp file in the same directory, then `rename` over the target. A crash or restart mid-write
leaves the old session, never a truncated JSON file. A test covers it
(`atomic write replaces the file and leaves no temp files`).

**3. `load()` treats only `ENOENT` as "new user"** (`src/state.js`).
A missing file returns a fresh session; any other error is rethrown. Swallowing everything would turn a
permissions problem or a corrupt file into silent data loss.

**4. `recoverStuck()` at startup** (`src/state.js`, called from `src/bot.js`).
At startup no generation can be running, so a session still marked `generating` was cut off by a restart
and would answer "still working" forever. They are put back where a failed build would have left them
(`refining` if there was a previous deck, otherwise `ready`). One unwritable file is logged and does not
stop the bot from starting. Tested: `startup resets sessions stuck in generating, and only those`.

**5. Different models for different jobs** (`src/config.js`).
The mechanical interview turns use a fast, cheap model (`CONVERSE_MODEL`, default `claude-haiku-4-5`).
The taste-heavy outline draft uses a strong one (`OUTLINE_MODEL`, `claude-opus-4-8`). The refine step
sits in between (`REFINE_MODEL`, `claude-sonnet-4-6`) because it must judge intent and resolve vague
references like "make it bigger", and when unsure it asks rather than trigger a wasted multi-minute
rebuild. Generation has a hard per-deck cost cap (`GENERATION_MAX_BUDGET_USD`, default 3.00, passed as
`--max-budget-usd`).

### Also: the model's own script is treated as untrusted

In research mode the agent reads web pages before writing its script, and a page can carry instructions.
So the script runs with a minimal environment (no bot token or API keys), and where available inside a
bubblewrap sandbox with no network and only its own output directory writable (`src/mcp/render_sandbox.js`).
The `claude` child processes get the bot's secrets stripped from their environment (`childEnv` in
`src/claude_cli.js`), run with `--permission-mode dontAsk`, and load only the MCP servers passed to them.
The bot itself refuses to start without a Telegram allowlist (`src/auth.js`). The prompts also forbid
inventing facts: figures and names must trace to what the user said or to a retrieved source.

## Run it

```bash
cp .env.example .env     # fill in TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, ALLOWED_USER_IDS
npm ci
npm test                 # 18 tests, no network, no secrets needed (one skips without bwrap)
npm start
```

`npm test` runs `node --test test/*.test.js`: `argv` (4), `auth` (5), `render_sandbox` (6), `state` (3).
The tests set their own dummy environment variables.

## Honest limits

- **Few tests.** 4 test files, 18 tests. The end-to-end sandbox test needs bubblewrap (`bwrap`) and skips
  where it is missing. They cover the allowlist, the state file handling, the sandbox
  and the `claude` argument lists. `bot.js` (the Telegraf wiring) and the engines are not covered, and
  there is no CI.
- **JavaScript, not TypeScript.** Nothing checks the shape of the session JSON on load.
- **JSON files, not a database.** One file per user is fine for a few users and has no locking
  beyond the atomic rename.
- **Tied to a subscription CLI.** The brain and the generator both depend on a logged-in `claude`
  binary, which is convenient and a real deployment coupling.
- **Two dependency findings left open.** `npm audit fix` (no breaking upgrades) cleared eight of the ten
  findings on 2026-10-08; the 18 tests still pass. Two high ones remain: `sharp`, whose fix is a breaking
  upgrade, and `image-size`, which `pptxgenjs` pins. Both parse images, and the bot only handles voice and
  text from an allowlist of users, so neither was upgraded blind.

## What I'd do differently

- Parse `state/*.json` through a validator, so a hand-edited or old-format file fails with a clear error.
  `load()` currently rethrows a corrupt file's parse error, while `recoverStuck()` silently skips such files.
  The two should agree.
- Move the session store to SQLite once there is more than a handful of users.
- Add a test that drives `bot.js` with a fake Telegram update, since the 90-second timeout bug lived
  exactly in that untested seam.
- Port the `src/` modules to TypeScript, starting with `state.js` and `config.js`.
