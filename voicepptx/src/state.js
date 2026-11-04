import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

function pathFor(userId) {
  return path.join(config.stateDir, `${userId}.json`);
}

function newSession() {
  return {
    history: [],
    brief: null,
    phase: "gathering",
    // Post-delivery refine loop (phase "refining"): the dialogue since delivery, and a
    // pointer to the last successful generation so an edit can chain off its script.
    refineHistory: [],
    lastGen: null, // { sessionId, cjsPath, outPath }
    createdAt: new Date().toISOString(),
  };
}

export async function load(userId) {
  try {
    const raw = await fs.readFile(pathFor(userId), "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return newSession();
    throw e;
  }
}

// Write to a temp file in the same dir, then rename over the target: a crash or
// restart mid-write leaves the old session, never a truncated JSON file.
export async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function save(userId, session) {
  await writeJsonAtomic(pathFor(userId), session);
}

// At startup no generation can be running, so a session still in "generating" was
// cut off by a restart and would answer "still working" forever. Put it back where
// a failed build would have left it. Returns the number of sessions reset.
export async function recoverStuck(dir = config.stateDir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let session;
    try {
      session = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (session?.phase !== "generating") continue;
    session.phase = session.lastGen ? "refining" : "ready";
    try {
      await writeJsonAtomic(file, session);
      n++;
    } catch (e) {
      // One unwritable file must not keep the bot from starting.
      console.error(`voicepptx: could not reset stuck session ${name}: ${e.message}`);
    }
  }
  return n;
}

export async function reset(userId) {
  const session = newSession();
  await save(userId, session);
  return session;
}
