# Claude-Code deck-generation engine (`GENERATION_ENGINE=claude`)

This is the "mimic the Claude web app" path for making sleek decks. Instead of a
one-shot chat completion (the `openai` engine in `generate_openai.js`), it runs
**Claude Code (Opus, subscription login — no API key)** as an agent that writes a
pptxgenjs deck, renders it, *looks at the rendered slides*, and fixes
layout/overflow/contrast before finishing — the loop that makes the web app's
output look polished.

## Shape

```
bot (brief ready) ─▶ generate.js (dispatch) ─▶ generate_claude.js
                                                  │ writes out/<session>.brief.json
                                                  │ spawns:  claude -p <prompt>   (cwd: empty out/<session>.work/)
                                                  │            --tools ""  (research: WebSearch,WebFetch)
                                                  │            --strict-mcp-config --mcp-config <session>.mcp.json
                                                  │            --permission-mode dontAsk
                                                  │            --allowedTools mcp__voicepptx__*
                                                  ▼
                                        mcp/voicepptx_mcp.js  (stdio MCP server)
                                          • get_brief         → the deck spec
                                          • get_design_guide  → SKILL.md + pptxgenjs.md
                                          • render_deck(js)    → renders .pptx, returns
                                                                 node errors AND (if soffice
                                                                 + pdftoppm present) slide IMAGES
                                          on success writes out/<session>.deck.json (sidecar)
                                                  ▼
                          generate_claude.js reads the sidecar → { ok, outPath } → bot sends file
```

What confines the agent (runbook T3, 2026-10-02):

- **`--tools ""`** removes every built-in tool (Read, Bash, Edit, …); in research
  mode only WebSearch and WebFetch are added back. (`--allowedTools` alone only
  pre-approves tools; it removes none.) `--strict-mcp-config` loads no MCP server
  but ours, and `dontAsk` refuses anything not pre-approved.
- **It starts in an empty per-session dir**, not the app folder that holds `.env`,
  and its environment carries none of the bot's secrets (`src/claude_cli.js`).
- **`render_deck` runs the model-written script sandboxed** (`render_sandbox.js`):
  a minimal env always, and with bubblewrap (`apt install bubblewrap`) homes are
  hidden, the network is off, and only `node_modules` (read-only) and `out/` are
  visible. `RENDER_SANDBOX=bwrap` makes the sandbox mandatory; the default `auto`
  falls back to the minimal env with a journal warning.

## Enabling it

In `.env`:

```
GENERATION_ENGINE=claude
CLAUDE_BIN=claude                 # or an absolute path
GENERATION_MAX_BUDGET_USD=2.00    # per-deck hard cap
```

`claude` must be on PATH (or `CLAUDE_BIN`) and **logged in via subscription**
(`claude` once, interactively, to authenticate). No `ANTHROPIC_API_KEY` needed —
same posture as the Flow dev agent.

## The visual feedback loop (what makes decks sleek)

`render_deck` automatically returns an image of every rendered slide **when the
host has LibreOffice + Poppler**, so the agent can see and fix its own slides. If
those binaries are missing it degrades gracefully to text-only error feedback (the
deck still renders; the agent just can't visually QA it).

Install on Hetzner (Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends libreoffice-impress poppler-utils
# verify:
which soffice pdftoppm
```

Both are free/open-source and run headless. This is the same toolchain the official
Anthropic pptx skill documents (`soffice` + `pdftoppm`).

## Testing

```bash
# Claude engine only (hard-coded brief, no OpenAI calls) — run this on Hetzner:
GENERATION_ENGINE=claude node scripts/smoke_generate_claude.js
```

Expected: an agent run (`write → render → [look] → fix`) ending with
`out/<session>/<title>_<date>.pptx`. Before LibreOffice is installed, `render_deck` reports
"Slide image preview unavailable"; after, it returns slide images and the agent
visually QAs.

## Files

| File | Role |
|---|---|
| `src/mcp/voicepptx_mcp.js` | stdio MCP server: `get_brief`, `get_design_guide`, `render_deck` |
| `src/mcp/render_sandbox.js` | runs the model-written deck script (bwrap, minimal env) |
| `src/claude_cli.js` | shared `claude -p` hardening flags, secret-free env, spawn |
| `src/generate_claude.js` | spawns `claude -p` with the MCP server; reads the sidecar |
| `src/generate_openai.js` | the original one-shot engine (kept; `GENERATION_ENGINE=openai`) |
| `src/generate.js` | dispatcher + brief normalization (nested `brief.outline` → flat) |
| `scripts/smoke_generate_claude.js` | Claude-engine smoke test (no OpenAI) |
