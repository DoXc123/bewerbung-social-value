import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { claudeJSON } from "./claude_json.js";

let cachedSystem = null;
async function getSystemPrompt() {
  if (!cachedSystem) {
    cachedSystem = await fs.readFile(path.join(config.promptsDir, "conversation.md"), "utf8");
  }
  return cachedSystem;
}

function emptyBrief() {
  return {
    topic: null,
    slide_count: null,
    primary_colors: null,
    key_points: [],
    outline: null,
  };
}

function briefForLLM(brief) {
  if (!brief) return emptyBrief();
  return {
    topic: brief.topic ?? null,
    slide_count: brief.slide_count ?? null,
    primary_colors: brief.primary_colors ?? null,
    // Full key_points (not a summary): the model must see what it has already
    // captured so it can append the user's new facts instead of dropping them.
    key_points: Array.isArray(brief.key_points) ? brief.key_points : [],
    outline_present: brief.outline ? true : false,
    outline_summary: brief.outline
      ? brief.outline.slides?.map((s) => ({ n: s.n, title: s.title })) || null
      : null,
  };
}

// Render the running dialogue into a plain transcript. `claude -p` is one-shot, so
// (unlike the OpenAI messages array) we hand it the whole conversation as text each
// turn. Assistant turns are the JSON objects this function returned earlier.
function renderTranscript(history) {
  return history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}

export async function converse(session, userText) {
  const system = await getSystemPrompt();
  if (!session.brief) session.brief = emptyBrief();
  session.history.push({ role: "user", content: userText });

  // One self-contained prompt: the system contract + current brief state (so the
  // model stays oriented as the dialogue grows) + the transcript so far.
  const prompt = [
    system,
    "",
    "## Current brief state",
    JSON.stringify(briefForLLM(session.brief), null, 2),
    "",
    "## Conversation so far",
    renderTranscript(session.history),
    "",
    "Respond now with your next reply as a single JSON object — first char `{`, last char `}`.",
  ].join("\n");

  let parsed;
  try {
    parsed = await claudeJSON(prompt, { model: config.brain.converseModel });
  } catch (err) {
    throw new Error(`Conversation LLM failed: ${err.message}`);
  }
  session.history.push({ role: "assistant", content: JSON.stringify(parsed) });

  // Merge parsed.brief back into session.brief, preserving outline (LLM doesn't see/echo full outline)
  if (parsed.brief) {
    const preservedOutline = session.brief.outline;
    // key_points should only grow. The model sees the running list and returns the
    // updated one; if it ever omits the field, keep what we already captured rather
    // than losing the user's facts.
    const mergedKeyPoints = Array.isArray(parsed.brief.key_points)
      ? parsed.brief.key_points
      : session.brief.key_points || [];
    session.brief = {
      ...emptyBrief(),
      ...parsed.brief,
      key_points: mergedKeyPoints,
      outline: preservedOutline,
    };
  }
  if (parsed.step === "ready") {
    session.phase = "ready";
  }
  return parsed;
}
