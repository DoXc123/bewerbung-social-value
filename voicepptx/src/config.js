import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllowedUserIds } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. Check .env against .env.example.`);
  return v;
}

export const config = {
  appRoot: APP_ROOT,
  promptsDir: path.join(APP_ROOT, "prompts"),
  outDir: path.join(APP_ROOT, "out"),
  stateDir: path.join(APP_ROOT, "state"),
  l3Dir: path.resolve(APP_ROOT, "..", "..", "reference"),
  telegram: {
    token: required("TELEGRAM_BOT_TOKEN"),
    // Telegraf wraps each update handler in a p-timeout (default 90s). The Claude
    // generation agent runs INSIDE the handler and takes minutes (write→render→
    // look→fix; first end-to-end was 166s). With the 90s default, telegraf fired a
    // "Promise timed out after 90000 milliseconds" mid-build and bot.catch told the
    // user it failed while the deck was still being made. Give the handler headroom
    // above the generation budget. 0 / "off" disables the timeout entirely.
    handlerTimeoutMs: (() => {
      const raw = (process.env.HANDLER_TIMEOUT_MS ?? "600000").trim();
      if (raw === "0" || raw.toLowerCase() === "off") return Infinity;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : 600000;
    })(),
  },
  openai: {
    apiKey: required("OPENAI_API_KEY"),
    whisperModel: process.env.WHISPER_MODEL || "whisper-1",
    // "translate" → Whisper /translations: any spoken language comes out as
    // English (so a non-English brief still yields an English deck). "transcribe"
    // → keep the spoken language verbatim. Default translate for cross-language briefing.
    voiceMode: (process.env.VOICE_MODE || "translate").toLowerCase(),
    ttsModel: process.env.TTS_MODEL || "tts-1",
    ttsVoice: process.env.TTS_VOICE || "alloy",
  },
  // LLM for the fallback openai generation engine only (generate_openai.js). The
  // conversation + outline "brain" no longer reads this — it runs on Claude (below).
  llm: buildLlmConfig(),
  // The reasoning "brain" — conversation (converse.js) + outline (outline.js) — runs
  // on the logged-in `claude` CLI (subscription, no API key), same trick as the
  // generation engine. Mechanical state-machine turns use a fast/cheap model; the
  // taste-heavy outline uses a strong one (generator/verifier split).
  brain: {
    converseModel: process.env.CONVERSE_MODEL || "claude-haiku-4-5",
    outlineModel: process.env.OUTLINE_MODEL || "claude-opus-4-8",
    // Post-delivery refine loop: reads each message and decides edit / done / chat /
    // clarify. Uses a stronger model than the interview (sonnet, not haiku) because it
    // must judge intent AND resolve vague references ("make it bigger") into a concrete
    // change — and when unsure, ask rather than trigger a wasted ~3-min rebuild.
    refineModel: process.env.REFINE_MODEL || "claude-sonnet-4-6",
  },
  // Deck-generation engine. "claude" (default) = Claude Code agent w/ render-and-look
  // loop (generate_claude.js); "openai" = one-shot chat model (generate_openai.js).
  generation: {
    engine: (process.env.GENERATION_ENGINE || "claude").toLowerCase(),
    claudeBin: process.env.CLAUDE_BIN || "claude",
    // render_deck runs model-written JS. "auto" (default) sandboxes it with bwrap when
    // bwrap works on this host, else runs it with a scrubbed env and logs a warning;
    // "bwrap" refuses to render without the sandbox. See src/mcp/render_sandbox.js.
    renderSandbox: (process.env.RENDER_SANDBOX || "auto").toLowerCase(),
    // Research mode (below) adds agent turns + network round-trips, so the default
    // cap is 3.00 (was 2.00) to keep a research run from aborting mid-build.
    maxBudgetUsd: Number(process.env.GENERATION_MAX_BUDGET_USD || "3.00"),
  },
  // Research-backed citations. When on (default), the pipeline stops inventing
  // specifics: the outline writes directional claims only, and the generation agent
  // grounds every figure/entity/date/quote in a REAL retrieved source (find_sources
  // → Semantic Scholar/Crossref, plus a web fallback) and renders an inline footnote.
  // Off restores the old "invent plausible specifics for visual punch" behavior.
  research: {
    mode: (() => {
      const raw = (process.env.RESEARCH_MODE ?? "on").trim().toLowerCase();
      return !(raw === "off" || raw === "0" || raw === "false");
    })(),
    maxSources: Math.max(1, Number(process.env.RESEARCH_MAX_SOURCES || "4")),
  },
  // Fails closed: an empty allowlist throws here, so the bot never starts open.
  allowedUserIds: parseAllowedUserIds(process.env.ALLOWED_USER_IDS),
};

function buildLlmConfig() {
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  if (provider === "deepseek") {
    return {
      provider: "deepseek",
      apiKey: required("DEEPSEEK_API_KEY"),
      baseURL: "https://api.deepseek.com",
      model: process.env.LLM_MODEL || "deepseek-chat",
    };
  }
  return {
    provider: "openai",
    apiKey: required("OPENAI_API_KEY"),
    baseURL: undefined,
    model: process.env.LLM_MODEL || "gpt-4o",
  };
}
