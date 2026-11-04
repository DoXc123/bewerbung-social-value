import { err, ok, type Result } from "./result.js";

export type Config = {
  secret: string;
  port: number;
  host: string;
  dbPath: string;
  trustProxy: boolean;
  secureCookies: boolean;
  // Both modes are mocks: no SMS is sent. "demo" also shows the code on the
  // page; "log" writes it only to the server log.
  smsMode: "demo" | "log";
};

// Settings come from environment variables, so the secret never lives in the
// code or the repo. Takes the environment as an argument so tests can pass one.
export function loadConfig(env: Record<string, string | undefined>): Result<Config, string> {
  const secret = env.VOTE_SECRET ?? "";
  if (secret.length < 32) {
    return err("VOTE_SECRET must be set to a random string of at least 32 characters");
  }

  // Digits only: Number("") and Number("  ") are 0, which would quietly mean "any port".
  const rawPort = env.PORT ?? "3000";
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    return err("PORT must be a whole number from 0 to 65535");
  }

  // feature:demo-guard
  const smsMode = env.SMS_MODE ?? "demo";
  if (smsMode !== "demo" && smsMode !== "log") return err('SMS_MODE must be "demo" or "log"');
  // Demo mode hands the code to whoever asks, which defeats the SMS step.
  if (smsMode === "demo" && env.NODE_ENV === "production") {
    return err('SMS_MODE=demo shows every code on the page; set SMS_MODE=log in production');
  }
  // end feature

  return ok({
    secret,
    port,
    // Loopback by default: reachable only from this machine (or via the proxy
    // on it). Listening on every interface has to be asked for on purpose.
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? "votes.sqlite",
    trustProxy: env.TRUST_PROXY === "1",
    // Secure cookies need HTTPS, so they are on in production only.
    secureCookies: env.NODE_ENV === "production",
    smsMode,
  });
}
