import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { claudeJSON } from "./claude_json.js";

let cachedSystem = null;
async function getSystem() {
  if (!cachedSystem) {
    cachedSystem = await fs.readFile(path.join(config.promptsDir, "outline.md"), "utf8");
  }
  return cachedSystem;
}

export async function draftOutline({ topic, slide_count, primary_colors, key_points }, opts = {}) {
  const system = await getSystem();
  // Research mode controls where MISSING facts may come from (a downstream lookup),
  // never whether to invent (see prompts/outline.md): the drafter builds content
  // from key_points; for a specific not in key_points it writes a directional claim
  // + needs_evidence (research on) or stays qualitative (research off). It never
  // fabricates a figure/name/date.
  const research = opts.research ?? config.research.mode;
  const payload = {
    topic,
    slide_count: slide_count || 8,
    primary_colors: primary_colors || "surprise me",
    // The user's actual facts/content — the source of truth the drafter builds from.
    key_points: Array.isArray(key_points) ? key_points : [],
    research,
    edit: opts.edit || null,
    current_outline: opts.current_outline || null,
  };

  const prompt = [
    system,
    "",
    "## Input",
    JSON.stringify(payload, null, 2),
    "",
    "Respond with the outline as a single JSON object — first char `{`, last char `}`.",
  ].join("\n");

  let parsed;
  try {
    parsed = await claudeJSON(prompt, { model: config.brain.outlineModel });
  } catch (err) {
    throw new Error(`Outline drafter failed: ${err.message}`);
  }

  if (!parsed.title || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
    throw new Error(`Outline missing required fields. Got keys: ${Object.keys(parsed).join(", ")}`);
  }
  return parsed;
}
