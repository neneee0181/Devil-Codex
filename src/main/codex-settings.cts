import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodexSettings } from "./contracts.cjs";
import { codexHome } from "./codex-home.cjs";
import { preserveDesktopAppearanceTheme, recoverDesktopAppearanceTheme } from "./codex-desktop-theme.cjs";

const defaultConfigPath = join(codexHome(), "config.toml");
const defaults: CodexSettings = {
  model: "gpt-5.4",
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
  reasoningEffort: "medium",
  responseSpeed: "standard",
  devilMcpEnabled: false,
  askUserMcpEnabled: true,
  subagentMcpEnabled: true,
  englishOutput: false,
};
const keys = { model: "model", approvalPolicy: "approval_policy", sandboxMode: "sandbox_mode", reasoningEffort: "model_reasoning_effort", responseSpeed: "service_tier", devilMcpEnabled: "devil_mcp_enabled", askUserMcpEnabled: "ask_user_mcp_enabled", subagentMcpEnabled: "subagent_mcp_enabled", englishOutput: "english_output" } as const;
// NOTE: `model_reasoning_effort` and `service_tier` are shared with stock
// Codex, which writes them from its own model picker. Devil now reads them in
// load() and writes them in save() so the two apps stay in sync — the renderer
// has always called save() on effort/speed changes expecting exactly that.
// (An earlier "legacy cleanup" deleted service_tier on every load(), which
// kept resetting the stock app's speed setting; the rule is read/rewrite the
// keys faithfully, never strip them outside save().)
// service_tier mapping: fast ↔ "priority", standard ↔ "default". A custom
// non-priority tier set by stock (e.g. "flex") is preserved on save while the
// speed stays "standard", so Devil never clobbers a tier it doesn't model.
const reasoningEffortValues = new Set<CodexSettings["reasoningEffort"]>(["low", "medium", "high", "xhigh"]);

function readReasoningEffort(source: string): CodexSettings["reasoningEffort"] | undefined {
  const value = readValue(source, keys.reasoningEffort) as CodexSettings["reasoningEffort"] | undefined;
  return value && reasoningEffortValues.has(value) ? value : undefined;
}

function serviceTierValue(responseSpeed: CodexSettings["responseSpeed"], previousTier: string | undefined): string {
  if (responseSpeed === "fast") return "priority";
  return previousTier && previousTier !== "priority" ? previousTier : "default";
}

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
  return source.replace(new RegExp(`^[ \\t]*${key}[ \\t]*=.*(?:\\r?\\n)?`, "gm"), "");
}

// Write via temp file + rename so concurrent readers (stock Codex desktop, the
// bundled app-server) never observe a truncated half-written config. A partial
// read makes those apps re-serialize their broken parse and permanently drop
// the user's model/theme/speed settings.
export async function writeCodexConfigAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.devil-tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
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
        reasoningEffort: readReasoningEffort(source) ?? defaults.reasoningEffort,
        responseSpeed: readValue(source, keys.responseSpeed) === "priority" ? "fast" : defaults.responseSpeed,
        devilMcpEnabled: readBoolean(source, keys.devilMcpEnabled) ?? defaults.devilMcpEnabled,
        askUserMcpEnabled: readBoolean(source, keys.askUserMcpEnabled) ?? defaults.askUserMcpEnabled,
        subagentMcpEnabled: readBoolean(source, keys.subagentMcpEnabled) ?? defaults.subagentMcpEnabled,
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
    const previous = source;
    source = await recoverDesktopAppearanceTheme(source, codexHome());
    // Remove the managed keys from anywhere, then re-emit them as a block at the
    // very top. TOML root keys must precede the first [table]; appending at the
    // end would slot them under a managed MCP table and break config parsing.
    const previousTier = readValue(source, keys.responseSpeed);
    for (const key of Object.values(keys)) source = stripKeyLine(source, key);
    const block = (Object.entries(keys) as Array<[keyof CodexSettings, string]>)
      .map(([field, key]) => {
        const value = field === "responseSpeed" ? serviceTierValue(next.responseSpeed, previousTier) : next[field];
        return `${key} = ${formatValue(value)}`;
      })
      .join("\n");
    source = `${block}\n${source.replace(/^[\r\n]+/, "")}`;
    source = preserveDesktopAppearanceTheme(source, previous);
    if (source !== previous) await writeCodexConfigAtomic(this.configPath, source);
    return next;
  }
}
