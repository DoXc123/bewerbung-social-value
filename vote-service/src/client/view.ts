// The page's logic that needs no browser: turning API data into what to show.
// Pure functions, so they are tested like the rest. app.ts does the DOM work.

export type TallyRow = { choice: string; votes: number };
export type ContestView = {
  id: string;
  title: string;
  status: "open" | "closed";
  options: string[];
  tally: TallyRow[];
  yourVote: string | null;
  smsDemo: boolean; // demo mode: no SMS is sent, so the page offers test numbers
};

// Every sentence the page shows besides the contest's own title and options.
// One place, so the wording is easy to change.
export const STRINGS = {
  loading: "Loading…",
  voted: "Your vote is counted.",
  yourVoteTag: "Your vote",
  alreadyVoted: "You have already voted.",
  closed: "Voting is closed.",
  tooMany: "Too many requests. Please try again in a minute.",
  notFound: "This contest does not exist.",
  badChoice: "That is not an option of this contest.",
  network: "Could not reach the server.",
  failed: "Something went wrong. Please try again.",
  // the SMS step
  badPhone: "Please enter a German or UK mobile number.",
  // 07700 900000–900999 is the UK range Ofcom keeps for fiction; it belongs to no one.
  demoPhone: "Demo: no SMS is sent, so use a test number, not your own: 07700 900001, 07700 900002 and so on belong to no one. Each number votes once.",
  badCode: "The code is the 6 digits from the SMS.",
  phoneUsed: "This phone number has already voted in this contest.",
  tooManyCodes: "Too many codes for this number. Please try again later.",
  smsFailed: "The SMS could not be sent. Please try again.",
  expired: "The code has expired. Please ask for a new one.",
  locked: "Too many wrong codes. Please ask for a new one.",
  noPending: "No vote is waiting for a code. Please choose again.",
};

// The colour switch. Anything stored that is not one of these means "auto".
export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export function parseTheme(value: unknown): Theme {
  return THEMES.find((t) => t === value) ?? "auto";
}

export const phoneLead = (choice: string) =>
  `You picked “${choice}”. To count it, confirm with a code sent to your phone by SMS.`;
export const codeLead = (sent: CodeSent) =>
  `We sent a 6-digit code to ${sent.sentTo}. It is valid for ${Math.round(sent.expiresInSeconds / 60)} minutes.`;
export const demoNote = (code: string) => `Demo: no SMS was sent. Your code is ${code}.`;
export const wrongCode = (left: number) =>
  `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left.`;

// The server's answer is data from outside, so check it like any other:
// unknown in, a proven ContestView (or null) out.
export function parseContest(input: unknown): ContestView | null {
  if (typeof input !== "object" || input === null) return null;
  const c = input as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.title !== "string") return null;
  if (c.status !== "open" && c.status !== "closed") return null;
  if (!Array.isArray(c.options) || !c.options.every((o) => typeof o === "string")) return null;
  if (!Array.isArray(c.tally)) return null;
  const tally: TallyRow[] = [];
  for (const row of c.tally) {
    if (typeof row !== "object" || row === null) return null;
    const { choice, votes } = row as Record<string, unknown>;
    if (typeof choice !== "string" || typeof votes !== "number") return null;
    tally.push({ choice, votes });
  }
  if (c.yourVote !== null && typeof c.yourVote !== "string") return null;
  if (c.smsDemo !== undefined && typeof c.smsDemo !== "boolean") return null;
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    options: c.options as string[],
    tally,
    yourVote: c.yourVote,
    smsDemo: c.smsDemo === true,
  };
}

// The answer to step 1 (202): where the code went, and in demo mode the code.
export type CodeSent = { sentTo: string; expiresInSeconds: number; demoCode: string | null };

export function parseCodeSent(input: unknown): CodeSent | null {
  if (typeof input !== "object" || input === null) return null;
  const b = input as Record<string, unknown>;
  if (b.status !== "code_sent" || typeof b.sentTo !== "string") return null;
  if (typeof b.expiresInSeconds !== "number" || b.expiresInSeconds <= 0) return null;
  const demoCode = b.demoCode === undefined ? null : b.demoCode;
  if (demoCode !== null && (typeof demoCode !== "string" || !/^\d{6}$/.test(demoCode))) return null;
  return { sentTo: b.sentTo, expiresInSeconds: b.expiresInSeconds, demoCode };
}

// What people type: "123 456" is fine, anything but six digits is not.
export function cleanCode(typed: string): string | null {
  const code = typed.replace(/\s/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

// What the page does after a refused step: stay where it is, go back to the
// phone number (the code is gone), or start over from the contest.
export type NextStep = "stay" | "phone" | "reload";

// A sentence and the next step for each way the two POSTs can be refused. The
// server's `reason` decides when there is one; the status code otherwise.
export function refusal(step: "start" | "confirm", status: number, body: unknown): { text: string; next: NextStep } {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  switch (b.reason) {
    case "wrong_code":
      return { text: typeof b.attemptsLeft === "number" ? wrongCode(b.attemptsLeft) : STRINGS.badCode, next: "stay" };
    case "too_many_codes":
      return { text: STRINGS.tooManyCodes, next: "stay" };
    case "expired":
      return { text: STRINGS.expired, next: "phone" };
    case "locked":
      return { text: STRINGS.locked, next: "phone" };
    case "no_pending":
      return { text: STRINGS.noPending, next: "reload" };
    case "phone_used":
      return { text: STRINGS.phoneUsed, next: "phone" };
    case "duplicate":
      return { text: STRINGS.alreadyVoted, next: "reload" };
    case "closed":
      return { text: STRINGS.closed, next: "reload" };
    case "unknown_contest":
      return { text: STRINGS.notFound, next: "reload" };
    case "unknown_option":
      return { text: STRINGS.badChoice, next: "reload" };
  }
  if (status === 400) return { text: step === "start" ? STRINGS.badPhone : STRINGS.badCode, next: "stay" };
  if (status === 429) return { text: STRINGS.tooMany, next: "stay" };
  if (status === 502) return { text: STRINGS.smsFailed, next: "stay" };
  return { text: STRINGS.failed, next: "stay" };
}

export function totalVotes(tally: TallyRow[]): number {
  return tally.reduce((sum, row) => sum + row.votes, 0);
}

// Bar width as a whole percent of all votes; 0 when nobody has voted yet.
export function barPercent(votes: number, total: number): number {
  return total === 0 ? 0 : Math.round((votes / total) * 100);
}

// What to offer: buttons only while the contest is open and this voter hasn't voted.
export function screenFor(c: ContestView): { canVote: boolean; notice: string | null } {
  if (c.yourVote !== null) return { canVote: false, notice: STRINGS.voted };
  if (c.status === "closed") return { canVote: false, notice: STRINGS.closed };
  return { canVote: true, notice: null };
}

// ---- the Features page ----

export type Limit = { max: number; windowMs: number };
export type Settings = {
  smsMode: "demo" | "log";
  code: { digits: number; validMinutes: number; maxAttempts: number };
  limits: { votesPerAddress: Limit; newVotersPerAddress: Limit; codesPerNumber: Limit };
  trustProxy: boolean;
};
export type ShownSnippet = { file: string; line: number; code: string };

const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isLimit = (x: unknown): x is Limit => isObject(x) && isCount(x.max) && isCount(x.windowMs);

// GET /settings, checked like any other answer from outside.
export function parseSettings(input: unknown): Settings | null {
  if (!isObject(input)) return null;
  const { smsMode, code, limits, trustProxy } = input;
  if (smsMode !== "demo" && smsMode !== "log") return null;
  if (!isObject(code) || !isCount(code.digits) || !isCount(code.validMinutes) || !isCount(code.maxAttempts)) {
    return null;
  }
  if (!isObject(limits)) return null;
  const { votesPerAddress, newVotersPerAddress, codesPerNumber } = limits;
  if (!isLimit(votesPerAddress) || !isLimit(newVotersPerAddress) || !isLimit(codesPerNumber)) return null;
  if (typeof trustProxy !== "boolean") return null;
  return {
    smsMode,
    code: { digits: code.digits, validMinutes: code.validMinutes, maxAttempts: code.maxAttempts },
    limits: { votesPerAddress, newVotersPerAddress, codesPerNumber },
    trustProxy,
  };
}

// /snippets.json: feature id → the regions cut from the source at build time.
export function parseSnippets(input: unknown): Record<string, ShownSnippet[]> | null {
  if (!isObject(input) || Array.isArray(input)) return null;
  const out: Record<string, ShownSnippet[]> = {};
  for (const [id, list] of Object.entries(input)) {
    if (!Array.isArray(list)) return null;
    out[id] = [];
    for (const s of list) {
      if (!isObject(s)) return null;
      const { file, line, code } = s;
      if (typeof file !== "string" || !isCount(line) || typeof code !== "string") return null;
      out[id].push({ file, line, code });
    }
  }
  return out;
}

// { max: 30, windowMs: 60_000 } → "30 per minute"; two hours → "20 per 2 hours".
export function perWindow({ max, windowMs }: Limit): string {
  const [size, unit] =
    windowMs % 3_600_000 === 0 ? [windowMs / 3_600_000, "hour"]
    : windowMs % 60_000 === 0 ? [windowMs / 60_000, "minute"]
    : [Math.round(windowMs / 1000), "second"];
  return `${max} per ${size === 1 ? unit : `${size} ${unit}s`}`;
}

// One section per marked feature (FEATURE_IDS in snippets.ts), in reading order.
// `setting` is what this running instance is set to, where there is a setting.
export const FEATURES: { id: string; title: string; text: string; setting?: (s: Settings) => string }[] = [
  {
    id: "identity",
    title: "Who you are",
    text: "The server gives each browser a random voter id in a cookie, signed with a key only the server knows. A changed or made-up cookie fails the check and is treated as a new visitor.",
  },
  {
    id: "cookie",
    title: "The cookie",
    text: "Scripts on the page cannot read it, other sites cannot send it along with a vote, and in production it only travels over HTTPS.",
  },
  {
    id: "one-vote",
    title: "One vote per person and per number",
    text: "The database itself refuses a second vote in a contest from the same voter id or the same phone number, so no bug in the code above it can let one through.",
  },
  {
    id: "phone-hash",
    title: "Phone numbers are not stored",
    text: "Only a keyed hash (HMAC-SHA256) of the number is kept. The same number always gives the same hash, which is all the rule above needs.",
  },
  {
    id: "code-rules",
    title: "The SMS code",
    text: "A vote counts only once the code sent to the number is typed back. The code comes from a secure random source and is stored only as a hash.",
    setting: (s) => `${s.code.digits} digits · valid ${s.code.validMinutes} minutes · ${s.code.maxAttempts} tries`,
  },
  {
    id: "phone-format",
    title: "Which numbers are accepted",
    text: "German mobiles (015x, 016x, 017x) and UK mobiles (07…). Landlines and other countries are refused before any code is sent.",
  },
  {
    id: "demo-guard",
    title: "SMS mode",
    text: "Both modes are mocks: no SMS leaves the server. Demo mode refuses to start in production, because it hands every code to whoever asks.",
    setting: (s) =>
      s.smsMode === "demo" ? "demo: the code is shown on the page and logged" : "log: the code is only written to the server log",
  },
  {
    id: "rate-limits",
    title: "Rate limits",
    text: "Counted in memory, per address and per number. Going over gets a 429 answer with a Retry-After header.",
    setting: (s) =>
      `votes: ${perWindow(s.limits.votesPerAddress)} per address · codes: ${perWindow(s.limits.codesPerNumber)} per number · ` +
      `new voters: ${perWindow(s.limits.newVotersPerAddress)} per address · address read from ` +
      (s.trustProxy ? "the proxy's X-Forwarded-For" : "the connection"),
  },
  {
    id: "csp",
    title: "What the browser may load",
    text: "These pages may load only their own scripts and styles and talk only to this server. Inline scripts and style attributes are blocked.",
  },
];
