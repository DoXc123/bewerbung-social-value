// Shared "ask Claude for one JSON object" helper for the text-reasoning legs
// (conversation + outline). Uses the SAME subscription-login `claude -p` trick as
// the deck-generation engine (generate_claude.js) — no ANTHROPIC_API_KEY, the
// logged-in `claude` CLI is the brain. One-shot and stateless: the caller composes
// the entire prompt (system instructions + state + history) into `prompt`, exactly
// as generate_claude.js puts its whole spec in one -p string.
//
// `claude --output-format json` wraps the reply in an envelope
// { result, total_cost_usd, is_error, ... }; `result` is the assistant text, which
// the caller's prompt constrains to a single JSON object. We unwrap, then parse.
//
// These legs are text-only: the prompt carries the user's own words, so the run gets
// no tools at all (--tools "") and starts in an empty directory, not the app folder
// that holds .env.

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { HARDENING_ARGS, runClaude } from "./claude_cli.js";

export function buildBrainArgs(prompt, model) {
  const args = ["-p", prompt, "--output-format", "json", "--tools", "", ...HARDENING_ARGS];
  if (model) args.push("--model", model);
  return args;
}

// Pull the first {...} block out of the model's text, tolerating stray prose or
// ```json fences even though the prompts forbid them.
function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = fence ? fence[1] : text;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  return s.trim();
}

/**
 * Run the logged-in Claude CLI on a single prompt and return the parsed JSON object.
 * @param {string} prompt  full prompt (system + state + turn) — the reply must be one JSON object
 * @param {object} [opts]
 * @param {string} [opts.model]  model alias (e.g. claude-haiku-4-5); omit for the subscription default
 * @returns {Promise<object>} parsed JSON the model emitted
 */
export async function claudeJSON(prompt, opts = {}) {
  const cwd = path.join(config.outDir, ".brain");
  await fs.mkdir(cwd, { recursive: true });
  const res = await runClaude(config.generation.claudeBin, buildBrainArgs(prompt, opts.model), { cwd });
  if (res.code !== 0 && !res.stdout.trim()) {
    throw new Error(`claude exited ${res.code}: ${(res.stderr || "").slice(0, 400)}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {
    throw new Error(`claude returned a non-JSON envelope: ${res.stdout.slice(0, 200)}`);
  }
  if (envelope.is_error) {
    throw new Error(`claude reported an error: ${String(envelope.result || "").slice(0, 300)}`);
  }

  const inner = extractJsonObject(envelope.result || "");
  try {
    return JSON.parse(inner);
  } catch {
    throw new Error(`claude reply was not a JSON object: ${inner.slice(0, 300)}`);
  }
}
