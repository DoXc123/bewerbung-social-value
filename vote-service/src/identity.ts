import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Who is voting is decided HERE, by the server. The client only carries a
// cookie the server issued; it cannot make up or alter a voter id, because
// the id is signed with a key only the server knows (HMAC-SHA256).

const COOKIE_NAME = "voter";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type IdentityConfig = {
  secret: string;
  // true in production (HTTPS): the browser then never sends the cookie over plain HTTP.
  secure: boolean;
};

export type Identity = {
  voterId: string;
  // A Set-Cookie header value when a new identity was issued, otherwise null.
  setCookie: string | null;
};

export function createIdentity(config: IdentityConfig) {
  if (config.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`identity secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  // feature:identity
  const sign = (id: string) =>
    createHmac("sha256", config.secret).update(id).digest("base64url");

  // Returns the voter id if the cookie is present AND its signature checks out.
  function verify(cookieHeader: string | undefined): string | null {
    const raw = parseCookies(cookieHeader).get(COOKIE_NAME);
    if (raw === undefined) return null;
    const dot = raw.indexOf(".");
    if (dot === -1) return null;
    const id = raw.slice(0, dot);
    if (!UUID.test(id)) return null;
    const got = Buffer.from(raw.slice(dot + 1));
    const expected = Buffer.from(sign(id));
    // timingSafeEqual compares in constant time, so response time can't
    // leak how many leading characters of a forged signature were right.
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    return id;
  }
  // end feature

  function issue(): Identity {
    const voterId = randomUUID();
    // feature:cookie
    const attributes = [
      `${COOKIE_NAME}=${voterId}.${sign(voterId)}`,
      "Path=/",
      `Max-Age=${MAX_AGE_SECONDS}`,
      "HttpOnly", // page scripts can't read it, so an XSS bug can't steal it
      "SameSite=Lax", // not sent on cross-site POSTs, which blocks forged votes from other sites
    ];
    if (config.secure) attributes.push("Secure");
    // end feature
    return { voterId, setCookie: attributes.join("; ") };
  }

  return {
    // Who this request is, WITHOUT issuing anything: null for a stranger.
    // For read-only requests that must not hand out new voter ids.
    peek(cookieHeader: string | undefined): string | null {
      return verify(cookieHeader);
    },

    // An existing valid cookie keeps its identity; anything else gets a new one.
    resolve(cookieHeader: string | undefined): Identity {
      const voterId = verify(cookieHeader);
      return voterId === null ? issue() : { voterId, setCookie: null };
    },
  };
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}
