import OpenAI from "openai";
import { config } from "./config.js";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export async function synthesize(text) {
  const speech = await openai.audio.speech.create({
    model: config.openai.ttsModel,
    voice: config.openai.ttsVoice,
    input: text,
    response_format: "opus",
  });
  return Buffer.from(await speech.arrayBuffer());
}
