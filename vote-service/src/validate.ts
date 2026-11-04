import { err, ok, type Result } from "./result.js";

// What a client is allowed to send. The voter is NOT in here: who is voting
// is decided by the server (identity layer), never by the request body.
// `phone` is already normalised to international form (+49…, +44…).
export type VoteInput = { contestId: string; choice: string; phone: string };
export type ConfirmInput = { contestId: string; code: string };

const MAX_LEN = 64;
const MAX_PHONE_LEN = 32;
const CONTEST_ID = /^[A-Za-z0-9-]+$/;
const CONTROL_CHARS = /\p{Cc}/u;

// Each helper returns the reason a string is not acceptable, or null if it is.
// The store reuses them when contests are created, so the rules live once.
export function contestIdProblem(value: string): string | null {
  if (value.length === 0 || value.length > MAX_LEN) {
    return `contestId must be 1 to ${MAX_LEN} characters`;
  }
  if (!CONTEST_ID.test(value)) {
    return "contestId may only contain letters, digits and hyphens";
  }
  return null;
}

export function choiceProblem(value: string): string | null {
  if (value.trim().length === 0 || value.length > MAX_LEN) {
    return `choice must be 1 to ${MAX_LEN} characters`;
  }
  if (CONTROL_CHARS.test(value)) {
    return "choice must not contain control characters";
  }
  return null;
}

// feature:phone-format
// German and UK mobile numbers only: the markets the SMS step is for.
// The national forms can't be confused: German mobiles start 015/016/017,
// UK mobiles start 07.
const DE_MOBILE = /^1[5-7]\d{8,9}$/; // after +49: 015x, 016x, 017x, 10 or 11 digits
const UK_MOBILE = /^7(?:[1-57-9]\d{8}|624\d{6})$/; // after +44: 07 mobiles, not 070 / 076 (except 07624)
// end feature

// Accepts what people type ("0151 2345 6789", "+44 (0)7700 900123", "0049-151/…")
// and returns the number in international form, or the reason it is refused.
export function parsePhone(value: string): Result<string, string> {
  if (value.length > MAX_PHONE_LEN) return err("phone is too long");
  // Spaces, dashes, dots, slashes and brackets are formatting, nothing else is allowed.
  if (!/^[+\d\s\-./()]*$/.test(value)) return err("phone may only contain digits, spaces and + - / . ( )");
  let digits = value.replace(/\(0\)/g, "").replace(/[\s\-./()]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);

  let country: "49" | "44" | null = null;
  let national = "";
  if (digits.startsWith("+49")) [country, national] = ["49", digits.slice(3)];
  else if (digits.startsWith("+44")) [country, national] = ["44", digits.slice(3)];
  else if (digits.startsWith("+")) return err("only German (+49) and UK (+44) mobile numbers are accepted");
  else if (digits.startsWith("01")) [country, national] = ["49", digits.slice(1)];
  else if (digits.startsWith("07")) [country, national] = ["44", digits.slice(1)];

  if (country === "49" && DE_MOBILE.test(national)) return ok(`+49${national}`);
  if (country === "44" && UK_MOBILE.test(national)) return ok(`+44${national}`);
  return err("phone must be a German or UK mobile number");
}

// Reject fields we don't know, so a typo like "choise" is an error, not
// a silently ignored field. Arrays and null also have typeof "object".
function objectWith(input: unknown, fields: string[]): Result<Record<string, unknown>, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err("body must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!fields.includes(key)) return err(`unknown field: ${key.slice(0, MAX_LEN)}`);
  }
  return ok(body);
}

// unknown in, a proven VoteInput (or the reason it isn't one) out.
// This checks the SHAPE only. Whether the contest exists, is open, and lists
// this choice is the store's job (it needs the database).
export function parseVote(input: unknown): Result<VoteInput, string> {
  const body = objectWith(input, ["contestId", "choice", "phone"]);
  if (!body.ok) return body;
  const { contestId, choice, phone } = body.value;

  if (typeof contestId !== "string") return err("contestId must be a string");
  const contestIdError = contestIdProblem(contestId);
  if (contestIdError) return err(contestIdError);

  if (typeof choice !== "string") return err("choice must be a string");
  const choiceError = choiceProblem(choice);
  if (choiceError) return err(choiceError);

  if (typeof phone !== "string") return err("phone must be a string");
  const normalised = parsePhone(phone);
  if (!normalised.ok) return normalised;

  return ok({ contestId, choice, phone: normalised.value });
}

// The second step: which contest, and the six digits from the SMS.
export function parseConfirm(input: unknown): Result<ConfirmInput, string> {
  const body = objectWith(input, ["contestId", "code"]);
  if (!body.ok) return body;
  const { contestId, code } = body.value;

  if (typeof contestId !== "string") return err("contestId must be a string");
  const contestIdError = contestIdProblem(contestId);
  if (contestIdError) return err(contestIdError);

  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return err("code must be 6 digits");
  return ok({ contestId, code });
}
