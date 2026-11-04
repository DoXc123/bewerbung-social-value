import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdentity } from "./identity.js";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const make = (secure = false, secret = SECRET) => createIdentity({ secret, secure });

// "voter=abc; Path=/; ..." -> "voter=abc"  (what a browser sends back)
const cookieFrom = (setCookie: string | null) => setCookie!.split(";")[0];

test("a request with no cookie gets a new identity and a cookie to keep it", () => {
  const id = make().resolve(undefined);
  assert.match(id.voterId, /^[0-9a-f-]{36}$/);
  assert.ok(id.setCookie?.startsWith(`voter=${id.voterId}.`));
});

test("sending the issued cookie back returns the same voter, with no new cookie", () => {
  const identity = make();
  const first = identity.resolve(undefined);
  const second = identity.resolve(cookieFrom(first.setCookie));
  assert.equal(second.voterId, first.voterId);
  assert.equal(second.setCookie, null);
});

test("it still works when other cookies are present", () => {
  const identity = make();
  const first = identity.resolve(undefined);
  const header = `theme=dark; ${cookieFrom(first.setCookie)}; lang=de`;
  assert.equal(identity.resolve(header).voterId, first.voterId);
});

test("two new visitors get different ids", () => {
  const identity = make();
  assert.notEqual(identity.resolve(undefined).voterId, identity.resolve(undefined).voterId);
});

test("a forged cookie (made-up id, made-up signature) is not accepted", () => {
  const forged = "voter=11111111-1111-4111-8111-111111111111.not-a-real-signature";
  const id = make().resolve(forged);
  assert.notEqual(id.voterId, "11111111-1111-4111-8111-111111111111");
  assert.ok(id.setCookie);
});

test("changing the id inside a valid cookie breaks it", () => {
  const identity = make();
  const first = identity.resolve(undefined);
  const signature = cookieFrom(first.setCookie).split(".").slice(1).join(".");
  const tampered = `voter=22222222-2222-4222-8222-222222222222.${signature}`;
  const id = identity.resolve(tampered);
  assert.notEqual(id.voterId, "22222222-2222-4222-8222-222222222222");
  assert.ok(id.setCookie);
});

test("a cookie signed with a different secret is not accepted", () => {
  const first = make(false, OTHER_SECRET).resolve(undefined);
  const id = make().resolve(cookieFrom(first.setCookie));
  assert.notEqual(id.voterId, first.voterId);
  assert.ok(id.setCookie);
});

test("malformed cookies fall back to a new identity instead of throwing", () => {
  const identity = make();
  for (const header of ["", "voter", "voter=", "voter=abc", "voter=.", "=;;;", "voter=a.b.c"]) {
    const id = identity.resolve(header);
    assert.ok(id.setCookie, `expected a new identity for: ${header}`);
  }
});

test("the cookie is HttpOnly and SameSite=Lax, and Secure only when asked", () => {
  const plain = make(false).resolve(undefined).setCookie!;
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(make(true).resolve(undefined).setCookie!, /Secure/);
});

test("a weak secret is refused at startup", () => {
  assert.throws(() => createIdentity({ secret: "short", secure: false }), /at least 32/);
});

test("peek reads an identity without issuing one", () => {
  const identity = make();
  const first = identity.resolve(undefined);
  assert.equal(identity.peek(cookieFrom(first.setCookie)), first.voterId);
  assert.equal(identity.peek(undefined), null);
  assert.equal(identity.peek("voter=11111111-1111-4111-8111-111111111111.bogus"), null);
  assert.equal(identity.peek("voter=garbage"), null);
});
