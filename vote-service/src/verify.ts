import { createHmac, randomInt } from "node:crypto";

// The SMS step's secrets and codes. Neither a phone number nor a code is ever
// stored as typed: the database only sees keyed hashes (HMAC-SHA256), so a
// leaked database file gives away neither who voted nor a usable code.
//
// Why keyed and not a plain hash: there are only about a billion mobile numbers,
// so a plain SHA-256 of a number can be reversed by trying them all. Without
// the server's secret, an HMAC can't.

const MIN_SECRET_LENGTH = 32;

// feature:code-rules
export const CODE_DIGITS = 6;
export const CODE_TTL_MS = 10 * 60_000; // a code is good for 10 minutes
export const MAX_CODE_ATTEMPTS = 5; // then the code is dead and a new one is needed
// end feature

export type VerifierConfig = {
  secret: string;
  // Injectable, so tests can know the code without reading an SMS.
  newCode?: () => string;
};

export function createVerifier(config: VerifierConfig) {
  if (config.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`verifier secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  // The prefixes keep the two uses apart: a phone hash can never equal a code hash.
  const hmac = (text: string) => createHmac("sha256", config.secret).update(text).digest("base64url");

  return {
    // feature:phone-hash
    // The same number always gives the same hash, which is what lets the
    // database refuse a second vote from it (UNIQUE (contest_id, phone_hash)).
    phoneHash(phone: string): string {
      return hmac(`phone:${phone}`);
    },
    // end feature

    // feature:code-rules
    // CODE_DIGITS digits, from the operating system's secure random source.
    newCode(): string {
      return config.newCode?.() ?? String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
    },
    // end feature

    // Bound to the contest and the voter, so a code is only worth something for
    // the one pending vote it was sent for.
    codeHash(contestId: string, voterId: string, code: string): string {
      return hmac(`code:${contestId}:${voterId}:${code}`);
    },
  };
}

// "+4915123456789" → "+49 ••••••••789": enough for the voter to recognise their
// number, not enough to read it off a screen.
export function maskPhone(phone: string): string {
  const country = phone.slice(0, 3);
  const rest = phone.slice(3);
  return `${country} ${"•".repeat(Math.max(0, rest.length - 3))}${rest.slice(-3)}`;
}
