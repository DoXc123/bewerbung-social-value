import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.ALLOWED_USER_IDS ||= "1";

const { writeJsonAtomic, recoverStuck } = await import("../src/state.js");

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vpx-state-"));
}

test("atomic write replaces the file and leaves no temp files", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "1.json");
    await writeJsonAtomic(file, { phase: "a" });
    await writeJsonAtomic(file, { phase: "b" });
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { phase: "b" });
    assert.deepEqual(await fs.readdir(dir), ["1.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("startup resets sessions stuck in generating, and only those", async () => {
  const dir = await tmpDir();
  try {
    const put = (n, s) => fs.writeFile(path.join(dir, `${n}.json`), JSON.stringify(s));
    const get = async (n) => JSON.parse(await fs.readFile(path.join(dir, `${n}.json`), "utf8"));
    await put(1, { phase: "generating", lastGen: null });
    await put(2, { phase: "generating", lastGen: { cjsPath: "x" } });
    await put(3, { phase: "gathering" });
    await fs.writeFile(path.join(dir, "4.json"), "{not json");

    assert.equal(await recoverStuck(dir), 2);
    assert.equal((await get(1)).phase, "ready");
    assert.equal((await get(2)).phase, "refining");
    assert.equal((await get(3)).phase, "gathering");
    assert.equal(await recoverStuck(dir), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a missing state dir is not an error", async () => {
  assert.equal(await recoverStuck(path.join(os.tmpdir(), "vpx-no-such-dir-xyz")), 0);
});
