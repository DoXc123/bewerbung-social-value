import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import path from "node:path";
import { config } from "./config.js";
import { isAuthorized } from "./auth.js";
import * as state from "./state.js";
import { transcribe } from "./transcribe.js";
import { converse } from "./converse.js";
import { refine } from "./refine.js";
import { draftOutline } from "./outline.js";
import { generateDeck } from "./generate.js";
import { synthesize } from "./speak.js";

async function replyVoice(ctx, text) {
  try {
    const audio = await synthesize(text);
    await ctx.replyWithVoice({ source: audio });
  } catch (err) {
    console.error("TTS failed, falling back to text:", err);
    await ctx.reply(text);
  }
}

function presentOutline(outline) {
  const titles = outline.slides.map((s) => `${s.n}. ${s.title}`).join("; ");
  return `I drafted ${outline.slides.length} slides for "${outline.title}". ${titles}. Say "go" or tell me what to change.`;
}

// handlerTimeout must exceed the Claude generation runtime (minutes), or telegraf
// aborts the handler mid-build and bot.catch reports a false failure. See config.js.
const bot = new Telegraf(config.telegram.token, {
  handlerTimeout: config.telegram.handlerTimeoutMs,
});

// Users with echo mode on get voice → transcript text, no pipeline.
const echoMode = new Set();

// Fails closed: config.js refuses to start with an empty allowlist.
function authorized(ctx) {
  return isAuthorized(config.allowedUserIds, ctx.from?.id);
}

bot.start(async (ctx) => {
  if (!authorized(ctx)) {
    await ctx.reply("Sorry, this bot is private.");
    return;
  }
  await state.reset(ctx.from.id);
  await ctx.reply(
    "Send a voice message describing the deck you want. I'll walk you through a few steps, " +
      "then build it — and after that we can keep tweaking it together until you're happy.\n\n" +
      "Commands: /reset to start a new deck."
  );
});

bot.command("reset", async (ctx) => {
  if (!authorized(ctx)) return;
  await state.reset(ctx.from.id);
  await ctx.reply("Cleared. Send a voice message to start a new deck.");
});

bot.command("echo", async (ctx) => {
  if (!authorized(ctx)) return;
  const userId = ctx.from.id;
  if (echoMode.has(userId)) {
    echoMode.delete(userId);
    await ctx.reply("Echo mode off. Voice messages will go through the deck pipeline again.");
  } else {
    echoMode.add(userId);
    await ctx.reply("Echo mode on. Send a voice message and I'll just send back the transcript.");
  }
});

bot.on(message("voice"), async (ctx) => {
  if (!authorized(ctx)) return;
  try {
    await ctx.sendChatAction("typing");
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const transcript = await transcribe(fileLink.toString());
    if (!transcript) {
      await ctx.reply("I couldn't make out your voice message. Could you try again?");
      return;
    }
    if (echoMode.has(ctx.from.id)) {
      await ctx.reply(transcript);
      return;
    }
    await handleUserText(ctx, transcript);
  } catch (err) {
    console.error("Voice handler error:", err);
    await ctx.reply(`Couldn't process voice: ${truncate(err.message, 200)}`);
  }
});

bot.on(message("text"), async (ctx) => {
  if (!authorized(ctx)) return;
  try {
    await handleUserText(ctx, ctx.message.text);
  } catch (err) {
    console.error("Text handler error:", err);
    await ctx.reply(`Something went wrong: ${truncate(err.message, 200)}`);
  }
});

async function handleUserText(ctx, text) {
  const userId = ctx.from.id;
  const session = await state.load(userId);

  if (session.phase === "generating") {
    await ctx.reply("Still working on your deck — hang tight.");
    return;
  }
  if (session.phase === "refining") {
    // Deck is delivered; keep talking to tweak it. The refiner decides whether the
    // message is a change to apply, a sign-off, chit-chat, or too vague to act on.
    await ctx.sendChatAction("record_voice");
    const result = await refine(session, text);
    await state.save(userId, session);
    if (result.reply) await replyVoice(ctx, result.reply);
    if (result.intent === "edit" && result.instruction) {
      await buildAndDeliver(ctx, session, userId, { editInstruction: result.instruction });
    }
    // done / chat / clarify: the reply is enough; stay in refining so they can keep going.
    return;
  }

  await ctx.sendChatAction("record_voice");
  const result = await converse(session, text);
  await state.save(userId, session);
  if (result.reply) await replyVoice(ctx, result.reply);

  // Outline-review transitions
  if (result.step === "outline_review") {
    // First entry to outline_review — draft and present
    if (!session.brief?.outline) {
      try {
        session.brief.outline = await draftOutline(session.brief);
        await state.save(userId, session);
        await replyVoice(ctx, presentOutline(session.brief.outline));
      } catch (err) {
        console.error("Outline drafter failed:", err);
        await ctx.reply(`Outline drafter failed: ${truncate(err.message, 200)}. /reset to try again.`);
      }
      return;
    }
    // Subsequent outline_review with an edit — redraft and present
    if (result.outline_edit) {
      try {
        session.brief.outline = await draftOutline(session.brief, {
          edit: result.outline_edit,
          current_outline: session.brief.outline,
        });
        await state.save(userId, session);
        await replyVoice(ctx, presentOutline(session.brief.outline));
      } catch (err) {
        console.error("Outline redraft failed:", err);
        await ctx.reply(`Outline redraft failed: ${truncate(err.message, 200)}.`);
      }
      return;
    }
  }

  if (result.step === "ready") {
    // Over a long back-and-forth the converse model can jump to "ready" without
    // ever passing through outline_review, leaving brief.outline null — which made
    // generation crash with "brief.title is required". Draft the outline now rather
    // than fail at the finish line.
    if (!session.brief?.outline?.slides?.length) {
      try {
        session.brief.outline = await draftOutline(session.brief);
        await state.save(userId, session);
      } catch (err) {
        console.error("Outline backfill before generate failed:", err);
        session.phase = "ready";
        await state.save(userId, session);
        await ctx.reply(`I couldn't draft the outline: ${truncate(err.message, 200)}. /reset to try again.`);
        return;
      }
    }

    await replyVoice(ctx, "Building your deck. About thirty seconds.");
    await buildAndDeliver(ctx, session, userId);
  }
}

// Generate (or edit) the deck and send it, then leave the session in the "refining"
// phase so the user can keep tweaking. Shared by the first build (step "ready") and
// every subsequent refine edit — the only difference is opts.editInstruction, which
// routes generation through the edit-the-prior-script path.
async function buildAndDeliver(ctx, session, userId, opts = {}) {
  const editing = Boolean(opts.editInstruction);
  const hadDeck = Boolean(session.lastGen);

  session.phase = "generating";
  await state.save(userId, session);
  await ctx.sendChatAction("upload_document");

  try {
    const sessionId = `${userId}_${Date.now()}`;
    const out = await generateDeck(
      session.brief,
      sessionId,
      editing ? { editInstruction: opts.editInstruction, editFromCjs: session.lastGen?.cjsPath } : {}
    );

    if (out.ok) {
      const nSlides = session.brief.outline?.slides?.length;
      await ctx.replyWithDocument(
        { source: out.outPath, filename: path.basename(out.outPath) },
        { caption: editing ? "Updated deck" : `Your deck${nSlides ? ` (${nSlides} slides)` : ""}` }
      );
      session.lastGen = { sessionId, cjsPath: out.cjsPath, outPath: out.outPath };
      session.phase = "refining";
      await state.save(userId, session);
      if (!editing) {
        await replyVoice(
          ctx,
          "Here's your deck. Tell me anything you'd like changed, or say you're happy with it."
        );
      }
      return;
    }

    // Failed. If we already had a good deck (or this was an edit), keep the user in the
    // refine loop with the previous deck intact rather than dead-ending them.
    const why = truncate(out.error || "unknown", 300);
    if (editing || hadDeck) {
      session.phase = "refining";
      await state.save(userId, session);
      await ctx.reply(`I couldn't apply that change (${why}). Your last deck still stands — try rephrasing it.`);
    } else {
      session.phase = "ready";
      await state.save(userId, session);
      await ctx.reply(`Generation failed after ${out.attempts} attempts: ${why}. /reset to try again.`);
    }
  } catch (err) {
    console.error("Generation failed:", err);
    if (editing || hadDeck) {
      session.phase = "refining";
      await state.save(userId, session);
      await ctx.reply(`That change failed: ${truncate(err.message, 200)}. Your last deck still stands — try again.`);
    } else {
      session.phase = "ready";
      await state.save(userId, session);
      await ctx.reply(`Generation failed: ${truncate(err.message, 200)}. /reset to start over.`);
    }
  }
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  if (ctx?.reply) ctx.reply("Unexpected error. Please /reset and try again.").catch(() => {});
});

const recovered = await state.recoverStuck();
if (recovered) console.log(`voicepptx: reset ${recovered} session(s) stuck in "generating" by a restart`);

bot.launch().catch((err) => {
  console.error("Bot launch error:", err);
  process.exit(1);
});
console.log(
  `voicepptx bot started (brain=claude converse=${config.brain.converseModel} ` +
    `outline=${config.brain.outlineModel}, generation=${config.generation.engine}, ` +
    `stt/tts=openai)`,
);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
