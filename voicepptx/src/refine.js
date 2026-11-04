import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { claudeJSON } from "./claude_json.js";

let cachedSystem = null;
async function getSystemPrompt() {
  if (!cachedSystem) {
    cachedSystem = await fs.readFile(path.join(config.promptsDir, "refine.md"), "utf8");
  }
  return cachedSystem;
}

// A compact view of the delivered deck so the refiner can resolve references like
// "slide 3" or "the closing slide" without seeing the whole pptxgenjs script.
function deckSummary(brief) {
  const o = brief?.outline || {};
  const slides = Array.isArray(o.slides) ? o.slides : [];
  return {
    title: brief?.title ?? o.title ?? null,
    primary_colors: brief?.primary_colors ?? null,
    slides: slides.map((s) => ({ n: s.n, title: s.title })),
  };
}

function renderTranscript(history) {
  return history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}

// One post-delivery turn. Returns { intent, instruction, reply }. Mirrors converse():
// `claude -p` is one-shot, so we hand it the contract + a summary of the delivered
// deck + the refine dialogue so far, each turn.
export async function refine(session, userText) {
  const system = await getSystemPrompt();
  if (!Array.isArray(session.refineHistory)) session.refineHistory = [];
  session.refineHistory.push({ role: "user", content: userText });

  const prompt = [
    system,
    "",
    "## The delivered deck (already built and sent to the user)",
    JSON.stringify(deckSummary(session.brief), null, 2),
    "",
    "## Refine conversation so far",
    renderTranscript(session.refineHistory),
    "",
    "Respond now with your next reply as a single JSON object — first char `{`, last char `}`.",
  ].join("\n");

  let parsed;
  try {
    parsed = await claudeJSON(prompt, { model: config.brain.refineModel });
  } catch (err) {
    throw new Error(`Refine LLM failed: ${err.message}`);
  }
  session.refineHistory.push({ role: "assistant", content: JSON.stringify(parsed) });

  const intent = ["edit", "done", "chat", "clarify"].includes(parsed.intent)
    ? parsed.intent
    : "clarify";
  return {
    intent,
    instruction: intent === "edit" ? parsed.instruction || null : null,
    reply: parsed.reply || "",
  };
}
