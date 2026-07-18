import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodexSettings, RemoteControlMode } from "./contracts.cjs";
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
  stockBridgeEnabled: true,
  stockBridgeModels: [],
  stockBridgeWebSearch: false,
  stockBridgeVision: false,
  remoteControlEnabled: false,
  remoteControlMode: "funnel",
  remoteAllowedThreadIds: [],
};
const keys = { model: "model", approvalPolicy: "approval_policy", sandboxMode: "sandbox_mode", reasoningEffort: "model_reasoning_effort", responseSpeed: "service_tier", devilMcpEnabled: "devil_mcp_enabled", askUserMcpEnabled: "ask_user_mcp_enabled", subagentMcpEnabled: "subagent_mcp_enabled", englishOutput: "english_output", stockBridgeEnabled: "devil_stock_bridge_enabled", stockBridgeModels: "devil_stock_bridge_models", stockBridgeWebSearch: "devil_stock_bridge_web_search", stockBridgeVision: "devil_stock_bridge_vision", remoteControlEnabled: "remote_control_enabled", remoteControlMode: "remote_control_mode", remoteAllowedThreadIds: "remote_allowed_thread_ids" } as const;
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
const remoteControlModeValues = new Set<RemoteControlMode>(["funnel"]);

function readReasoningEffort(source: string): CodexSettings["reasoningEffort"] | undefined {
  const value = readValue(source, keys.reasoningEffort) as CodexSettings["reasoningEffort"] | undefined;
  return value && reasoningEffortValues.has(value) ? value : undefined;
}

function readRemoteControlMode(source: string): RemoteControlMode | undefined {
  const value = readValue(source, keys.remoteControlMode) as RemoteControlMode | undefined;
  return value && remoteControlModeValues.has(value) ? value : undefined;
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

function formatValue(value: string | boolean | string[]): string {
  if (typeof value === "boolean") return String(value);
  // Arrays serialize as a plain JSON/TOML array literal (e.g. ["a","b"]) -
  // valid TOML syntax, so stock Codex's own parser just ignores this
  // Devil-only key instead of choking on it.
  return JSON.stringify(value);
}

function readArray(source: string, key: string): string[] | undefined {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\[[^\\]]*\\])`, "m"));
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStockBridgeModelId(value: string): string {
  // Migrate the pre-0.3.16 provider[:account]:model spelling to the
  // slash-namespaced slug expected by Codex Desktop's model catalog.
  const separator = value.indexOf(":");
  const slash = value.indexOf("/");
  if (separator <= 0 || (slash >= 0 && slash < separator)) return value;
  return `${value.slice(0, separator)}/${value.slice(separator + 1)}`;
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

  // The settings picker can issue several IPC saves before the previous one
  // finishes. Serialize read-modify-write cycles so an older snapshot cannot
  // overwrite a newer multi-model Bridge selection.
  private writeChain: Promise<unknown> = Promise.resolve();

  private withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

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
        stockBridgeEnabled: readBoolean(source, keys.stockBridgeEnabled) ?? defaults.stockBridgeEnabled,
        stockBridgeModels: (readArray(source, keys.stockBridgeModels) ?? defaults.stockBridgeModels).map(normalizeStockBridgeModelId),
        stockBridgeWebSearch: readBoolean(source, keys.stockBridgeWebSearch) ?? defaults.stockBridgeWebSearch,
        stockBridgeVision: readBoolean(source, keys.stockBridgeVision) ?? defaults.stockBridgeVision,
        remoteControlEnabled: readBoolean(source, keys.remoteControlEnabled) ?? defaults.remoteControlEnabled,
        remoteControlMode: readRemoteControlMode(source) ?? defaults.remoteControlMode,
        remoteAllowedThreadIds: readArray(source, keys.remoteAllowedThreadIds) ?? defaults.remoteAllowedThreadIds,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
      throw error;
    }
  }

  async save(next: CodexSettings): Promise<CodexSettings> {
    return this.withWriteLock(() => this.saveUnlocked(next));
  }

  private async saveUnlocked(next: CodexSettings): Promise<CodexSettings> {
    let source = "";
    try { source = await readFile(this.configPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const previous = source;
    source = await recoverDesktopAppearanceTheme(source, codexHome());
    // Remove the managed keys from anywhere, then re-emit them as a block at the
    // very top. TOML root keys must precede the first [table]; appending at the
    // end would slot them under a managed MCP table and break config parsing.
    const previousTier = readValue(source, keys.responseSpeed);
    for (const key of Object.values(keys)) source = stripKeyLine(source, key);
    const normalizedNext = { ...next, stockBridgeModels: next.stockBridgeModels.map(normalizeStockBridgeModelId) };
    const block = (Object.entries(keys) as Array<[keyof CodexSettings, string]>)
      .map(([field, key]) => {
        const value = field === "responseSpeed" ? serviceTierValue(normalizedNext.responseSpeed, previousTier) : normalizedNext[field];
        return `${key} = ${formatValue(value)}`;
      })
      .join("\n");
    source = `${block}\n${source.replace(/^[\r\n]+/, "")}`;
    source = preserveDesktopAppearanceTheme(source, previous);
    if (source !== previous) await writeCodexConfigAtomic(this.configPath, source);
    return normalizedNext;
  }
}
