export type RuntimeState = "ready" | "connecting" | "connected" | "unavailable" | "error";

export interface RuntimeStatus {
  state: RuntimeState;
  detail: string;
  cwd: string;
  codexVersion?: string;
}

export interface ThreadRef {
  id: string;
  cwd: string;
  model: string;
}

export interface ThreadSummary {
  id: string;
  cwd: string;
  model: string;
  provider?: ProviderId;
  title: string;
  preview: string;
  updatedAt: number;
  archived: boolean;
}

export interface ThreadActivityEntry {
  id: string;
  kind: "message" | "reasoning" | "command" | "fileChange" | "mcp" | "webSearch" | "compaction" | "diagnostic" | "subagent";
  title: string;
  detail?: string;
  output?: string;
  status?: "inProgress" | "completed" | "failed" | "declined";
  files?: Array<{ path: string; additions: number; deletions: number; diff?: string }>;
  // Image data URLs surfaced by a tool result (e.g. computer_screenshot,
  // image generation) so the work timeline can render them inline.
  images?: string[];
  // Subagent activity (kind === "subagent"): a delegated "sub agent" the model
  // spawned during the turn. agentThreadId points to the spawned thread.
  subagent?: {
    agentThreadId: string;
    agentPath?: string;
    source?: "review" | "compact" | "thread_spawn" | "memory_consolidation" | "other";
    role?: string;
    nickname?: string;
    depth?: number;
  };
}

export interface ThreadHistoryItem {
  id: string;
  kind: "user" | "agent" | "activity" | "tool" | "system";
  text: string;
  attachments?: ThreadAttachment[];
  title?: string;
  turnId?: string;
  status?: "inProgress" | "completed" | "interrupted" | "failed";
  durationMs?: number;
  startedAt?: number;
  activities?: ThreadActivityEntry[];
  contextUsage?: ContextUsage;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
}

export interface ThreadAttachment {
  name: string;
  kind: "image" | "file";
  path?: string;
  url?: string;
  mime?: string;
  size?: number;
  content?: string;
}

export interface WorkspaceChange {
  path: string;
  status: string;
  staged?: boolean;
  additions: number;
  deletions: number;
}

export interface WorkspaceDiff {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  text: string;
  binary: boolean;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  detached: boolean;
  locked: boolean;
}

export interface CodexSkillInfo { name: string; description: string; path: string; scope: string; enabled: boolean; }
export interface McpToolInfo { name: string; title: string; description: string; }
export interface McpServerInfo { name: string; authStatus: string; tools: McpToolInfo[]; resources: number; }

export interface WorkspaceEntry { name: string; path: string; kind: "file" | "folder"; }
export interface WorkspaceFile { path: string; kind: "text" | "image" | "binary"; content: string; }

export interface TerminalSession { id: string; cwd: string; shell: string; fallback: boolean; }
export interface TerminalData { id: string; data: string; }
export interface CodexSettings { model: string; approvalPolicy: string; sandboxMode: string; devilMcpEnabled: boolean; englishOutput: boolean; }
export type ProviderId =
  | "codex" | "claude-code" | "copilot"
  | "openai" | "anthropic" | "google" | "deepseek"
  | "xai" | "openrouter" | "openrouter-free" | "groq" | "mistral" | "cerebras" | "together" | "fireworks"
  | "moonshot" | "huggingface" | "nvidia" | "ollama" | "vllm" | "lm-studio";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ResponseSpeed = "standard" | "fast";
export interface ProviderModelCapability {
  tools: "native" | "limited" | "none" | "unknown";
  images: "native" | "sidecar" | "none" | "unknown";
  webSearch: "native" | "sidecar" | "none" | "unknown";
  diagnostics: "good" | "limited" | "experimental" | "unknown";
  notes?: string[];
}
export interface ProviderModel { id: string; label: string; capability?: ProviderModelCapability; }
export interface ProviderInfo { id: ProviderId; label: string; kind: "login" | "apikey"; keyRequired: boolean; models: ProviderModel[]; modelsLoaded: boolean; credentialSource: "desktop" | "environment" | "keychain" | "none"; authProvider?: "codex" | "claude" | "copilot"; }
export interface ProviderSettings { provider: ProviderId; model: string; providers: ProviderInfo[]; }
export interface SidecarSettings { webSearch: boolean; vision: boolean; webSearchLimit: number; visionLimit: number; }
export interface ProviderAuthStatus { codex: boolean; claude: boolean; copilot: boolean; }
export interface DeviceCodeInfo { userCode: string; verificationUri: string; expiresIn: number; }
export interface ProviderUsageWindow { label: string; usedPercent: number; remainingPercent: number; resetsAt?: string | number | null; }
export interface ProviderUsageEntry { provider: "codex" | "claude-code" | "copilot"; label: string; connected: boolean; windows: ProviderUsageWindow[]; unavailable?: string; error?: string; updatedAt: number; }
export interface ProviderUsageReport { entries: ProviderUsageEntry[]; }
export interface ProviderTokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningOutputTokens?: number; }
export interface ProviderRequestLogEntry {
  id: string;
  provider: ProviderId | "unknown";
  model: string;
  threadId?: string;
  route: string;
  status: "started" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  errorType?: string;
  tools?: number;
  images?: number;
  files?: number;
  usage?: ProviderTokenUsage;
  capability?: ProviderModelCapability;
  sidecar?: {
    webSearchRequests: number;
    webSearchToolCalls?: number;
    webSearchLoops?: number;
    visionRequests: number;
    failures: string[];
  };
}
export type ThreadApprovalPolicy = "on-request" | "never";
export type ThreadSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface WorkspaceChanges {
  available: boolean;
  files: WorkspaceChange[];
  branch: string;
  additions: number;
  deletions: number;
  detail?: string;
}

export interface AppServerEvent {
  method: string;
  params: unknown;
  requestId?: string | number;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export interface ApprovalPrompt {
  requestId: string | number;
  kind: "command" | "fileChange";
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string;
  cwd?: string;
  reason?: string;
  grantRoot?: string;
  availableDecisions: ApprovalDecision[];
}

export type AppCommand = "new-thread" | "search" | "settings" | "open-project" | "terminal" | "environment";
export type ExternalTarget = "vscode" | "visualstudio" | "antigravity" | "github-desktop" | "finder" | "terminal" | "git-bash" | "intellij" | "rider";
export interface OpenWorkspaceTarget { id: ExternalTarget; label: string; available: boolean; }

export type UpdateState =
  | { status: "available"; version: string }
  | { status: "none" }
  | { status: "downloading"; percent: number }
  | { status: "error"; message: string };

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
}

export type WindowControlAction = "close" | "minimize" | "maximize";

export interface BrowserState { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; }

export interface AskQuestionOption { label: string; description?: string }
export interface AskQuestion { question: string; header?: string; options: AskQuestionOption[]; multiSelect?: boolean }
export interface AskRequest { id: string; questions: AskQuestion[] }
export interface AskAnswer { question: string; header?: string; answers: string[] }

export interface DevilCodexApi {
  appInfo: () => Promise<AppInfo>;
  windowControl: (input: { action: WindowControlAction }) => Promise<void>;
  openPermission: (input: { kind: "accessibility" | "screen-recording" | "automation" | "browser-extension" }) => Promise<void>;
  browserNavigate: (input: { url: string }) => Promise<void>;
  browserBack: () => Promise<void>;
  browserForward: () => Promise<void>;
  browserReload: () => Promise<void>;
  browserStop: () => Promise<void>;
  browserHardReload: () => Promise<void>;
  browserState: () => Promise<BrowserState>;
  browserScreenshot: () => Promise<string>;
  browserFind: (input: { text: string; forward?: boolean; findNext?: boolean }) => Promise<void>;
  browserStopFind: () => Promise<void>;
  browserZoom: (input: { factor?: number; delta?: number; reset?: boolean }) => Promise<number>;
  browserClearCookies: () => Promise<void>;
  browserClearCache: () => Promise<void>;
  browserCaptureRect: (input: { x: number; y: number; width: number; height: number }) => Promise<string>;
  browserAiClick: (input: { x?: number; y?: number; selector?: string }) => Promise<boolean>;
  browserAiType: (input: { text: string }) => Promise<void>;
  browserUploadFiles: (input: { paths: string[] }) => Promise<{ ok: boolean; count: number; detail?: string }>;
  browserAiKey: (input: { key: string }) => Promise<void>;
  browserAiScroll: (input: { dy: number }) => Promise<void>;
  browserAiRead: () => Promise<string>;
  onBrowserState: (listener: (state: BrowserState) => void) => () => void;
  onBrowserActivate: (listener: () => void) => () => void;
  onAsk: (listener: (request: AskRequest) => void) => () => void;
  askRespond: (input: { id: string; answers: AskAnswer[] | null }) => Promise<void>;
  runtime: () => Promise<RuntimeStatus>;
  connect: () => Promise<RuntimeStatus>;
  chooseWorkspace: () => Promise<string | null>;
  createProjectFolder: (input?: { name?: string }) => Promise<string>;
  createThread: (input: { cwd: string; model: string; provider?: ProviderId; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode; reasoningEffort?: ReasoningEffort; responseSpeed?: ResponseSpeed }) => Promise<ThreadRef>;
  listThreads: (input: { cwd: string; archived?: boolean }) => Promise<ThreadSummary[]>;
  searchThreads: (input: { query: string; archived?: boolean }) => Promise<ThreadSummary[]>;
  resumeThread: (input: { id: string; model: string }) => Promise<ThreadRef>;
  renameThread: (input: { id: string; name: string; cwd?: string; model?: string; preview?: string }) => Promise<void>;
  forkThread: (input: { id: string; cwd: string; model: string }) => Promise<ThreadRef>;
  readThread: (input: { id: string }) => Promise<ThreadHistoryItem[]>;
  cacheThreadHistory: (input: { id: string; items: ThreadHistoryItem[] }) => Promise<void>;
  syncThreadHistory: (input: { id: string }) => Promise<ThreadHistoryItem[]>;
  listProjects: (input?: { archived?: boolean }) => Promise<ThreadSummary[]>;
  archiveThread: (input: { id: string }) => Promise<void>;
  unarchiveThread: (input: { id: string }) => Promise<void>;
  deleteThread: (input: { id: string }) => Promise<void>;
  undoFileChanges: (input: { cwd: string; changes: Array<{ path: string; diff: string; additions: number; deletions: number }> }) => Promise<void>;
  stageWorkspaceFiles: (input: { cwd: string; paths: string[] }) => Promise<void>;
  unstageWorkspaceFiles: (input: { cwd: string; paths: string[] }) => Promise<void>;
  applyWorkspaceHunk: (input: { cwd: string; path: string; hunk: string; action: "stage" | "revert" }) => Promise<void>;
  listGitBranches: (input: { cwd: string }) => Promise<GitBranchInfo[]>;
  switchGitBranch: (input: { cwd: string; branch: string; create?: boolean }) => Promise<void>;
  listGitWorktrees: (input: { cwd: string }) => Promise<GitWorktreeInfo[]>;
  createGitWorktree: (input: { cwd: string; branch: string }) => Promise<GitWorktreeInfo>;
  listSkills: (input: { cwd: string; forceReload?: boolean }) => Promise<CodexSkillInfo[]>;
  listMcpServers: (input?: { threadId?: string }) => Promise<McpServerInfo[]>;
  callMcpTool: (input: { threadId: string; server: string; tool: string; arguments?: unknown }) => Promise<unknown>;
  uploadFeedback: (input: { reason: string; threadId?: string }) => Promise<void>;
  commitWorkspace: (input: { cwd: string; message: string; paths: string[] }) => Promise<string>;
  pushWorkspace: (input: { cwd: string }) => Promise<string>;
  createPullRequest: (input: { cwd: string; draft: boolean }) => Promise<string>;
  getWorkspaceChanges: (input: { cwd: string }) => Promise<WorkspaceChanges>;
  getWorkspaceDiff: (input: { cwd: string; path: string }) => Promise<WorkspaceDiff>;
  listWorkspaceDirectory: (input: { cwd: string; path?: string }) => Promise<WorkspaceEntry[]>;
  readWorkspaceFile: (input: { cwd: string; path: string }) => Promise<WorkspaceFile>;
  findWorkspaceFile: (input: { cwd: string; query: string }) => Promise<string | null>;
  previewLocalImage: (input: { path: string }) => Promise<string | null>;
  listOpenWorkspaceTargets: () => Promise<OpenWorkspaceTarget[]>;
  openNativeCodex: () => Promise<{ ok: boolean; detail?: string }>;
  openExternalUrl: (input: { url: string }) => Promise<void>;
  getFilePath: (file: File) => string;
  createTerminal: (input: { cwd: string; cols: number; rows: number }) => Promise<TerminalSession>;
  writeTerminal: (input: TerminalData) => Promise<void>;
  resizeTerminal: (input: { id: string; cols: number; rows: number }) => Promise<void>;
  closeTerminal: (input: { id: string }) => Promise<void>;
  onTerminalData: (listener: (event: TerminalData) => void) => () => void;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  getSubagentInfo: (input: { id: string }) => Promise<{ nickname: string | null; model: string | null }>;
  onUpdateState: (listener: (state: UpdateState) => void) => () => void;
  loadCodexSettings: () => Promise<CodexSettings>;
  saveCodexSettings: (input: CodexSettings) => Promise<CodexSettings>;
  translate: (input: { text: string; to?: string; from?: string }) => Promise<string>;
  loadProviderSettings: () => Promise<ProviderSettings>;
  selectProvider: (input: { provider: ProviderId; model: string }) => Promise<ProviderSettings>;
  saveProviderKey: (input: { provider: ProviderId; key: string }) => Promise<ProviderSettings>;
  clearProviderKey: (input: { provider: ProviderId }) => Promise<ProviderSettings>;
  refreshProviderModels: (input: { provider: Exclude<ProviderId, "codex"> }) => Promise<ProviderSettings>;
  listCodexModels: () => Promise<ProviderModel[]>;
  newChatCwd: () => Promise<string>;
  providerAuthStatus: () => Promise<ProviderAuthStatus>;
  providerLogin: (input: { provider: "codex" | "claude" | "copilot" }) => Promise<DeviceCodeInfo | null>;
  providerLogout: (input: { provider: "codex" | "claude" | "copilot" }) => Promise<ProviderAuthStatus>;
  providerOauthModels: (input: { provider: "copilot" | "claude-code" }) => Promise<ProviderModel[]>;
  providerUsage: () => Promise<ProviderUsageReport>;
  providerRequestLog: () => Promise<ProviderRequestLogEntry[]>;
  onProviderAuth: (listener: (status: ProviderAuthStatus) => void) => () => void;
  openWorkspace: (input: { cwd: string; target: ExternalTarget }) => Promise<{ ok: boolean; detail?: string }>;
  respondApproval: (input: { requestId: string | number; decision: ApprovalDecision; threadId?: string }) => Promise<void>;
  sendTurn: (input: { threadId: string; cwd: string; text: string; model: string; provider?: ProviderId; subagent?: boolean; skills?: Array<{ name: string; path: string }>; attachments?: string[]; attachmentDetails?: ThreadAttachment[]; sidecars?: SidecarSettings; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode; reasoningEffort?: ReasoningEffort; responseSpeed?: ResponseSpeed }) => Promise<void>;
  interruptTurn: (input: { threadId: string; turnId?: string }) => Promise<void>;
  onAppServerEvent: (listener: (event: AppServerEvent) => void) => () => void;
  onCommand: (listener: (command: AppCommand) => void) => () => void;
}
