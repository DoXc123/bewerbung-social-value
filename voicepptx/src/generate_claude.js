// Claude-Code deck-generation engine.
//
// This is the "mimic the Claude web app" path. Instead of one-shot asking a chat
// model for pptxgenjs code (see generate_openai.js), it runs Claude Code (Opus,
// subscription login — no API key) as an agent with the voicepptx MCP server
// attached. The agent reads the brief + the pptx skill, writes a pptxgenjs deck,
// renders it, looks at the result, and iterates until it's clean — exactly the
// loop that makes the web app's decks look sleek.
//
// Same signature/return shape as generate_openai.js so generate.js can dispatch
// between them: returns { ok, outPath, attempts, ... } and never throws on a
// failed render (returns { ok:false, error }).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { HARDENING_ARGS, runClaude } from "./claude_cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(__dirname, "mcp", "voicepptx_mcp.js");

const BASE_TOOLS = [
  "mcp__voicepptx__get_brief",
  "mcp__voicepptx__get_design_guide",
  "mcp__voicepptx__render_deck",
];
// Research mode adds the source-lookup tool plus web fallback. WebSearch/WebFetch
// are only honored if the headless `claude` has them; if not, find_sources (papers)
// still works and the agent stays qualitative for unsourceable specifics.
const RESEARCH_TOOLS = ["mcp__voicepptx__find_sources", "WebSearch", "WebFetch"];
// Built-in tools the agent may have at all. --tools removes every other built-in
// (Read, Bash, Edit, …); MCP tools are not built-ins and stay available.
const RESEARCH_BUILTINS = "WebSearch,WebFetch";

function allowedTools(research) {
  return (research ? [...BASE_TOOLS, ...RESEARCH_TOOLS] : BASE_TOOLS).join(",");
}

// The full argv for one generation run. Exported so a test can pin it.
export function buildGenArgs({ prompt, mcpConfigPath, research, maxBudgetUsd }) {
  return [
    "-p", prompt,
    "--output-format", "json",
    "--tools", research ? RESEARCH_BUILTINS : "",
    ...HARDENING_ARGS,
    "--mcp-config", mcpConfigPath,
    "--allowedTools", allowedTools(research),
    "--max-budget-usd", String(maxBudgetUsd),
  ];
}

// The research + citation phase, injected between "read the brief" and "write the
// script" only when research mode is on. This is the anti-fabrication contract.
const RESEARCH_PHASE = `\
2b. RESEARCH & CITE (research mode is ON for this deck — see brief.research). For \
each content slide, before writing its final text:
   - Call find_sources with a focused query for the slide's core claim. Prefer \
peer-reviewed papers. Slides flagged needs_evidence in the brief especially need this.
   - If find_sources returns [] and the claim is a current/non-academic fact (e.g. a \
recent business or market number), use WebSearch then WebFetch and cite a web URL \
ONLY after WebFetch actually returned its content this session. Prefer .gov/.edu/.org \
and primary sources.
   - Ground EVERY specific — figure, percentage, named entity, date, quote — in a \
source you retrieved THIS session. If you cannot source a specific, make the point \
qualitatively (or drop it). NEVER invent a number, name, or date. NEVER write a \
citation for a source you did not retrieve.
   - Keep a footnote list as you go: [n] -> short citation string + url, e.g. \
"Smith et al. 2021, Nature — doi.org/10.1038/...".
When you write the script (step 3), for every slide that makes a sourced claim, mark \
the claim inline with a superscript number and add a SMALL muted footnote line at the \
bottom of the slide (~8-9pt, low-contrast color, bottom-left) listing that slide's \
citations, e.g. addText("1 Smith et al. 2021, Nature — doi.org/10.1038/..."). Keep \
footnotes terse so they never crowd the slide. A claim left qualitative needs no \
footnote — that is correct, not a gap.`;

function buildGenPrompt(research) {
  return `\
You are the deck-generation agent inside "voicepptx". Produce ONE polished, \
consulting-grade PowerPoint for the brief you are given, working entirely through \
the voicepptx MCP tools${research ? " plus the WebSearch/WebFetch web tools for sourcing" : ""}. \
${research ? "Do not use any other tools." : "Do not use any other tools."}

Fidelity rule (applies to the whole deck): the deck's FACTS — every figure, \
percentage, named person/company/product/place, date, and quote — come from the \
brief's key_points and outline (the user's actual content)${research ? ", or from a source you retrieve this session (see step 2b)" : ""}. \
NEVER invent a number, name, or date to fill a slide. If a specific isn't in the brief\
${research ? " and you can't source it" : ""}, make the point qualitatively or leave it out — do not fabricate. \
You may craft strong, polished wording; you may not add facts the user didn't give.

Steps:
1. Call get_brief to read the deck spec (topic, title, subtitle, primary colors, \
key_points — the user's source-of-truth facts — and the slide-by-slide outline). \
Build every slide from this content; render the user's points faithfully.
2. Call get_design_guide to load the design rules (palettes, typography, motif, QA) \
and the pptxgenjs API reference. Follow them. Commit to a single visual motif. \
Canvas is LAYOUT_16x9 (10in x 5.625in).
${research ? RESEARCH_PHASE + "\n" : ""}3. Write a COMPLETE CommonJS pptxgenjs script for the whole deck. Hard requirements \
for the script:
   - const pptxgen = require("pptxgenjs");
   - Render to the path passed as process.argv[2], e.g.:
       (async () => {
         const pptx = new pptxgen();
         pptx.defineLayout({ name: "W16x9", width: 10, height: 5.625 });
         pptx.layout = "W16x9";
         /* ...build every slide from the outline... */
         await pptx.writeFile({ fileName: process.argv[2] });
       })();
   - Build every slide in the outline. Honor the primary_colors hint; if it says \
"surprise me" or is empty, pick a palette from the design guide that fits the topic.\
${research ? "\n   - Render the inline superscripts + per-slide footnotes from your research above." : ""}
4. Call render_deck with the full script text as js_code.
5. If render_deck reports an error, fix the script and call render_deck again. \
If render_deck returns slide IMAGES, inspect each one: look for text overflow or \
clipping, cramped or empty space, low contrast, misalignment, and off-brand color\
${research ? ", and that footnotes are legible but unobtrusive" : ""}. \
If anything looks rough, improve the script and re-render. Iterate until the deck \
looks clean and professional (at most 6 renders).
6. When the deck renders cleanly (and, if images are available, looks polished), \
STOP. End with one sentence naming the output path. Do nothing else.`;
}

// Refine/edit prompt: the deck already exists and was sent to the user. Rather than
// rebuild from the brief (which would reroll the whole design), we hand the agent the
// exact pptxgenjs script that produced their deck and ask it to apply ONE change and
// re-render, preserving everything else. Research follows the deck's mode: a change
// that introduces a new claim can be sourced; a purely visual tweak needs no lookup.
function buildEditPrompt(instruction, priorScript, research) {
  const researchNote = research
    ? `\nIf the change introduces a NEW specific (a figure, named entity, date, or quote) \
that isn't already in the brief or the current script, source it before writing: call \
find_sources (papers) or, for a current non-academic fact, WebSearch then WebFetch, and \
add a small inline footnote citing what you actually retrieved this session. Do not add \
a specific you can't source — state it qualitatively instead. Existing sourced content \
and its footnotes should stay intact unless the change touches them.\n`
    : "";
  return `\
You are the deck-refinement agent inside "voicepptx". The user already has a rendered \
PowerPoint. Apply the ONE change they asked for and re-render, keeping everything else \
about the deck identical, working entirely through the voicepptx MCP tools${research ? " plus the WebSearch/WebFetch web tools for sourcing" : ""}. \
Do not use any other tools.

The change the user asked for:
"""
${instruction}
"""

Below is the CURRENT pptxgenjs script that produced the user's deck. Modify it to make \
the requested change and NOTHING else — keep all other slides, text, colors, motif, and \
layout exactly as they are unless the change requires otherwise.

--- BEGIN CURRENT DECK SCRIPT ---
${priorScript}
--- END CURRENT DECK SCRIPT ---

Fidelity rule: the deck's FACTS — figures, percentages, names, dates, quotes — come from \
the brief's key_points/outline (the user's actual content)${research ? ", or from a source you retrieve this session" : ""}. \
NEVER invent a number, name, or date to satisfy the change. If the change needs a specific \
the user hasn't given${research ? " and you can't source it" : ""}, make the point qualitatively rather than fabricate.
${researchNote}
Steps:
1. Call get_brief to reconfirm the source-of-truth facts (never invent beyond them).
2. If the change is visual/design-related, call get_design_guide for palettes/typography/QA.
3. Edit the script above to satisfy the change. Keep it a COMPLETE CommonJS pptxgenjs \
script that requires("pptxgenjs") and writes to process.argv[2].
4. Call render_deck with the full edited script. If render_deck reports an error, fix it \
and call again. If it returns slide IMAGES, inspect them: confirm the change landed and \
introduced no overflow/clipping/misalignment/contrast problems. Iterate if needed (at \
most 4 renders).
5. When the change is in and the deck looks clean, STOP. End with one sentence naming the \
output path. Do nothing else.`;
}

function parseClaude(stdout, stderr) {
  try {
    const data = JSON.parse(stdout);
    return {
      text: data.result || "",
      cost_usd: data.total_cost_usd ?? null,
      num_turns: data.num_turns ?? null,
      is_error: Boolean(data.is_error),
    };
  } catch {
    return { text: stdout.trim() || stderr.trim(), cost_usd: null, num_turns: null, is_error: false };
  }
}

export async function generateDeckClaude(brief, sessionId, opts = {}) {
  await fs.mkdir(config.outDir, { recursive: true });

  if (!brief.title) throw new Error("brief.title is required");
  if (!Array.isArray(brief.slides) || brief.slides.length === 0) {
    throw new Error("brief.slides must be a non-empty array");
  }

  // Edit mode: opts.editFromCjs points at the prior deck's script and opts.editInstruction
  // is the self-contained change. If the prior script can't be read, we fall back to a
  // clean rebuild from the brief rather than fail the refine.
  let priorScript = null;
  if (opts.editFromCjs && opts.editInstruction) {
    try {
      priorScript = await fs.readFile(opts.editFromCjs, "utf8");
    } catch {
      priorScript = null;
    }
  }
  const editMode = Boolean(priorScript && opts.editInstruction);

  // Research mode: prefer a flag already on the brief (e.g. a future per-deck toggle),
  // otherwise fall back to the env-gated config default. Edits respect it too — a
  // refine that adds a new claim can source it (find_sources/web); the anti-fabrication
  // fidelity rule holds either way, so a purely visual tweak simply won't need a lookup.
  const research = brief.research ?? config.research.mode;

  // Stash the brief for the MCP server's get_brief, and clear any stale results. We
  // surface `research` in the brief so the agent's get_brief makes the contract explicit.
  const briefPath = path.join(config.outDir, `${sessionId}.brief.json`);
  const sidecarPath = path.join(config.outDir, `${sessionId}.deck.json`);
  await fs.writeFile(briefPath, JSON.stringify({ ...brief, research }, null, 2));
  await fs.rm(sidecarPath, { force: true }).catch(() => {});

  // Per-session MCP config: launch our stdio server with this session's paths.
  const mcpConfig = {
    mcpServers: {
      voicepptx: {
        command: process.execPath, // node
        args: [MCP_SERVER],
        env: {
          VPPTX_APP_ROOT: config.appRoot,
          VPPTX_L3_DIR: config.l3Dir,
          VPPTX_SESSION_ID: sessionId,
          VPPTX_MAX_SOURCES: String(config.research.maxSources),
          VPPTX_RENDER_SANDBOX: config.generation.renderSandbox,
        },
      },
    },
  };
  const mcpConfigPath = path.join(config.outDir, `${sessionId}.mcp.json`);
  await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  const genPrompt = editMode
    ? buildEditPrompt(opts.editInstruction, priorScript, research)
    : buildGenPrompt(research);

  const args = buildGenArgs({
    prompt: genPrompt,
    mcpConfigPath,
    research,
    maxBudgetUsd: config.generation.maxBudgetUsd,
  });

  // A fresh, empty working dir per run: the agent has no file tools, and the app
  // folder (which holds .env) is no longer its cwd.
  const workDir = path.join(config.outDir, `${sessionId}.work`);
  await fs.mkdir(workDir, { recursive: true });
  let res;
  try {
    res = await runClaude(config.generation.claudeBin, args, { cwd: workDir });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  const parsed = parseClaude(res.stdout, res.stderr);

  // The render_deck tool writes the sidecar on success — trust that over prose.
  let deck = null;
  try {
    deck = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
  } catch {
    /* no sidecar → no successful render */
  }

  if (deck?.ok && deck.out_path) {
    return {
      ok: true,
      outPath: deck.out_path,
      // The MCP render_deck tool wrote the rendered script here; the refine loop feeds
      // it back as editFromCjs so the next tweak edits this deck instead of rerolling.
      cjsPath: path.join(config.outDir, sessionId, `${sessionId}.cjs`),
      attempts: 1,
      engine: "claude",
      editMode,
      costUsd: parsed.cost_usd,
      summary: parsed.text,
    };
  }

  const why =
    res.code !== 0 && !res.stdout.trim()
      ? `claude exited ${res.code}: ${res.stderr.slice(0, 600)}`
      : parsed.text || "Claude finished without producing a deck (no render succeeded).";
  return { ok: false, attempts: 1, engine: "claude", error: why, costUsd: parsed.cost_usd };
}
