import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const SECRET = "k".repeat(32);

test("only the secret is required; the rest has safe defaults", () => {
  const r = loadConfig({ VOTE_SECRET: SECRET });
  assert.deepEqual(r, {
    ok: true,
    value: {
      secret: SECRET,
      port: 3000,
      host: "127.0.0.1",
      dbPath: "votes.sqlite",
      trustProxy: false,
      secureCookies: false,
      smsMode: "demo",
    },
  });
});

test("a missing or short secret stops startup", () => {
  for (const env of [{}, { VOTE_SECRET: "" }, { VOTE_SECRET: "short" }]) {
    const r = loadConfig(env);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /VOTE_SECRET/);
  }
});

test("settings are read from the environment", () => {
  const r = loadConfig({
    VOTE_SECRET: SECRET,
    PORT: "8080",
    HOST: "0.0.0.0",
    DB_PATH: "/data/v.sqlite",
    TRUST_PROXY: "1",
    NODE_ENV: "production",
    SMS_MODE: "log",
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.port, 8080);
    assert.equal(r.value.host, "0.0.0.0");
    assert.equal(r.value.dbPath, "/data/v.sqlite");
    assert.equal(r.value.trustProxy, true);
    assert.equal(r.value.secureCookies, true);
    assert.equal(r.value.smsMode, "log");
  }
});

test("a bad PORT is refused", () => {
  for (const PORT of ["abc", "-1", "70000", "80.5", "", " ", "0x50"]) {
    assert.equal(loadConfig({ VOTE_SECRET: SECRET, PORT }).ok, false, PORT);
  }
});

test("TRUST_PROXY is on only for exactly 1", () => {
  for (const TRUST_PROXY of ["true", "yes", "0", ""]) {
    const r = loadConfig({ VOTE_SECRET: SECRET, TRUST_PROXY });
    assert.ok(r.ok && !r.value.trustProxy, TRUST_PROXY);
  }
});

test("SMS_MODE is demo or log, and demo is refused in production", () => {
  const load = (env: Record<string, string>) => loadConfig({ VOTE_SECRET: SECRET, ...env });
  const mode = (env: Record<string, string>) => {
    const r = load(env);
    return r.ok ? r.value.smsMode : r.error;
  };
  assert.equal(mode({ SMS_MODE: "log" }), "log");
  assert.equal(mode({ SMS_MODE: "demo" }), "demo");
  assert.match(String(mode({ SMS_MODE: "twilio" })), /SMS_MODE must be/);
  assert.match(String(mode({ NODE_ENV: "production" })), /SMS_MODE=demo/);
  assert.match(String(mode({ NODE_ENV: "production", SMS_MODE: "demo" })), /SMS_MODE=demo/);
  assert.equal(mode({ NODE_ENV: "production", SMS_MODE: "log" }), "log");
});
