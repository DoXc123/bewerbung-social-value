// Shared plumbing for every headless `claude -p` the bot spawns (the text brain in
// claude_json.js and the deck agent in generate_claude.js).
//
// - HARDENING_ARGS: no MCP servers except the ones we pass (--strict-mcp-config),
//   and no hooks. The app lives inside the workspace monorepo, so a run picks up the
//   repo's .claude/settings.json; its SessionStart hook would `git pull` the prod
//   checkout behind deploy.sh's back. Same fix as Flow's deep lane.
// - childEnv(): the bot's own secrets (dotenv puts them in process.env) never reach
//   claude, and through it the MCP server and anything that server spawns.
// - Always --permission-mode dontAsk: a tool that isn't pre-approved is refused,
//   never prompted for.

import { spawn } from "node:child_process";

export const NO_HOOKS_SETTINGS = '{"disableAllHooks": true}';

export const HARDENING_ARGS = [
  "--permission-mode", "dontAsk",
  "--strict-mcp-config",
  "--settings", NO_HOOKS_SETTINGS,
];

const SECRET_ENV = ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"];

export function childEnv(base = process.env) {
  const env = { ...base };
  for (const k of SECRET_ENV) delete env[k];
  return env;
}

export function runClaude(bin, args, { cwd, env = childEnv() } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
