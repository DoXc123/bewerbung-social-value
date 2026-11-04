// How model-written pptxgenjs scripts are run (render_deck, and the fallback openai
// engine). The script is untrusted: in research mode the agent has read web pages
// before writing it, and a page can carry instructions. So it runs:
//
// - always with a minimal environment (PATH + NODE_PATH): no bot token, no API keys;
// - when bwrap works on this host, inside a bubblewrap sandbox: the whole filesystem
//   read-only, every home directory (and /tmp, /opt, /srv, /mnt, /media, /run, /var)
//   replaced by an empty tmpfs, then only the app's node_modules (read-only) and
//   `outDir` (read-write) bound back in; no network, own pid namespace. Callers pass
//   the session's own render dir (out/<session>/) as outDir, so the script can write
//   its .pptx and nothing else, can't see other sessions, and can't read .env files,
//   ~/.claude credentials or ssh keys.
//
// Mode (RENDER_SANDBOX / VPPTX_RENDER_SANDBOX): "auto" (default) uses bwrap when the
// probe passes and otherwise falls back to the minimal env with a warning; "bwrap"
// refuses to run without the sandbox.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const HIDDEN_DIRS = ["/home", "/root", "/tmp", "/opt", "/srv", "/mnt", "/media", "/run", "/var"];

export function minimalEnv(appRoot, base = process.env) {
  return {
    PATH: base.PATH || "/usr/local/bin:/usr/bin:/bin",
    NODE_PATH: path.join(appRoot, "node_modules"),
  };
}

// bwrap argv that runs `execPath jsPath outPath` with only node_modules + outDir
// visible. Every bind comes after the tmpfs mounts, or a tmpfs would cover it.
export function bwrapArgs({ appRoot, outDir, jsPath, outPath, execPath = process.execPath, env, exists = fs.existsSync, realpath = fs.realpathSync }) {
  const args = ["--ro-bind", "/", "/"];
  for (const d of HIDDEN_DIRS) if (exists(d)) args.push("--tmpfs", d);
  args.push("--dev", "/dev", "--proc", "/proc");

  const nm = path.join(appRoot, "node_modules");
  const binds = new Set([nm]);
  // Node resolves a module's own requires from its real path, so a symlinked
  // node_modules must be visible there too.
  try { binds.add(realpath(nm)); } catch { /* missing node_modules: render will fail loudly */ }
  // A node installed under a hidden dir (nvm in ~) must stay reachable.
  const nodeDir = path.dirname(execPath);
  if (HIDDEN_DIRS.some((d) => nodeDir === d || nodeDir.startsWith(d + "/"))) binds.add(nodeDir);
  for (const b of binds) args.push("--ro-bind", b, b);
  args.push("--bind", outDir, outDir);

  args.push("--unshare-all", "--die-with-parent", "--new-session", "--clearenv");
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  args.push("--chdir", outDir, execPath, jsPath, outPath);
  return args;
}

let probed = null;
// Can bwrap build a sandbox here? Unprivileged user namespaces can be blocked by the
// kernel or AppArmor (Ubuntu 24.04+), so try once and cache the answer.
export function bwrapWorks() {
  if (probed === null) {
    try {
      const r = spawnSync(
        "bwrap",
        ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-all", "--die-with-parent", "/bin/true"],
        { stdio: "ignore", timeout: 10000 }
      );
      probed = r.status === 0;
    } catch {
      probed = false;
    }
  }
  return probed;
}

// Returns { command, args, options } for spawn, or { error } when mode "bwrap" is
// required and unavailable.
export function renderSpawn({ appRoot, outDir, jsPath, outPath, mode = "auto", execPath = process.execPath, sandboxAvailable = bwrapWorks }) {
  const env = minimalEnv(appRoot);
  if (sandboxAvailable()) {
    return {
      command: "bwrap",
      args: bwrapArgs({ appRoot, outDir, jsPath, outPath, execPath, env }),
      options: { cwd: outDir, env, stdio: ["ignore", "pipe", "pipe"] },
      sandboxed: true,
    };
  }
  if (mode === "bwrap") {
    return { error: "RENDER_SANDBOX=bwrap but bwrap cannot create a sandbox on this host; refusing to run the script." };
  }
  return {
    command: execPath,
    args: [jsPath, outPath],
    // cwd = appRoot so require("pptxgenjs") resolves, as before the sandbox.
    options: { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    sandboxed: false,
  };
}

// Run the script; resolves { code, stdout, stderr, sandboxed } and never rejects.
export function runRender(opts) {
  const plan = renderSpawn(opts);
  if (plan.error) return Promise.resolve({ code: -1, stdout: "", stderr: plan.error, sandboxed: false });
  if (!plan.sandboxed) {
    console.error("voicepptx: render sandbox unavailable — running the deck script with a scrubbed env only");
  }
  return new Promise((resolve) => {
    const proc = spawn(plan.command, plan.args, plan.options);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e), sandboxed: plan.sandboxed }));
    proc.on("close", (code) => resolve({ code, stdout, stderr, sandboxed: plan.sandboxed }));
  });
}
