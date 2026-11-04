// Deck generation — engine dispatcher.
//
// Two engines exist:
//   openai → generate_openai.js  (one-shot: chat model emits pptxgenjs, render once)
//   claude → generate_claude.js  (agentic: Claude Code writes → renders → looks →
//                                 fixes, via the voicepptx MCP server; mimics the
//                                 Claude web app)
//
// Pick with GENERATION_ENGINE in .env (see config.generation.engine).
//
// This module also NORMALIZES the brief. The bot passes `session.brief`, whose
// outline is nested under `brief.outline` ({ title, subtitle, slides }), while the
// engines want title/slides at the top level. Normalizing here means both engines
// — and the smoke scripts, which already pass a flat brief — get a consistent shape.

import { config } from "./config.js";
import { generateDeckOpenAI } from "./generate_openai.js";
import { generateDeckClaude } from "./generate_claude.js";

function normalizeBrief(brief) {
  const o = brief.outline || {};
  return {
    topic: brief.topic ?? null,
    title: brief.title ?? o.title ?? null,
    subtitle: brief.subtitle ?? o.subtitle ?? null,
    primary_colors: brief.primary_colors ?? null,
    // The user's actual facts/content — the generator's source of truth, and the
    // only place specifics may come from when research mode is off.
    key_points: brief.key_points ?? o.key_points ?? [],
    // Carry the per-deck research flag through if the caller set one; generate_claude
    // falls back to the config default when it's undefined.
    research: brief.research,
    slides: brief.slides ?? o.slides ?? [],
  };
}

// opts.editFromCjs + opts.editInstruction drive the post-delivery refine loop: the
// claude engine edits the prior deck's script in place. The openai fallback engine
// has no script to edit, so it rebuilds from the brief (a coarser refine, but the
// default engine is claude).
export async function generateDeck(brief, sessionId, opts = {}) {
  const norm = normalizeBrief(brief);
  if (config.generation.engine === "claude") {
    return generateDeckClaude(norm, sessionId, opts);
  }
  return generateDeckOpenAI(norm, sessionId);
}
