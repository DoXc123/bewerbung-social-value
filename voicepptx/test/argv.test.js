import { test } from "node:test";
import assert from "node:assert/strict";

// config.js needs these at import time; set them before loading anything that uses it.
process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.ALLOWED_USER_IDS ||= "1";

const { buildGenArgs } = await import("../src/generate_claude.js");
const { buildBrainArgs } = await import("../src/claude_json.js");
const { childEnv, NO_HOOKS_SETTINGS } = await import("../src/claude_cli.js");

const HARDENING = ["--permission-mode", "dontAsk", "--strict-mcp-config", "--settings", NO_HOOKS_SETTINGS];
const MCP = "mcp__voicepptx__get_brief,mcp__voicepptx__get_design_guide,mcp__voicepptx__render_deck";

test("generation argv, research off: no built-in tools, only the voicepptx MCP", () => {
  assert.deepEqual(buildGenArgs({ prompt: "P", mcpConfigPath: "/o/s.mcp.json", research: false, maxBudgetUsd: 3 }), [
    "-p", "P",
    "--output-format", "json",
    "--tools", "",
    ...HARDENING,
    "--mcp-config", "/o/s.mcp.json",
    "--allowedTools", MCP,
    "--max-budget-usd", "3",
  ]);
});

test("generation argv, research on: WebSearch/WebFetch are the only built-ins", () => {
  assert.deepEqual(buildGenArgs({ prompt: "P", mcpConfigPath: "/o/s.mcp.json", research: true, maxBudgetUsd: 3 }), [
    "-p", "P",
    "--output-format", "json",
    "--tools", "WebSearch,WebFetch",
    ...HARDENING,
    "--mcp-config", "/o/s.mcp.json",
    "--allowedTools", `${MCP},mcp__voicepptx__find_sources,WebSearch,WebFetch`,
    "--max-budget-usd", "3",
  ]);
});

test("brain argv: text only, no tools", () => {
  assert.deepEqual(buildBrainArgs("P", "claude-haiku-4-5"), [
    "-p", "P", "--output-format", "json", "--tools", "", ...HARDENING, "--model", "claude-haiku-4-5",
  ]);
  assert.deepEqual(buildBrainArgs("P"), ["-p", "P", "--output-format", "json", "--tools", "", ...HARDENING]);
});

test("claude never inherits the bot's secrets", () => {
  const env = childEnv({
    PATH: "/usr/bin",
    HOME: "/home/app",
    TELEGRAM_BOT_TOKEN: "x",
    OPENAI_API_KEY: "y",
    DEEPSEEK_API_KEY: "z",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/app" });
});
