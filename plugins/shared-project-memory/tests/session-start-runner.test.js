"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shared-memory-hook-"));

try {
  const memory = path.join(temp, ".project-memory");
  fs.mkdirSync(memory);
  fs.writeFileSync(
    path.join(memory, "status.sh"),
    "#!/usr/bin/env bash\nprintf 'MEMORY_HOOK_OK\\n'\n",
    "utf8",
  );

  const result = spawnSync(process.execPath, [path.join(root, "scripts", "session-start.js")], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MEMORY_HOOK_OK/);
  console.log("session-start runner OK");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
