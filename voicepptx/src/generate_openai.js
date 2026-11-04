// OpenAI (chat-model) deck generator — the original one-shot path.
//
// Reads the Anthropic pptx skill from L3 (SKILL.md + pptxgenjs.md), the
// generation system prompt from prompts/generation.md, and the brief. Asks the
// LLM to emit a complete CommonJS pptxgenjs script, writes it to disk, executes
// it via a node subprocess that takes the output path as argv[2].
//
// No render feedback loop — it's a single shot with regex sanity checks. For the
// agentic, render-and-look-at-it path that mimics the Claude web app, see
// generate_claude.js. Dispatch between the two lives in generate.js.

import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { runRender } from "./mcp/render_sandbox.js";

const llm = new OpenAI({
  apiKey: config.llm.apiKey,
  baseURL: config.llm.baseURL,
});

let cached = null;
async function loadStaticContext() {
  if (cached) return cached;
  const skillDir = path.join(config.l3Dir, "pptx_skill");
  const [system, skill, api] = await Promise.all([
    fs.readFile(path.join(config.promptsDir, "generation.md"), "utf8"),
    fs.readFile(path.join(skillDir, "SKILL.md"), "utf8"),
    fs.readFile(path.join(skillDir, "pptxgenjs.md"), "utf8"),
  ]);
  cached = { system, skill, api };
  return cached;
}

function slugify(s) {
  return (s || "deck")
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60) || "deck";
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function extractJs(text) {
  const fence = text.match(/```(?:javascript|js|cjs)?\s*\n([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

// The script is model-written: run it sandboxed, like render_deck does, seeing only
// its own session dir.
async function runNode(jsPath, outPath) {
  const res = await runRender({
    appRoot: config.appRoot,
    outDir: path.dirname(jsPath),
    jsPath,
    outPath,
    mode: config.generation.renderSandbox,
  });
  if (res.code === 0) return { stdout: res.stdout, stderr: res.stderr };
  throw new Error(`node exited ${res.code}\nstderr: ${res.stderr.slice(0, 4000)}`);
}

export async function generateDeckOpenAI(brief, sessionId) {
  await fs.mkdir(config.outDir, { recursive: true });

  if (!brief.title) throw new Error("brief.title is required");
  if (!Array.isArray(brief.slides) || brief.slides.length === 0) {
    throw new Error("brief.slides must be a non-empty array");
  }

  const { system, skill, api } = await loadStaticContext();

  const userPayload = {
    topic: brief.topic,
    title: brief.title,
    subtitle: brief.subtitle || null,
    slide_count: brief.slides.length,
    primary_colors: brief.primary_colors || null,
    slides: brief.slides.map((s) => ({
      n: s.n,
      title: s.title,
      bullets: s.bullets || [],
    })),
  };

  const completion = await llm.chat.completions.create({
    model: config.llm.model,
    messages: [
      { role: "system", content: system },
      { role: "system", content: `# PPTX SKILL (design rules, palettes, typography, motif, QA)\n\n${skill}` },
      { role: "system", content: `# PPTXGENJS API REFERENCE\n\n${api}` },
      { role: "user", content: JSON.stringify(userPayload, null, 2) },
    ],
    temperature: 0.4,
  });

  const raw = completion.choices[0]?.message?.content || "";
  const js = extractJs(raw);

  if (!/writeFile\s*\(/.test(js)) {
    throw new Error(`Generated JS missing writeFile call. First 400 chars:\n${js.slice(0, 400)}`);
  }
  if (!/require\s*\(\s*["']pptxgenjs["']\s*\)/.test(js)) {
    throw new Error(`Generated JS missing pptxgenjs require. First 400 chars:\n${js.slice(0, 400)}`);
  }

  const titleSlug = slugify(brief.title);
  const stamp = dateStamp();
  const renderDir = path.join(config.outDir, sessionId);
  await fs.mkdir(renderDir, { recursive: true });
  const outPath = path.join(renderDir, `${titleSlug}_${stamp}.pptx`);
  const jsPath = path.join(renderDir, `${titleSlug}_${stamp}_${sessionId}.cjs`);

  await fs.writeFile(jsPath, js);
  await runNode(jsPath, outPath);

  return { ok: true, outPath, jsPath, attempts: 1, engine: "openai" };
}
