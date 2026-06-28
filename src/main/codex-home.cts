import { homedir } from "node:os";
import { join } from "node:path";

// Single source of truth for the Codex home directory. The codex app-server
// child inherits process.env and honors CODEX_HOME, so every Devil helper that
// reads/writes Codex state (config.toml, state_5.sqlite, rollouts, session
// index, reconcile journal) MUST resolve the same path — otherwise Devil writes
// to one home while stock Codex reads another and the two desync. DEVIL_CODEX_
// CODEX_HOME is a dev-only override; CODEX_HOME is the standard Codex variable.
export function codexHome(): string {
  return process.env.DEVIL_CODEX_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}
