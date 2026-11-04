// Smoke test for the CLAUDE generation engine only.
//
// Uses a hard-coded full brief (outline included) so it exercises ONLY the
// voicepptx MCP server + Claude Code agent — no OpenAI calls, no outline drafting.
// This is the test to run on Hetzner where the `claude` subscription lives.
//
// Run from the app dir:
//     GENERATION_ENGINE=claude node scripts/smoke_generate_claude.js
//
// It forces GENERATION_ENGINE=claude for you, and stubs the OpenAI/Telegram env
// so config.js doesn't throw on missing-but-unused keys.

process.env.GENERATION_ENGINE = "claude";
if (!process.env.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = "smoke_dummy";
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "smoke_dummy";
if (!process.env.ALLOWED_USER_IDS) process.env.ALLOWED_USER_IDS = "1"; // config fails closed without it

const { generateDeck } = await import("../src/generate.js");

// A complete brief in the shape the bot passes (outline nested under .outline).
const brief = {
  topic: "How AI is quietly reshaping management consulting in 2026",
  slide_count: 6,
  primary_colors: "deep navy with a coral accent — consulting-grade",
  outline: {
    title: "The Quiet Reshaping",
    subtitle: "How AI is rewiring management consulting in 2026",
    slides: [
      { n: 1, title: "The Quiet Reshaping", bullets: ["AI is rewiring consulting from the inside", "2026 field view"] },
      { n: 2, title: "What changed", bullets: ["Analysis is now minutes, not weeks", "Junior leverage collapses", "Senior judgment compounds"] },
      { n: 3, title: "Three forces", bullets: ["Speed of synthesis", "Cost of a first draft → ~0", "Client expectations reset"] },
      { n: 4, title: "By the numbers", bullets: ["~40% of deck prep automatable", "2–3x faster diligence cycles"] },
      { n: 5, title: "What to do now", bullets: ["Re-tool the pyramid", "Sell outcomes, not hours", "Invest in proprietary data"] },
      { n: 6, title: "The takeaway", bullets: ["The work shifts from making slides to making decisions"] },
    ],
  },
};

const sessionId = `smokeclaude_${Date.now()}`;
console.log(`smoke(claude): sessionId=${sessionId}, slides=${brief.outline.slides.length}`);
console.log("smoke(claude): launching Claude Code agent (write -> render -> look -> fix)...\n");

const t0 = Date.now();
try {
  const result = await generateDeck(brief, sessionId);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.ok) {
    console.log(`\nsmoke(claude): [OK] in ${secs}s`);
    console.log(`       pptx -> ${result.outPath}`);
    if (result.costUsd != null) console.log(`       cost -> $${result.costUsd}`);
    if (result.summary) console.log(`       agent: ${result.summary.slice(0, 300)}`);
    process.exit(0);
  } else {
    console.log(`\nsmoke(claude): [FAIL] in ${secs}s`);
    console.log(`       error: ${(result.error || "").slice(0, 1500)}`);
    process.exit(1);
  }
} catch (err) {
  console.log(`\nsmoke(claude): [ERROR] ${(err.message || "").slice(0, 1500)}`);
  process.exit(1);
}
