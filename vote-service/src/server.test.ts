import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createIdentity } from "./identity.js";
import { createVoteServer, type ServerConfig, type Store } from "./server.js";
import type { SmsSender } from "./sms.js";
import { openStore } from "./store.js";
import { createVerifier } from "./verify.js";

const SECRET = "s".repeat(32);

// A stand-in for the SMS provider that keeps what it was asked to send.
function fakeSms() {
  const sent: { to: string; text: string }[] = [];
  const sender: SmsSender = {
    async send(to, text) {
      sent.push({ to, text });
    },
  };
  // The code in the last message to this number (international form).
  const codeFor = (to: string) => {
    const last = sent.filter((m) => m.to === to).at(-1);
    assert.ok(last, `no SMS was sent to ${to}`);
    return /\b(\d{6})\b/.exec(last.text)![1];
  };
  return { sender, sent, codeFor };
}

// Test numbers: German mobiles 0151 00000001, 0151 00000002, …
const phone = (n: number) => `0151 ${String(n).padStart(8, "0")}`;
const e164 = (n: number) => `+49151${String(n).padStart(8, "0")}`;

// Every server started by a test is closed when the file ends, even if an
// assertion threw first. Otherwise one failing test leaves a server open and
// the whole run hangs instead of reporting the failure.
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function start(overrides: Partial<ServerConfig> = {}, dbPath = ":memory:") {
  const store = openStore(dbPath);
  store.createContest({ id: "pets", title: "Best pet", options: ["Cat", "Dog"] });
  store.createContest({ id: "old", title: "Old", options: ["X", "Y"] });
  store.closeContest("old");
  const sms = fakeSms();
  const server = createVoteServer({
    store,
    identity: createIdentity({ secret: SECRET, secure: false }),
    verifier: createVerifier({ secret: SECRET }),
    sms: sms.sender,
    log: () => {},
    ...overrides,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= new Promise<void>((r) => {
      server.close(() => {
        store.close();
        r();
      });
      server.closeAllConnections();
    }));
  cleanups.push(close);
  return { url, store, close, sms };
}

type Reply = { status: number; json: any; cookie: string | null; headers: Headers };

async function post(
  url: string,
  body: unknown,
  opts: { cookie?: string | null; type?: string; headers?: Record<string, string>; path?: string } = {},
): Promise<Reply> {
  const res = await fetch(`${url}${opts.path ?? "/votes"}`, {
    method: "POST",
    headers: {
      "Content-Type": opts.type ?? "application/json",
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie()[0];
  return { status: res.status, json: await res.json(), cookie: set ? set.split(";")[0] : null, headers: res.headers };
}

const VOTE = { contestId: "pets", choice: "Cat", phone: phone(1) };

const confirm = (url: string, body: unknown, cookie: string | null) =>
  post(url, body, { cookie, path: "/votes/confirm" });

// Both steps: ask for a code, read it from the (fake) SMS, send it back.
// Returns the confirm reply plus the voter cookie from step 1.
async function voteFully(
  s: Awaited<ReturnType<typeof start>>,
  body: { contestId: string; choice: string; phone: string },
  opts: { cookie?: string | null; headers?: Record<string, string> } = {},
) {
  const first = await post(s.url, body, opts);
  assert.equal(first.status, 202, `step 1 answered ${first.status}: ${JSON.stringify(first.json)}`);
  const cookie = first.cookie ?? opts.cookie ?? null;
  const n = Number(body.phone.replace(/\D/g, "").slice(-8));
  const code = s.sms.codeFor(e164(n));
  const second = await post(s.url, { contestId: body.contestId, code }, { cookie, path: "/votes/confirm", headers: opts.headers });
  return { ...second, cookie };
}

test("full flow: code, confirm, keep the cookie, vote again is refused, tally shows one vote", async () => {
  const s = await start();
  const first = await voteFully(s, VOTE);
  assert.equal(first.status, 201);
  assert.ok(first.cookie, "server issues a voter cookie");

  const again = await post(s.url, { contestId: "pets", choice: "Dog", phone: phone(2) }, { cookie: first.cookie });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /already voted/);

  const res = await fetch(`${s.url}/contests/pets`);
  assert.equal(res.status, 200);
  const contest: any = await res.json();
  assert.equal(contest.title, "Best pet");
  assert.deepEqual(contest.options, ["Cat", "Dog"]);
  assert.deepEqual(contest.tally, [
    { choice: "Cat", votes: 1 },
    { choice: "Dog", votes: 0 },
  ]);
  await s.close();
});

test("a returning voter is not issued a new cookie", async () => {
  const s = await start();
  const first = await post(s.url, VOTE);
  const second = await post(s.url, VOTE, { cookie: first.cookie });
  assert.equal(second.cookie, null);
  await s.close();
});

test("a forged cookie does not give an identity, a fresh one is issued", async () => {
  const s = await start();
  const forged = "voter=11111111-1111-4111-8111-111111111111.bogus";
  const r = await post(s.url, VOTE, { cookie: forged });
  assert.equal(r.status, 202);
  assert.ok(r.cookie && !r.cookie.includes("11111111-1111"));
  await s.close();
});

test("voterId in the body is rejected, a client cannot pick who it is", async () => {
  const s = await start();
  const r = await post(s.url, { ...VOTE, voterId: "someone-else" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /unknown field: voterId/);
  await s.close();
});

test("new visitors from one address are limited (the cookie-clearing defence)", async () => {
  const s = await start({ newIdentityLimit: { max: 2, windowMs: 60_000 } });
  assert.equal((await post(s.url, { ...VOTE, phone: phone(1) })).status, 202); // visitor 1
  assert.equal((await post(s.url, { ...VOTE, phone: phone(2) })).status, 202); // visitor 2 (no cookie sent)
  const third = await post(s.url, { ...VOTE, phone: phone(3) }); // visitor 3
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get("retry-after")) >= 1);
  assert.equal(third.cookie, null, "no identity is issued to a refused visitor");
  await s.close();
});

test("a returning voter is not blocked by the new-visitor limit", async () => {
  const s = await start({ newIdentityLimit: { max: 1, windowMs: 60_000 } });
  const first = await voteFully(s, VOTE);
  assert.equal(first.status, 201);
  const again = await post(s.url, VOTE, { cookie: first.cookie });
  assert.equal(again.status, 409); // refused as a duplicate, not as 429
  await s.close();
});

test("too many votes per minute from one address get 429 with Retry-After", async () => {
  const s = await start({ voteLimit: { max: 2, windowMs: 60_000 } });
  const first = await post(s.url, VOTE);
  await post(s.url, VOTE, { cookie: first.cookie });
  const third = await post(s.url, VOTE, { cookie: first.cookie });
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get("retry-after")) >= 1);
  await s.close();
});

test("X-Forwarded-For is ignored unless a proxy is trusted", async () => {
  const s = await start({ voteLimit: { max: 1, windowMs: 60_000 } });
  const first = await post(s.url, VOTE, { headers: { "X-Forwarded-For": "9.9.9.1" } });
  const second = await post(s.url, VOTE, {
    cookie: first.cookie,
    headers: { "X-Forwarded-For": "9.9.9.2" }, // a lie, hoping for a fresh limit
  });
  assert.equal(second.status, 429);
  await s.close();
});

test("behind a trusted proxy the last X-Forwarded-For entry is the client, not what the client wrote", async () => {
  const s = await start({ trustProxy: true, voteLimit: { max: 1, windowMs: 60_000 } });
  const first = await post(s.url, VOTE, { headers: { "X-Forwarded-For": "1.1.1.1, 5.5.5.5" } });
  // the client changes the part it controls; the proxy's entry (last) is the same
  const spoof = await post(s.url, VOTE, {
    cookie: first.cookie,
    headers: { "X-Forwarded-For": "2.2.2.2, 5.5.5.5" },
  });
  assert.equal(spoof.status, 429);
  // a different real client (different last entry) has its own allowance
  const other = await post(s.url, VOTE, { headers: { "X-Forwarded-For": "1.1.1.1, 6.6.6.6" } });
  assert.equal(other.status, 202);
  await s.close();
});

test("anything but JSON is refused with 415", async () => {
  const s = await start();
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const r = await post(s.url, "contestId=pets&choice=Cat", { type });
    assert.equal(r.status, 415, type);
  }
  const ok = await post(s.url, VOTE, { type: "application/json; charset=utf-8" });
  assert.equal(ok.status, 202);
  await s.close();
});

test("a body over the limit is refused with 413 (declared length)", async () => {
  const s = await start({ maxBodyBytes: 100 });
  const r = await post(s.url, { ...VOTE, choice: "x".repeat(500) });
  assert.equal(r.status, 413);
  await s.close();
});

test("a body over the limit is refused with 413 even with no declared length (chunked)", async () => {
  const s = await start({ maxBodyBytes: 100 });
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      `${s.url}/votes`,
      { method: "POST", headers: { "Content-Type": "application/json" } }, // no Content-Length: chunked
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.write('{"contestId":"pets","choice":"' + "x".repeat(300));
    req.end('"}');
  });
  assert.equal(status, 413);
  await s.close();
});

test("malformed JSON and wrong shapes are 400", async () => {
  const s = await start();
  assert.equal((await post(s.url, "{not json")).status, 400);
  assert.equal((await post(s.url, "")).status, 400);
  assert.equal((await post(s.url, [1, 2])).status, 400);
  assert.equal((await post(s.url, { contestId: "pets", choice: 42 })).status, 400);
  assert.equal((await post(s.url, { contestId: "pets" })).status, 400);
  assert.equal((await post(s.url, { contestId: "pets", choice: "Cat" })).status, 400, "no phone");
  await s.close();
});

test("store rules map to the right status codes", async () => {
  const s = await start();
  assert.equal((await post(s.url, { ...VOTE, contestId: "nope" })).status, 404);
  assert.equal((await post(s.url, { ...VOTE, choice: "Fish" })).status, 400);
  assert.equal((await post(s.url, { ...VOTE, contestId: "old", choice: "X" })).status, 409);
  assert.equal(s.sms.sent.length, 0, "no SMS for a vote that could never count");
  await s.close();
});

test("wrong method is 405 with Allow, unknown path is 404", async () => {
  const s = await start();
  const get = await fetch(`${s.url}/votes`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const del = await fetch(`${s.url}/contests/pets`, { method: "DELETE" });
  assert.equal(del.status, 405);
  assert.equal((await fetch(`${s.url}/admin`)).status, 404);
  await s.close();
});

test("GET /contests/:id is 404 for unknown, malformed and path-like ids", async () => {
  const s = await start();
  for (const id of ["nope", "has%20space", "..%2Fetc", "%E0%A4%A", "a'b"]) {
    assert.equal((await fetch(`${s.url}/contests/${id}`)).status, 404, id);
  }
  await s.close();
});

test("responses carry nosniff and no-store", async () => {
  const s = await start();
  const res = await fetch(`${s.url}/contests/pets`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
  await res.text();
  await s.close();
});

test("an internal error is logged but its detail is not sent to the client", async () => {
  const logged: string[] = [];
  const broken = {
    getContest: () => {
      throw new Error("disk at /var/secret/path exploded");
    },
  } as unknown as Store;
  const server = createVoteServer({
    store: broken,
    identity: createIdentity({ secret: SECRET, secure: false }),
    verifier: createVerifier({ secret: SECRET }),
    sms: fakeSms().sender,
    log: (m) => logged.push(m),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${url}/contests/pets`);
  const text = await res.text();
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(text), { error: "internal error" });
  assert.ok(!text.includes("secret"));
  assert.equal(logged.length, 1);
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  );
});

// ---- yourVote ----

test("GET /contests/:id tells a voter what they chose, and strangers nothing", async () => {
  const s = await start();
  const stranger: any = await (await fetch(`${s.url}/contests/pets`)).json();
  assert.equal(stranger.yourVote, null);

  const voted = await voteFully(s, VOTE);
  const mine: any = await (await fetch(`${s.url}/contests/pets`, { headers: { Cookie: voted.cookie! } })).json();
  assert.equal(mine.yourVote, "Cat");

  const other = await voteFully(s, { contestId: "pets", choice: "Dog", phone: phone(2) });
  const theirs: any = await (await fetch(`${s.url}/contests/pets`, { headers: { Cookie: other.cookie! } })).json();
  assert.equal(theirs.yourVote, "Dog");

  const forged = "voter=11111111-1111-4111-8111-111111111111.bogus";
  const faked: any = await (await fetch(`${s.url}/contests/pets`, { headers: { Cookie: forged } })).json();
  assert.equal(faked.yourVote, null);
  await s.close();
});

test("a read-only GET never issues a voter cookie", async () => {
  const s = await start();
  const res = await fetch(`${s.url}/contests/pets`);
  assert.equal(res.headers.getSetCookie().length, 0);
  await res.text();
  await s.close();
});

// ---- the page ----

function pageDir() {
  const dir = mkdtempSync(join(tmpdir(), "page-"));
  writeFileSync(join(dir, "index.html"), "<h1>page</h1>");
  writeFileSync(join(dir, "app.js"), "// app");
  writeFileSync(join(dir, "view.js"), "// view");
  writeFileSync(join(dir, "theme.js"), "// theme");
  writeFileSync(join(dir, "features.html"), "<h1>features</h1>");
  writeFileSync(join(dir, "features.js"), "// features");
  writeFileSync(join(dir, "snippets.json"), "{}");
  writeFileSync(join(dir, "style.css"), "/* css */");
  writeFileSync(join(dir, "app.test.js"), "// must never be served");
  writeFileSync(join(dir, "secret.txt"), "nope");
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the page files are served with a strict Content-Security-Policy", async () => {
  const s = await start({ publicDir: pageDir() });
  const home = await fetch(`${s.url}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type")!, /^text\/html/);
  assert.equal(await home.text(), "<h1>page</h1>");
  const csp = home.headers.get("content-security-policy")!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.equal(home.headers.get("x-content-type-options"), "nosniff");

  const features = await fetch(`${s.url}/features`);
  assert.equal(await features.text(), "<h1>features</h1>");
  assert.match(features.headers.get("content-security-policy")!, /script-src 'self'/);
  const snippets = await fetch(`${s.url}/snippets.json`);
  assert.match(snippets.headers.get("content-type")!, /^application\/json/);
  await snippets.text();
  for (const path of ["/app.js", "/view.js", "/theme.js", "/features.js"]) {
    const js = await fetch(`${s.url}${path}`);
    assert.match(js.headers.get("content-type")!, /^text\/javascript/, path);
    await js.text();
  }
  const css = await fetch(`${s.url}/style.css`);
  assert.match(css.headers.get("content-type")!, /^text\/css/);
  await css.text();
  await s.close();
});

test("GET /settings tells the Features page how this instance is set up, and nothing secret", async () => {
  const s = await start({ demoCodes: true, smsPerPhoneLimit: { max: 2, windowMs: 7_200_000 } });
  const res = await fetch(`${s.url}/settings`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.deepEqual(body, {
    smsMode: "demo",
    code: { digits: 6, validMinutes: 10, maxAttempts: 5 },
    limits: {
      votesPerAddress: { max: 30, windowMs: 60_000 },
      newVotersPerAddress: { max: 20, windowMs: 3_600_000 },
      codesPerNumber: { max: 2, windowMs: 7_200_000 },
    },
    trustProxy: false,
  });
  assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET), "the secret never leaves the server");
  const post = await fetch(`${s.url}/settings`, { method: "POST" });
  assert.equal(post.status, 405);
  await post.text();
  await s.close();

  const plain = await start();
  const logMode: any = await (await fetch(`${plain.url}/settings`)).json();
  assert.equal(logMode.smsMode, "log");
  await plain.close();
});

test("only the listed page files are served, nothing else in the folder", async () => {
  const s = await start({ publicDir: pageDir() });
  for (const path of ["/secret.txt", "/app.test.js", "/index.html", "/../secret.txt", "/%2e%2e/secret.txt"]) {
    const res = await fetch(`${s.url}${path}`);
    assert.equal(res.status, 404, path);
    await res.text();
  }
  await s.close();
});

test("the page is GET-only", async () => {
  const s = await start({ publicDir: pageDir() });
  const res = await fetch(`${s.url}/`, { method: "POST", body: "x" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
  await res.text();
  await s.close();
});

test("without a publicDir the server is API-only", async () => {
  const s = await start();
  assert.equal((await fetch(`${s.url}/`)).status, 404);
  await s.close();
});

test("a missing page file stops startup instead of failing per request", () => {
  const empty = mkdtempSync(join(tmpdir(), "page-"));
  after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(
    () =>
      createVoteServer({
        store: {} as unknown as Store,
        identity: createIdentity({ secret: SECRET, secure: false }),
        verifier: createVerifier({ secret: SECRET }),
        sms: fakeSms().sender,
        publicDir: empty,
      }),
    /ENOENT/,
  );
});

// ---- the SMS step ----

const fixedCodes = (...codes: string[]) => {
  let i = 0;
  return createVerifier({ secret: SECRET, newCode: () => codes[Math.min(i++, codes.length - 1)] });
};

test("step 1 sends a code and counts nothing; the right code counts the vote", async () => {
  const s = await start();
  const first = await post(s.url, VOTE);
  assert.equal(first.status, 202);
  assert.equal(first.json.status, "code_sent");
  assert.equal(first.json.sentTo, "+49 ••••••••001");
  assert.equal(first.json.expiresInSeconds, 600);
  assert.equal("demoCode" in first.json, false, "the code is not in the answer outside demo mode");
  assert.equal(s.sms.sent.length, 1);
  assert.equal(s.sms.sent[0].to, e164(1), "the SMS goes to the normalised number");
  assert.match(s.sms.sent[0].text, /\b\d{6}\b/);

  const before: any = await (await fetch(`${s.url}/contests/pets`, { headers: { Cookie: first.cookie! } })).json();
  assert.deepEqual(before.tally.map((r: any) => r.votes), [0, 0], "a pending vote is not counted");
  assert.equal("smsDemo" in before, false, "the page is not told to offer test numbers outside demo mode");
  assert.equal(before.yourVote, null);

  const second = await confirm(s.url, { contestId: "pets", code: s.sms.codeFor(e164(1)) }, first.cookie);
  assert.equal(second.status, 201);
  assert.equal(second.cookie, null, "confirming never issues an identity");
  const after: any = await (await fetch(`${s.url}/contests/pets`, { headers: { Cookie: first.cookie! } })).json();
  assert.deepEqual(after.tally.map((r: any) => r.votes), [1, 0]);
  assert.equal(after.yourVote, "Cat");
  await s.close();
});

test("demo mode puts the code in the answer, so the page can show it", async () => {
  const s = await start({ demoCodes: true });
  const first = await post(s.url, VOTE);
  assert.equal(first.status, 202);
  assert.equal(first.json.demoCode, s.sms.codeFor(e164(1)));
  const contest: any = await (await fetch(`${s.url}/contests/pets`)).json();
  assert.equal(contest.smsDemo, true, "so the page can say no real number is needed");
  await s.close();
});

test("clearing cookies does not give a second vote: the number has voted", async () => {
  const s = await start();
  assert.equal((await voteFully(s, VOTE)).status, 201);
  const fresh = await post(s.url, { ...VOTE, choice: "Dog", phone: "+49 151 00000001" }); // no cookie, other spelling
  assert.equal(fresh.status, 409);
  assert.match(fresh.json.error, /phone number has already voted/);
  assert.equal(fresh.json.reason, "phone_used");
  assert.equal(s.sms.sent.length, 1, "no SMS is sent for a number that has voted");
  // the same number may still vote in another contest
  s.store.createContest({ id: "food", title: "Food", options: ["Pizza", "Pasta"] });
  assert.equal((await voteFully(s, { contestId: "food", choice: "Pizza", phone: phone(1) })).status, 201);
  await s.close();
});

test("one number pending in two browsers: the first confirm counts, the second is refused", async () => {
  const s = await start({ verifier: fixedCodes("111111", "222222") });
  const a = await post(s.url, VOTE);
  const b = await post(s.url, { ...VOTE, choice: "Dog" });
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal((await confirm(s.url, { contestId: "pets", code: "222222" }, b.cookie)).status, 201);
  const late = await confirm(s.url, { contestId: "pets", code: "111111" }, a.cookie);
  assert.equal(late.status, 409);
  assert.match(late.json.error, /phone number has already voted/);
  const contest: any = await (await fetch(`${s.url}/contests/pets`)).json();
  assert.deepEqual(contest.tally, [
    { choice: "Cat", votes: 0 },
    { choice: "Dog", votes: 1 },
  ]);
  await s.close();
});

test("a wrong code uses an attempt; the fifth wrong code ends the pending vote", async () => {
  const s = await start({ verifier: fixedCodes("123456") });
  const first = await post(s.url, VOTE);
  for (const left of [4, 3, 2, 1]) {
    const r = await confirm(s.url, { contestId: "pets", code: "000000" }, first.cookie);
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "wrong code", reason: "wrong_code", attemptsLeft: left });
  }
  const fifth = await confirm(s.url, { contestId: "pets", code: "000000" }, first.cookie);
  assert.equal(fifth.status, 410);
  assert.match(fifth.json.error, /too many wrong codes/);
  // the right code is no use now: the vote has to be started again
  const late = await confirm(s.url, { contestId: "pets", code: "123456" }, first.cookie);
  assert.equal(late.status, 404);
  await s.close();
});

test("a code is good for ten minutes", async () => {
  let t = 1_700_000_000_000;
  const s = await start({ verifier: fixedCodes("123456"), now: () => t });
  const first = await post(s.url, VOTE);
  t += 10 * 60_000; // exactly ten minutes later: expired
  const r = await confirm(s.url, { contestId: "pets", code: "123456" }, first.cookie);
  assert.equal(r.status, 410);
  assert.match(r.json.error, /expired/);
  assert.equal((await confirm(s.url, { contestId: "pets", code: "123456" }, first.cookie)).status, 404);

  const again = await post(s.url, VOTE, { cookie: first.cookie });
  t += 10 * 60_000 - 1; // one millisecond before the end: still good
  assert.equal(again.status, 202);
  assert.equal((await confirm(s.url, { contestId: "pets", code: "123456" }, first.cookie)).status, 201);
  await s.close();
});

test("a code only works for the browser it was sent to", async () => {
  const s = await start({ verifier: fixedCodes("111111", "222222") });
  const a = await post(s.url, VOTE);
  const b = await post(s.url, { ...VOTE, phone: phone(2) });
  const stolen = await confirm(s.url, { contestId: "pets", code: "111111" }, b.cookie); // a's code, b's cookie
  assert.equal(stolen.status, 400);
  const none = await confirm(s.url, { contestId: "pets", code: "111111" }, null); // no cookie at all
  assert.equal(none.status, 404);
  assert.equal(none.cookie, null, "confirm never issues an identity");
  assert.equal((await confirm(s.url, { contestId: "pets", code: "111111" }, a.cookie)).status, 201);
  await s.close();
});

test("asking for a new code replaces the old one", async () => {
  const s = await start({ verifier: fixedCodes("111111", "222222") });
  const first = await post(s.url, VOTE);
  await post(s.url, { ...VOTE, choice: "Dog" }, { cookie: first.cookie });
  assert.equal((await confirm(s.url, { contestId: "pets", code: "111111" }, first.cookie)).status, 400);
  assert.equal((await confirm(s.url, { contestId: "pets", code: "222222" }, first.cookie)).status, 201);
  const contest: any = await (await fetch(`${s.url}/contests/pets`, { headers: { Cookie: first.cookie! } })).json();
  assert.equal(contest.yourVote, "Dog", "the choice from the latest request counts");
  await s.close();
});

test("one number gets only a few codes per hour, whichever browser asks", async () => {
  const s = await start({ smsPerPhoneLimit: { max: 2, windowMs: 60 * 60_000 } });
  const first = await post(s.url, VOTE);
  assert.equal((await post(s.url, VOTE, { cookie: first.cookie })).status, 202);
  const third = await post(s.url, VOTE); // a fresh browser, same number
  assert.equal(third.status, 429);
  assert.match(third.json.error, /too many codes for this number/);
  assert.equal(third.json.reason, "too_many_codes");
  assert.ok(Number(third.headers.get("retry-after")) >= 1);
  assert.equal(s.sms.sent.length, 2);
  assert.equal((await post(s.url, { ...VOTE, phone: phone(2) })).status, 202, "other numbers are not affected");
  await s.close();
});

test("when the SMS can't be sent: 502, logged, and no vote is left waiting", async () => {
  const logged: string[] = [];
  const s = await start({
    verifier: fixedCodes("123456"),
    sms: {
      async send() {
        throw new Error("provider down");
      },
    },
    log: (m) => logged.push(m),
  });
  const first = await post(s.url, VOTE);
  assert.equal(first.status, 502);
  assert.deepEqual(logged, ["sms send failed"]);
  assert.equal((await confirm(s.url, { contestId: "pets", code: "123456" }, first.cookie)).status, 404);
  await s.close();
});

test("a contest closed between code and confirm refuses the vote", async () => {
  const s = await start({ verifier: fixedCodes("123456") });
  const first = await post(s.url, VOTE);
  s.store.closeContest("pets");
  const r = await confirm(s.url, { contestId: "pets", code: "123456" }, first.cookie);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /closed/);
  await s.close();
});

test("confirm checks its body and its method like POST /votes does", async () => {
  const s = await start();
  const first = await post(s.url, VOTE);
  assert.equal((await confirm(s.url, { contestId: "pets", code: "12" }, first.cookie)).status, 400);
  assert.equal((await confirm(s.url, { contestId: "pets", code: "123456", voterId: "x" }, first.cookie)).status, 400);
  assert.equal((await post(s.url, "{", { cookie: first.cookie, path: "/votes/confirm" })).status, 400);
  assert.equal(
    (await post(s.url, "code=123456", { cookie: first.cookie, path: "/votes/confirm", type: "text/plain" })).status,
    415,
  );
  const get = await fetch(`${s.url}/votes/confirm`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  await get.text();
  await s.close();
});

test("the phone number is never stored, only its keyed hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "votes-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "votes.sqlite");
  const s = await start({ verifier: fixedCodes("123456") }, file);
  await post(s.url, { ...VOTE, phone: phone(2) }); // stays pending
  assert.equal((await voteFully(s, VOTE)).status, 201); // counted
  const raw = new DatabaseSync(file);
  const everything = JSON.stringify([
    raw.prepare("SELECT * FROM votes").all(),
    raw.prepare("SELECT * FROM pending_votes").all(),
  ]);
  raw.close();
  assert.ok(everything.includes("phone_hash"));
  assert.ok(!everything.includes("15100000001") && !everything.includes("15100000002"), "no number in the database");
  assert.ok(!everything.includes("123456"), "no code in the database");
  await s.close();
});
