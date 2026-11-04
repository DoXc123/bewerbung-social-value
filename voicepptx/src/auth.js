// Access control. The bot fails CLOSED: with no allowlist it refuses to start,
// rather than serving anyone who finds it (audit 0.3, runbook T3). Pure functions,
// no config import, so tests can load this without a .env.

export function parseAllowedUserIds(raw) {
  const parts = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(
      "ALLOWED_USER_IDS is empty. The bot refuses to start without an allowlist; " +
        "set it to the comma-separated Telegram user IDs that may use it."
    );
  }
  return parts.map((p) => {
    if (!/^\d+$/.test(p)) throw new Error(`ALLOWED_USER_IDS has a non-numeric entry: "${p}"`);
    return Number(p);
  });
}

export function isAuthorized(allowedUserIds, userId) {
  return Array.isArray(allowedUserIds) && allowedUserIds.length > 0 && allowedUserIds.includes(userId);
}
