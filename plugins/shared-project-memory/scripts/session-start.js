"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");
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

const bash = process.platform === "win32" ? findGitBash() : "bash";
const args = process.platform === "win32" ? ["-l", script] : [script];
const result = spawnSync(bash, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
