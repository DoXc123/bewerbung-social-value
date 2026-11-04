import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimalEnv, bwrapArgs, renderSpawn, runRender, bwrapWorks } from "../src/mcp/render_sandbox.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the render env carries PATH and NODE_PATH only", () => {
  const env = minimalEnv("/app", { PATH: "/usr/bin", TELEGRAM_BOT_TOKEN: "x", OPENAI_API_KEY: "y", HOME: "/home/app" });
  assert.deepEqual(env, { PATH: "/usr/bin", NODE_PATH: "/app/node_modules" });
});

test("bwrap argv: homes hidden before the binds, no network, env cleared", () => {
  const args = bwrapArgs({
    appRoot: "/home/app/app",
    outDir: "/home/app/app/out",
    jsPath: "/home/app/app/out/s.cjs",
    outPath: "/home/app/app/out/d.pptx",
    execPath: "/usr/bin/node",
    env: { PATH: "/usr/bin" },
    exists: () => true,
    realpath: (p) => p,
  });
  const s = args.join(" ");
  assert.ok(s.startsWith("--ro-bind / / --tmpfs /home"));
  assert.ok(args.indexOf("--tmpfs") < args.indexOf("--bind"), "tmpfs must come before the binds");
  assert.ok(s.includes("--ro-bind /home/app/app/node_modules /home/app/app/node_modules"));
  assert.ok(s.includes("--bind /home/app/app/out /home/app/app/out"));
  assert.ok(args.includes("--unshare-all"));
  assert.ok(args.includes("--clearenv"));
  assert.ok(!s.includes("/home/app/app/.env"));
  assert.deepEqual(args.slice(-5), ["--chdir", "/home/app/app/out", "/usr/bin/node", "/home/app/app/out/s.cjs", "/home/app/app/out/d.pptx"]);
});

test("a node under a hidden dir (nvm) is bound back in", () => {
  const args = bwrapArgs({
    appRoot: "/srv/app", outDir: "/srv/app/out", jsPath: "j", outPath: "o",
    execPath: "/home/u/.nvm/bin/node", env: {}, exists: () => true, realpath: (p) => p,
  });
  assert.ok(args.join(" ").includes("--ro-bind /home/u/.nvm/bin /home/u/.nvm/bin"));
});

test("without bwrap: auto falls back to a scrubbed env, bwrap mode refuses", () => {
  const base = { appRoot: "/app", outDir: "/app/out", jsPath: "j", outPath: "o", execPath: "/usr/bin/node", sandboxAvailable: () => false };
  const auto = renderSpawn({ ...base, mode: "auto" });
  assert.equal(auto.sandboxed, false);
  assert.equal(auto.command, "/usr/bin/node");
  assert.deepEqual(Object.keys(auto.options.env).sort(), ["NODE_PATH", "PATH"]);
  assert.match(renderSpawn({ ...base, mode: "bwrap" }).error, /refusing/);
});

// End to end, only where bwrap works: the script can render with pptxgenjs but
// can't see .env files, the bot's env, or the network.
test("sandboxed script can't read secrets or reach the network", { skip: !bwrapWorks() && "bwrap unavailable here" }, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "vpx-render-"));
  const outDir = path.join(base, "session-1");          // what callers bind: out/<session>/
  const sibling = path.join(base, "session-2.brief.json"); // another session's file in out/
  await fs.mkdir(outDir);
  await fs.writeFile(sibling, "{}");
  try {
    const jsPath = path.join(outDir, "probe.cjs");
    const outPath = path.join(outDir, "probe.json");
    await fs.writeFile(
      jsPath,
      `const fs = require("fs");
       const r = { env: Object.keys(process.env).sort() };
       try { fs.readFileSync(${JSON.stringify(path.join(APP_ROOT, ".env.example"))}); r.appFiles = "visible"; } catch (e) { r.appFiles = e.code; }
       try { fs.readdirSync(${JSON.stringify(path.join(os.homedir(), ".claude"))}); r.claudeDir = "visible"; } catch (e) { r.claudeDir = e.code; }
       try { fs.readFileSync(${JSON.stringify(sibling)}); r.sibling = "visible"; } catch (e) { r.sibling = e.code; }
       try { require("pptxgenjs"); r.pptxgenjs = "ok"; } catch (e) { r.pptxgenjs = e.message; }
       require("dns").lookup("example.com", (e) => {
         r.net = e ? "blocked" : "open";
         fs.writeFileSync(process.argv[2], JSON.stringify(r));
       });`
    );
    process.env.TELEGRAM_BOT_TOKEN = "must-not-leak";
    const res = await runRender({ appRoot: APP_ROOT, outDir, jsPath, outPath, mode: "bwrap" });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.sandboxed, true);
    const r = JSON.parse(await fs.readFile(outPath, "utf8"));
    // bwrap's --chdir sets PWD; nothing else gets through.
    assert.deepEqual(r.env.filter((k) => k !== "PWD"), ["NODE_PATH", "PATH"]);
    assert.equal(r.appFiles, "ENOENT");
    assert.equal(r.sibling, "ENOENT", "another session's files must be invisible");
    const claudeDirExists = await fs.stat(path.join(os.homedir(), ".claude")).then(() => true, () => false);
    if (claudeDirExists) assert.equal(r.claudeDir, "ENOENT", "~/.claude (credentials) must be hidden");
    assert.equal(r.pptxgenjs, "ok");
    assert.equal(r.net, "blocked");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// The path prod takes until bubblewrap is installed: a real pptxgenjs render with
// only PATH + NODE_PATH in the environment.
test("fallback (no bwrap) renders a real deck with a scrubbed env", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vpx-fallback-"));
  try {
    const jsPath = path.join(outDir, "deck.cjs");
    const outPath = path.join(outDir, "deck.pptx");
    await fs.writeFile(
      jsPath,
      `const pptxgen = require("pptxgenjs");
       if (process.env.TELEGRAM_BOT_TOKEN) { console.error("token leaked"); process.exit(3); }
       (async () => {
         const pptx = new pptxgen();
         pptx.addSlide().addText("Fallback", { x: 1, y: 1, w: 4, h: 1 });
         await pptx.writeFile({ fileName: process.argv[2] });
       })();`
    );
    process.env.TELEGRAM_BOT_TOKEN = "must-not-leak";
    const res = await runRender({ appRoot: APP_ROOT, outDir, jsPath, outPath, mode: "auto", sandboxAvailable: () => false });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.sandboxed, false);
    assert.ok((await fs.stat(outPath)).size > 1000, "a real .pptx was written");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
