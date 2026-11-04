import OpenAI, { toFile } from "openai";
import { config } from "./config.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// Download the voice file from Telegram with a bounded timeout and one retry. The
// bare fetch() has no connect timeout, so a transient network blip on the box
// surfaced as an unhandled ConnectTimeoutError (UND_ERR_CONNECT_TIMEOUT) stack.
async function downloadVoice(fileUrl, { timeoutMs = 30000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`Voice file download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Voice file download failed: ${lastErr?.message || lastErr}`);
}

export async function transcribe(fileUrl) {
  const buf = await downloadVoice(fileUrl);
  const file = await toFile(buf, "voice.ogg", { type: "audio/ogg" });
  // Cross-language: in "translate" mode any spoken language is rendered to
  // English via Whisper's /translations endpoint, so a speaker can brief the
  // deck in their native language and still get an English, consulting-grade deck.
  // "transcribe" mode keeps the spoken language as-is.
  const result =
    config.openai.voiceMode === "translate"
      ? await openai.audio.translations.create({ file, model: config.openai.whisperModel })
      : await openai.audio.transcriptions.create({ file, model: config.openai.whisperModel });
  return (result.text || "").trim();
}
