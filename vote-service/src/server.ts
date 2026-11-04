import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createIdentity } from "./identity.js";
import { createRateLimiter } from "./ratelimit.js";
import { codeMessage, type SmsSender } from "./sms.js";
import type { ConfirmResult, StartResult, openStore } from "./store.js";
import { contestIdProblem, parseConfirm, parseVote } from "./validate.js";
import { CODE_DIGITS, CODE_TTL_MS, MAX_CODE_ATTEMPTS, maskPhone, type createVerifier } from "./verify.js";

export type Store = ReturnType<typeof openStore>;
export type Identity = ReturnType<typeof createIdentity>;
export type Verifier = ReturnType<typeof createVerifier>;

export type ServerConfig = {
  store: Store;
  identity: Identity;
  verifier: Verifier;
  sms: SmsSender;
  // Demo only: put the code in the answer, so the page can show it. With a mock
  // sender nobody receives an SMS; config.ts refuses this in production.
  demoCodes?: boolean;
  // Behind a reverse proxy the socket address is the proxy's, not the client's.
  // Only set this when a proxy you control sits in front, or clients can lie
  // about their address with an X-Forwarded-For header.
  trustProxy?: boolean;
  maxBodyBytes?: number;
  voteLimit?: { max: number; windowMs: number }; // POST /votes and /votes/confirm per IP
  newIdentityLimit?: { max: number; windowMs: number }; // new voter ids per IP
  smsPerPhoneLimit?: { max: number; windowMs: number }; // codes sent to one number
  now?: () => number; // injectable clock, for code expiry in tests
  // Folder holding the pages (PAGE_FILES below). Without
  // it the server is API-only. Read once at startup, so a missing file fails loudly.
  publicDir?: string;
  log?: (message: string, error?: unknown) => void;
};

// The only files the server will ever serve, by exact path. There is no
// "serve this folder", so nothing else in it (tests, maps) can be requested.
const PAGE_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/view.js": { file: "view.js", type: "text/javascript; charset=utf-8" },
  "/theme.js": { file: "theme.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/features": { file: "features.html", type: "text/html; charset=utf-8" },
  "/features.js": { file: "features.js", type: "text/javascript; charset=utf-8" },
  "/snippets.json": { file: "snippets.json", type: "application/json; charset=utf-8" },
};

// The page may load only its own script and styles and talk only to this
// server, so an injected <script> or a third-party include is refused by the browser.
// feature:csp
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// end feature

const JSON_TYPE = "application/json";

export function createVoteServer(config: ServerConfig): Server {
  const { store, identity, verifier, sms } = config;
  const maxBodyBytes = config.maxBodyBytes ?? 1024; // a vote is ~50 bytes
  // feature:rate-limits
  const limits = {
    votesPerAddress: config.voteLimit ?? { max: 30, windowMs: 60_000 },
    newVotersPerAddress: config.newIdentityLimit ?? { max: 20, windowMs: 60 * 60_000 },
    // Every code is an SMS someone pays for and someone's phone receives, so a
    // number gets only a few per hour, however many browsers ask.
    codesPerNumber: config.smsPerPhoneLimit ?? { max: 3, windowMs: 60 * 60_000 },
  };
  // end feature
  const votes = createRateLimiter(limits.votesPerAddress);
  const newIdentities = createRateLimiter(limits.newVotersPerAddress);
  const codesPerPhone = createRateLimiter(limits.codesPerNumber);
  const now = config.now ?? Date.now;
  const log = config.log ?? ((m, e) => console.error(m, e));

  const assets = new Map<string, { body: Buffer; type: string }>();
  if (config.publicDir) {
    for (const [path, { file, type }] of Object.entries(PAGE_FILES)) {
      assets.set(path, { body: readFileSync(join(config.publicDir, file)), type });
    }
  }

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      // The proxy appends the address it saw, so the LAST entry is the one we
      // can trust; earlier entries were supplied by the client.
      const forwarded = req.headers["x-forwarded-for"];
      const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)
        ?.split(",")
        .pop()
        ?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function send(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string | string[]> = {},
  ): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  const fail = (res: ServerResponse, status: number, message: string, h = {}) =>
    send(res, status, { error: message }, h);

  // Reads the body, giving up as soon as it passes the limit.
  function readBody(req: IncomingMessage): Promise<string | "too_large"> {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"]);
      if (declared > maxBodyBytes) return resolve("too_large");
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          chunks.length = 0;
          req.pause();
          resolve("too_large");
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  // Layers 3 to 5, shared by both POST routes: JSON only, size limit, parse.
  // Returns undefined when it has already answered with the error.
  async function readJson(
    req: IncomingMessage,
    res: ServerResponse,
    cookie: Record<string, string>,
  ): Promise<{ body: unknown } | undefined> {
    // 3. only JSON. A cross-site HTML form can't send this content type
    //    without a CORS preflight, which we never approve (a CSRF defence).
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== JSON_TYPE) {
      fail(res, 415, "Content-Type must be application/json", cookie);
      return undefined;
    }

    // 4. size limit
    const text = await readBody(req);
    if (text === "too_large") {
      fail(res, 413, "request body too large", { ...cookie, Connection: "close" });
      return undefined;
    }

    // 5. parse (the shape is checked by the caller)
    try {
      return { body: JSON.parse(text) };
    } catch {
      fail(res, 400, "body is not valid JSON", cookie);
      return undefined;
    }
  }

  // Why a vote was refused: a status code, a sentence for people, and the
  // reason as a fixed word for the page to act on. Shared by both steps.
  function refuse(res: ServerResponse, result: StartResult | ConfirmResult, cookie = {}) {
    if (result.ok) throw new Error("refuse() called with a success");
    const answer = (status: number, error: string, extra = {}) =>
      send(res, status, { error, reason: result.reason, ...extra }, cookie);
    switch (result.reason) {
      case "unknown_contest":
        return answer(404, "no such contest");
      case "closed":
        return answer(409, "this contest is closed");
      case "unknown_option":
        return answer(400, "choice is not an option of this contest");
      case "duplicate":
        return answer(409, "you have already voted in this contest");
      case "phone_used":
        return answer(409, "this phone number has already voted in this contest");
      case "no_pending":
        return answer(404, "no vote is waiting for a code");
      case "expired":
        return answer(410, "the code has expired, request a new one");
      case "locked":
        return answer(410, "too many wrong codes, request a new one");
      case "wrong_code":
        return answer(400, "wrong code", { attemptsLeft: result.attemptsLeft });
    }
  }

  // Step 1: the voter picks an option and gives a phone number; the vote is
  // kept as pending and a code goes out by SMS. Nothing is counted yet.
  async function postVote(req: IncomingMessage, res: ServerResponse, ip: string) {
    // 1. cheapest check first: is this address sending too much?
    if (!votes.take(ip)) {
      return fail(res, 429, "too many requests", {
        "Retry-After": String(votes.retryAfterSeconds(ip)),
      });
    }

    // 2. who is voting? A valid cookie keeps its identity. No cookie means a
    //    new voter id, and each address may only create so many of those.
    const who = identity.resolve(req.headers.cookie);
    if (who.setCookie !== null && !newIdentities.take(ip)) {
      return fail(res, 429, "too many new visitors from this address", {
        "Retry-After": String(newIdentities.retryAfterSeconds(ip)),
      });
    }
    const cookie: Record<string, string> = who.setCookie ? { "Set-Cookie": who.setCookie } : {};

    // 3 to 5. JSON only, size limit, parse
    const read = await readJson(req, res, cookie);
    if (!read) return;

    // 6. the shape, including a German or UK mobile number
    const parsed = parseVote(read.body);
    if (!parsed.ok) return fail(res, 400, parsed.error, cookie);
    const { contestId, choice, phone } = parsed.value;

    // 7. how many codes has this number had lately?
    const phoneHash = verifier.phoneHash(phone);
    if (!codesPerPhone.take(phoneHash)) {
      const error = "too many codes for this number, try again later";
      return send(res, 429, { error, reason: "too_many_codes" }, {
        ...cookie,
        "Retry-After": String(codesPerPhone.retryAfterSeconds(phoneHash)),
      });
    }

    // 8. the rules that need the database, before anything is sent
    const code = verifier.newCode();
    const t = now();
    const started = store.startVote(
      {
        contestId,
        choice,
        voterId: who.voterId,
        phoneHash,
        codeHash: verifier.codeHash(contestId, who.voterId, code),
        expiresAt: t + CODE_TTL_MS,
      },
      t,
    );
    if (!started.ok) return refuse(res, started, cookie);

    // 9. send the code. If that fails, the pending vote goes too: a vote
    //    nobody can confirm should not sit there.
    try {
      await sms.send(phone, codeMessage(code, CODE_TTL_MS / 60_000));
    } catch (e) {
      store.dropPending(contestId, who.voterId);
      log("sms send failed", e);
      return fail(res, 502, "the code could not be sent, please try again", cookie);
    }
    return send(
      res,
      202,
      {
        status: "code_sent",
        sentTo: maskPhone(phone),
        expiresInSeconds: CODE_TTL_MS / 1000,
        ...(config.demoCodes ? { demoCode: code } : {}),
      },
      cookie,
    );
  }

  // Step 2: the voter sends the code back. Only then is the vote counted.
  async function postConfirm(req: IncomingMessage, res: ServerResponse, ip: string) {
    // 1. the same per-address limit as step 1
    if (!votes.take(ip)) {
      return fail(res, 429, "too many requests", {
        "Retry-After": String(votes.retryAfterSeconds(ip)),
      });
    }

    // 2. only a voter who started a vote can confirm one, so no new identity
    //    is issued here: without a valid cookie there is nothing to confirm.
    const voterId = identity.peek(req.headers.cookie);
    if (voterId === null) return refuse(res, { ok: false, reason: "no_pending" });

    // 3 to 5. JSON only, size limit, parse
    const read = await readJson(req, res, {});
    if (!read) return;

    // 6. the shape: a contest id and six digits
    const parsed = parseConfirm(read.body);
    if (!parsed.ok) return fail(res, 400, parsed.error);
    const { contestId, code } = parsed.value;

    // 7. the database checks the code, counts attempts, and counts the vote
    const result = store.confirmVote(contestId, voterId, verifier.codeHash(contestId, voterId, code), now());
    if (result.ok) return send(res, 201, { ok: true });
    return refuse(res, result);
  }

  function sendAsset(res: ServerResponse, asset: { body: Buffer; type: string }) {
    res.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": PAGE_CSP,
      "Referrer-Policy": "no-referrer",
    });
    res.end(asset.body);
  }

  function getContest(req: IncomingMessage, res: ServerResponse, rawId: string) {
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return fail(res, 404, "no such contest");
    }
    const contest = contestIdProblem(id) === null ? store.getContest(id) : null;
    if (!contest) return fail(res, 404, "no such contest");
    // Which choice (if any) the caller already made. peek() reads the cookie
    // without issuing one: a read-only request must not hand out voter ids.
    const voterId = identity.peek(req.headers.cookie);
    const yourVote = voterId === null ? null : store.getVote(id, voterId);
    // smsDemo tells the page to say no real number is needed (only in demo mode).
    send(res, 200, { ...contest, tally: store.tally(id), yourVote, ...(config.demoCodes ? { smsDemo: true } : {}) });
  }

  // How this instance is set up, for the Features page. Only values that are
  // safe to publish: never the secret, the host or the database path.
  function getSettings(res: ServerResponse) {
    send(res, 200, {
      smsMode: config.demoCodes ? "demo" : "log",
      code: { digits: CODE_DIGITS, validMinutes: CODE_TTL_MS / 60_000, maxAttempts: MAX_CODE_ATTEMPTS },
      limits,
      trustProxy: config.trustProxy === true,
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return fail(res, 400, "bad request URL");
    }
    const method = req.method ?? "GET";

    if (path === "/votes") {
      if (method !== "POST") return fail(res, 405, "use POST", { Allow: "POST" });
      return postVote(req, res, clientIp(req));
    }
    if (path === "/votes/confirm") {
      if (method !== "POST") return fail(res, 405, "use POST", { Allow: "POST" });
      return postConfirm(req, res, clientIp(req));
    }
    if (path === "/settings") {
      if (method !== "GET") return fail(res, 405, "use GET", { Allow: "GET" });
      return getSettings(res);
    }
    const contest = /^\/contests\/([^/]+)$/.exec(path);
    if (contest) {
      if (method !== "GET") return fail(res, 405, "use GET", { Allow: "GET" });
      return getContest(req, res, contest[1]);
    }
    const asset = assets.get(path);
    if (asset) {
      if (method !== "GET") return fail(res, 405, "use GET", { Allow: "GET" });
      return sendAsset(res, asset);
    }
    return fail(res, 404, "not found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      // Log the detail here; tell the client nothing about the inside.
      log(`unhandled error on ${req.method} ${req.url}`, e);
      if (!res.headersSent) fail(res, 500, "internal error");
      else res.destroy();
    });
  });
  // Slow-client defences: a connection that dribbles a request in forever
  // (a "slowloris") is cut off.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}
