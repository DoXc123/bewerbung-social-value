// voicepptx MCP server (stdio).
//
// This is the seam between the Telegram bot and the Claude-Code deck-generation
// agent. The bot stashes a brief on disk and launches `claude -p` with this
// server attached (see ../generate_claude.js). The agent then drives deck
// creation entirely through these three tools — it never needs raw filesystem
// access:
//
//   get_brief          → the structured deck spec for this session
//   get_design_guide   → the Anthropic pptx skill (design rules + pptxgenjs API)
//   render_deck(js)     → renders a pptxgenjs script to .pptx and feeds the result
//                         BACK to the agent: node/pptxgenjs errors as text, and —
//                         when LibreOffice + Poppler are present — the rendered
//                         slides as IMAGES, so the agent can SEE its deck and fix
//                         layout/overflow/contrast the way the Claude web app does.
//
// Config comes from env (set by generate_claude.js):
//   VPPTX_APP_ROOT    app dir (holds out/, node_modules with pptxgenjs)
//   VPPTX_L3_DIR      reference dir (holds pptx_skill/)
//   VPPTX_SESSION_ID  this generation session
//   VPPTX_RENDER_SANDBOX  "auto" (default) | "bwrap" — see render_sandbox.js
//
// On a successful render it writes a sidecar out/<session>.deck.json so the
// caller can find the finished file deterministically, regardless of what the
// agent says in prose.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runRender } from "./render_sandbox.js";

const APP_ROOT = process.env.VPPTX_APP_ROOT;
const L3_DIR = process.env.VPPTX_L3_DIR;
const SESSION_ID = process.env.VPPTX_SESSION_ID;
const RENDER_SANDBOX = (process.env.VPPTX_RENDER_SANDBOX || "auto").toLowerCase();

if (!APP_ROOT || !L3_DIR || !SESSION_ID) {
  console.error("voicepptx-mcp: missing VPPTX_APP_ROOT / VPPTX_L3_DIR / VPPTX_SESSION_ID");
  process.exit(1);
}

const OUT_DIR = path.join(APP_ROOT, "out");
// The model-written script and its .pptx live in a per-session dir, the only part
// of out/ the render sandbox can see: no other session's brief, script or sidecar.
// The brief and sidecar stay in out/, written and read by trusted code only.
const RENDER_DIR = path.join(OUT_DIR, SESSION_ID);
const SKILL_DIR = path.join(L3_DIR, "pptx_skill");
const BRIEF_PATH = path.join(OUT_DIR, `${SESSION_ID}.brief.json`);
const SIDECAR_PATH = path.join(OUT_DIR, `${SESSION_ID}.deck.json`);
const CJS_PATH = path.join(RENDER_DIR, `${SESSION_ID}.cjs`);

// --- helpers ----------------------------------------------------------------

function slugify(s) {
  return (
    (s || "deck")
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60) || "deck"
  );
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function hasBin(bin) {
  try {
    return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

async function readBrief() {
  try {
    return JSON.parse(await fsp.readFile(BRIEF_PATH, "utf8"));
  } catch {
    return null;
  }
}

// The script is model-written: run it sandboxed (see render_sandbox.js).
function runNode(jsPath, outPath) {
  return runRender({ appRoot: APP_ROOT, outDir: RENDER_DIR, jsPath, outPath, mode: RENDER_SANDBOX });
}

// Render slides → PNG via LibreOffice (pptx→pdf) + Poppler (pdf→png). Returns an
// array of MCP image content blocks. If either binary is missing it returns []
// and the agent simply works from text errors — no crash. This is what makes the
// visual feedback loop turn on automatically once Hetzner has the deps.
async function renderThumbnails(pptxPath) {
  if (!hasBin("soffice") || !hasBin("pdftoppm")) return [];
  let tmp;
  try {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "vpptx-thumb-"));
    const conv = spawnSync(
      "soffice",
      ["--headless", "--convert-to", "pdf", "--outdir", tmp, pptxPath],
      { timeout: 120000, stdio: "ignore" }
    );
    if (conv.status !== 0) return [];
    const pdf = path.join(tmp, path.basename(pptxPath).replace(/\.pptx$/i, ".pdf"));
    if (!fs.existsSync(pdf)) return [];
    spawnSync("pdftoppm", ["-png", "-r", "60", pdf, path.join(tmp, "slide")], {
      timeout: 120000,
      stdio: "ignore",
    });
    const pngs = (await fsp.readdir(tmp)).filter((f) => f.endsWith(".png")).sort();
    const blocks = [];
    for (const f of pngs.slice(0, 12)) {
      const b = await fsp.readFile(path.join(tmp, f));
      blocks.push({ type: "image", data: b.toString("base64"), mimeType: "image/png" });
    }
    return blocks;
  } catch {
    return [];
  } finally {
    if (tmp) fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// --- source lookup (anti-hallucination) -------------------------------------
//
// find_sources queries free, keyless scholarly APIs and returns ONLY what the API
// returned — the agent cannot mint a paper. Semantic Scholar first; on empty/error/
// rate-limit, fall back to Crossref (DOI authority). Returns [] (never throws) when
// nothing is found so the agent knows to try the web or stay qualitative.

const SOURCE_TIMEOUT_MS = 8000;
const DEFAULT_MAX_SOURCES = Math.min(Math.max(1, Number(process.env.VPPTX_MAX_SOURCES || "4")), 10);

async function fetchJSON(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "voicepptx/1.0 (deck citation lookup)", ...headers },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function trimAbstract(s) {
  if (!s || typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim().slice(0, 600);
}

async function searchSemanticScholar(query, limit) {
  const fields = "title,authors,year,venue,externalIds,url,abstract";
  const url =
    `https://api.semanticscholar.org/graph/v1/paper/search` +
    `?query=${encodeURIComponent(query)}&limit=${limit}&fields=${encodeURIComponent(fields)}`;
  const data = await fetchJSON(url);
  const papers = data?.data;
  if (!Array.isArray(papers) || papers.length === 0) return [];
  return papers
    .map((p) => {
      const doi = p.externalIds?.DOI || null;
      const authors = (p.authors || []).map((a) => a.name).filter(Boolean).slice(0, 6).join(", ");
      return {
        title: p.title || "",
        authors,
        year: p.year ?? null,
        venue: p.venue || "",
        doi,
        url: doi ? `https://doi.org/${doi}` : p.url || "",
        abstract: trimAbstract(p.abstract),
      };
    })
    .filter((p) => p.title);
}

async function searchCrossref(query, limit) {
  const url =
    `https://api.crossref.org/works` +
    `?query=${encodeURIComponent(query)}&rows=${limit}` +
    `&select=${encodeURIComponent("title,author,issued,container-title,DOI,URL,abstract")}`;
  const data = await fetchJSON(url, { Accept: "application/json" });
  const items = data?.message?.items;
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map((it) => {
      const doi = it.DOI || null;
      const authors = (it.author || [])
        .map((a) => [a.given, a.family].filter(Boolean).join(" ").trim() || a.name)
        .filter(Boolean)
        .slice(0, 6)
        .join(", ");
      const year = it.issued?.["date-parts"]?.[0]?.[0] ?? null;
      const abstract = trimAbstract((it.abstract || "").replace(/<[^>]+>/g, " "));
      return {
        title: Array.isArray(it.title) ? it.title[0] || "" : it.title || "",
        authors,
        year,
        venue: Array.isArray(it["container-title"]) ? it["container-title"][0] || "" : "",
        doi,
        url: doi ? `https://doi.org/${doi}` : it.URL || "",
        abstract,
      };
    })
    .filter((p) => p.title);
}

// --- server -----------------------------------------------------------------

const server = new McpServer({ name: "voicepptx", version: "1.0.0" });

server.registerTool(
  "get_brief",
  {
    title: "Get deck brief",
    description:
      "Return the structured brief for this deck: topic, title, subtitle, " +
      "primary colors, key_points (the user's actual facts/content — the source " +
      "of truth; never invent specifics beyond these), and the slide-by-slide " +
      "outline (n, title, bullets). Call this first.",
    inputSchema: {},
  },
  async () => {
    const brief = await readBrief();
    if (!brief) {
      return {
        isError: true,
        content: [{ type: "text", text: `No brief found at ${BRIEF_PATH}.` }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(brief, null, 2) }] };
  }
);

server.registerTool(
  "get_design_guide",
  {
    title: "Get pptx design guide",
    description:
      "Return the Anthropic PPTX skill: design discipline, color palettes, " +
      "typography, motif and QA rules (SKILL.md) plus the pptxgenjs API " +
      "reference (pptxgenjs.md). Follow these to produce a polished deck.",
    inputSchema: {},
  },
  async () => {
    const [skill, api] = await Promise.all([
      fsp.readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8"),
      fsp.readFile(path.join(SKILL_DIR, "pptxgenjs.md"), "utf8"),
    ]);
    const text =
      `# PPTX SKILL — design rules, palettes, typography, motif, QA\n\n${skill}\n\n` +
      `# PPTXGENJS API REFERENCE\n\n${api}`;
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "find_sources",
  {
    title: "Find real sources for a claim",
    description:
      "Look up REAL, retrievable scholarly sources for a factual claim or topic, so " +
      "you can cite a figure/entity/date without inventing it. Queries Semantic " +
      "Scholar, falling back to Crossref for DOIs. Returns a JSON array of VERIFIED " +
      "sources (title, authors, year, venue, doi, url, trimmed abstract) — only what " +
      "the API actually returned. Returns [] when nothing is found: then either use " +
      "the web tools to confirm a reputable source, or state the point qualitatively. " +
      "NEVER cite a source this tool did not return.",
    inputSchema: {
      query: z.string().describe("A focused query for the specific claim or topic to source."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Max sources to return (default 4)."),
      kind: z.enum(["paper"]).optional().describe("Source kind; only 'paper' is supported."),
    },
  },
  async ({ query, limit }) => {
    const cap = Math.min(Math.max(1, limit || DEFAULT_MAX_SOURCES), 10);
    let results = await searchSemanticScholar(query, cap);
    if (results.length === 0) {
      results = await searchCrossref(query, cap);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results.slice(0, cap), null, 2) }],
    };
  }
);

server.registerTool(
  "render_deck",
  {
    title: "Render the deck",
    description:
      "Render a COMPLETE CommonJS pptxgenjs script to a .pptx file. Your script " +
      "MUST `require(\"pptxgenjs\")` and write to the path given in process.argv[2] " +
      "(e.g. `await pptx.writeFile({ fileName: process.argv[2] })`). On success " +
      "this returns the output path and — when the server has LibreOffice/Poppler — " +
      "an image of every rendered slide, so you can inspect the layout and fix it. " +
      "On failure it returns the node/pptxgenjs error so you can correct the script " +
      "and call this tool again.",
    inputSchema: {
      js_code: z
        .string()
        .describe("The full CommonJS pptxgenjs script (the entire file contents)."),
    },
  },
  async ({ js_code }) => {
    await fsp.mkdir(RENDER_DIR, { recursive: true });
    const brief = await readBrief();
    const slug = slugify(brief?.title);
    const outPath = path.join(RENDER_DIR, `${slug}_${dateStamp()}.pptx`);

    await fsp.writeFile(CJS_PATH, js_code);
    const res = await runNode(CJS_PATH, outPath);

    if (res.code !== 0 || !fs.existsSync(outPath)) {
      // Wipe any stale sidecar so a previous good render can't be mistaken for this one.
      await fsp.rm(SIDECAR_PATH, { force: true }).catch(() => {});
      const err = (res.stderr || res.stdout || `node exited ${res.code}`).slice(0, 4000);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Render FAILED (node exit ${res.code}). Fix the script and call render_deck again.\n\n` +
              `STDERR:\n${err}`,
          },
        ],
      };
    }

    await fsp.writeFile(
      SIDECAR_PATH,
      JSON.stringify({ ok: true, out_path: outPath }, null, 2)
    );

    const thumbs = await renderThumbnails(outPath);
    const note =
      thumbs.length > 0
        ? `Render OK → ${outPath}\nBelow are the ${thumbs.length} rendered slides. ` +
          `Inspect them: check for text overflow, clipping, cramped or empty areas, ` +
          `low contrast, and inconsistent alignment. If anything looks off, fix the ` +
          `script and call render_deck again. If it looks clean and polished, you are done.`
        : `Render OK → ${outPath}\n(Slide image preview unavailable — no LibreOffice/Poppler ` +
          `on this host, so no visual check. The deck rendered without errors.)`;
    return { content: [{ type: "text", text: note }, ...thumbs] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
