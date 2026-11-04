import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllowedUserIds, isAuthorized } from "../src/auth.js";

const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "config.js");

test("an empty allowlist throws", () => {
  for (const raw of [undefined, "", "  ", " , ,"]) {
    assert.throws(() => parseAllowedUserIds(raw), /ALLOWED_USER_IDS is empty/);
  }
});

test("a non-numeric entry throws", () => {
  assert.throws(() => parseAllowedUserIds("123,abc"), /non-numeric/);
  assert.throws(() => parseAllowedUserIds("12.5"), /non-numeric/);
});

test("ids parse to numbers", () => {
  assert.deepEqual(parseAllowedUserIds(" 111, 222 "), [111, 222]);
});

test("only listed users are authorized; an empty list authorizes nobody", () => {
  assert.equal(isAuthorized([111, 222], 111), true);
  assert.equal(isAuthorized([111, 222], 333), false);
  assert.equal(isAuthorized([111], undefined), false);
  assert.equal(isAuthorized([], 111), false);
});

test("config refuses to load without an allowlist", () => {
  // Fresh process, cwd without a .env, so dotenv can't fill it in.
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(CONFIG)})`], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: "t", OPENAI_API_KEY: "k", ALLOWED_USER_IDS: "" },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ALLOWED_USER_IDS is empty/);
});
