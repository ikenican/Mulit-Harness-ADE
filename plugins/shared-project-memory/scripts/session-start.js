"use strict";

const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { spawnSync } = require("node:child_process");

const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "session-start.sh");

function findGitBash() {
  if (process.env.GIT_BASH && existsSync(process.env.GIT_BASH)) {
    return process.env.GIT_BASH;
  }

  const found = spawnSync("where.exe", ["git.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (found.status === 0) {
    for (const git of found.stdout.split(/\r?\n/).filter(Boolean)) {
      const gitRoot = path.dirname(path.dirname(git.trim()));
      for (const relative of ["bin/bash.exe", "usr/bin/bash.exe"]) {
        const candidate = path.join(gitRoot, relative);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  throw new Error("Git Bash was not found. Install Git for Windows or set GIT_BASH.");
}

const run = (cwd, stdio) => {
  const bash = process.platform === "win32" ? findGitBash() : "bash";
  const args = process.platform === "win32" ? ["-l", script] : [script];
  return spawnSync(bash, args, { cwd, env: process.env, stdio, encoding: "utf8", windowsHide: true });
};

// Antigravity: hooks run in the plugin folder with the session as JSON on stdin, and must answer
// with JSON on stdout. Never fail the session: anything wrong -> inject nothing.
if (process.argv.includes("--antigravity")) {
  let text = "";
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    let ws = (input.workspacePaths || [])[0] || "";
    if (ws.startsWith("file:")) ws = fileURLToPath(ws);
    if (ws) text = (run(ws, ["ignore", "pipe", "ignore"]).stdout || "").trim();
  } catch {
    text = "";
  }
  process.stdout.write(JSON.stringify(text ? { injectSteps: [{ systemMessage: { systemMessage: text } }] } : {}));
  process.exit(0);
}

const result = run(process.cwd(), "inherit");
if (result.error) throw result.error;
process.exit(result.status ?? 1);
