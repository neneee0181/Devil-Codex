import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexSettings } from "./contracts.cjs";

const defaultConfigPath = join(homedir(), ".codex", "config.toml");
const defaults: CodexSettings = { model: "gpt-5.4", approvalPolicy: "on-request", sandboxMode: "workspace-write", devilMcpEnabled: false, englishOutput: false };
const keys = { model: "model", approvalPolicy: "approval_policy", sandboxMode: "sandbox_mode", devilMcpEnabled: "devil_mcp_enabled", englishOutput: "english_output" } as const;

function readValue(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m"));
  return match?.[1];
}

function readBoolean(source: string, key: string): boolean | undefined {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, "m"));
  return match ? match[1] === "true" : undefined;
}

function formatValue(value: string | boolean): string {
  return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

// Strip a root key line wherever it currently sits in the file (it may have
// leaked under a trailing [table], which would make TOML parse it as a member
// of that table — fatal for boolean values under a string-only env table).
function stripKeyLine(source: string, key: string): string {
  return source.replace(new RegExp(`^[ \\t]*${key}[ \\t]*=.*(?:\\r?\\n)?`, "m"), "");
}

export class CodexSettingsStore {
  constructor(private readonly configPath = defaultConfigPath) {}

  async load(): Promise<CodexSettings> {
    try {
      const source = await readFile(this.configPath, "utf8");
      return {
        model: readValue(source, keys.model) ?? defaults.model,
        approvalPolicy: readValue(source, keys.approvalPolicy) ?? defaults.approvalPolicy,
        sandboxMode: readValue(source, keys.sandboxMode) ?? defaults.sandboxMode,
        devilMcpEnabled: readBoolean(source, keys.devilMcpEnabled) ?? defaults.devilMcpEnabled,
        englishOutput: readBoolean(source, keys.englishOutput) ?? defaults.englishOutput,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
      throw error;
    }
  }

  async save(next: CodexSettings): Promise<CodexSettings> {
    let source = "";
    try { source = await readFile(this.configPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Remove the managed keys from anywhere, then re-emit them as a block at the
    // very top. TOML root keys must precede the first [table]; appending at the
    // end would slot them under a managed MCP table and break config parsing.
    for (const key of Object.values(keys)) source = stripKeyLine(source, key);
    const block = (Object.entries(keys) as Array<[keyof CodexSettings, string]>)
      .map(([field, key]) => `${key} = ${formatValue(next[field])}`)
      .join("\n");
    source = `${block}\n${source.replace(/^[\r\n]+/, "")}`;
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, source, { encoding: "utf8", mode: 0o600 });
    return next;
  }
}
