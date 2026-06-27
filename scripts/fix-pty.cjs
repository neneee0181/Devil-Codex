// node-pty ships a `spawn-helper` binary on macOS/Linux that must be executable.
// npm extraction sometimes drops the +x bit, causing `posix_spawnp failed` at
// runtime (terminal never starts). Re-apply execute perms after install.
const { chmodSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

if (process.platform === "win32") process.exit(0);

const prebuilds = join(__dirname, "..", "node_modules", "node-pty", "prebuilds");
if (!existsSync(prebuilds)) process.exit(0);

for (const dir of readdirSync(prebuilds)) {
  const helper = join(prebuilds, dir, "spawn-helper");
  if (existsSync(helper)) {
    try {
      chmodSync(helper, 0o755);
      console.log(`[fix-pty] chmod +x ${helper}`);
    } catch (error) {
      console.warn(`[fix-pty] failed to chmod ${helper}: ${error.message}`);
    }
  }
}
