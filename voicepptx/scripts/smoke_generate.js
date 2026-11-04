// Smoke test: drafts an outline + generates one .pptx from a hard-coded brief.
// Requires a real key for whichever LLM_PROVIDER is set in .env.
// TELEGRAM_BOT_TOKEN gets a dummy since the bot isn't launched here.
//
// Run from the app dir:    node scripts/smoke_generate.js

if (!process.env.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = "smoke_dummy";
if (!process.env.ALLOWED_USER_IDS) process.env.ALLOWED_USER_IDS = "1"; // config fails closed without it

const { draftOutline } = await import("../src/outline.js");
const { generateDeck } = await import("../src/generate.js");

const userBrief = {
  topic: "How AI is quietly reshaping management consulting in 2026",
  slide_count: 8,
  primary_colors: "deep navy with a coral accent — consulting-grade",
};

const sessionId = `smoke_${Date.now()}`;
console.log(`smoke: sessionId=${sessionId}`);
console.log(`smoke: slides=${userBrief.slide_count}, colors="${userBrief.primary_colors}"\n`);

const t0 = Date.now();
console.log("smoke: drafting outline...");
const outline = await draftOutline(userBrief);
const tOutline = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`smoke: outline drafted in ${tOutline}s`);
console.log(`smoke: title="${outline.title}"`);
console.log("smoke: slides:");
for (const s of outline.slides) {
  const preview = (s.bullets || []).slice(0, 2).join(" | ");
  console.log(`         ${String(s.n).padStart(2)}. ${s.title}${preview ? `  — ${preview}` : ""}`);
}

const fullBrief = { ...userBrief, ...outline };
const t1 = Date.now();
console.log("\nsmoke: generating deck (LLM emits pptxgenjs JS, then node renders it)...");
try {
  const result = await generateDeck(fullBrief, sessionId);
  const tGen = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\nsmoke: [OK] generated in ${tGen}s`);
  console.log(`       pptx -> ${result.outPath}`);
  console.log(`       cjs  -> ${result.jsPath}`);
  process.exit(0);
} catch (err) {
  const tGen = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\nsmoke: [FAIL] after ${tGen}s`);
  console.log(`       error: ${(err.message || "").slice(0, 1500)}`);
  process.exit(1);
}
