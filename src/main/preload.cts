import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppCommand, ApprovalResolvedEvent, DevilCodexApi, RemoteControlStatus, ThreadMetaUpdate, ThreadQueueCommand, ThreadQueueState } from "./contracts.cjs";

const api: DevilCodexApi = {
  appInfo: () => ipcRenderer.invoke("app:info"),
  windowControl: (input) => ipcRenderer.invoke("app:window-control", input),
  showNotification: (input) => ipcRenderer.invoke("app:notify", input),
  openPermission: (input) => ipcRenderer.invoke("app:open-permission", input),
  browserRegister: (input) => ipcRenderer.invoke("browser:register", input),
  browserFocus: (input) => ipcRenderer.invoke("browser:focus", input),
  browserNavigate: (input) => ipcRenderer.invoke("browser:navigate", input),
  browserBack: (input) => ipcRenderer.invoke("browser:back", input),
  browserForward: (input) => ipcRenderer.invoke("browser:forward", input),
  browserReload: (input) => ipcRenderer.invoke("browser:reload", input),
  browserStop: (input) => ipcRenderer.invoke("browser:stop", input),
  browserHardReload: (input) => ipcRenderer.invoke("browser:hard-reload", input),
  browserState: (input) => ipcRenderer.invoke("browser:state", input),
  browserScreenshot: (input) => ipcRenderer.invoke("browser:screenshot", input),
  browserFind: (input) => ipcRenderer.invoke("browser:find", input),
  browserStopFind: (input) => ipcRenderer.invoke("browser:stop-find", input),
  browserZoom: (input) => ipcRenderer.invoke("browser:zoom", input),
  browserClearCookies: (input) => ipcRenderer.invoke("browser:clear-cookies", input),
  browserClearCache: (input) => ipcRenderer.invoke("browser:clear-cache", input),
  browserCaptureRect: (input) => ipcRenderer.invoke("browser:capture-rect", input),
  browserAiClick: (input) => ipcRenderer.invoke("browser:ai-click", input),
  browserAiType: (input) => ipcRenderer.invoke("browser:ai-type", input),
  browserUploadFiles: (input) => ipcRenderer.invoke("browser:upload-files", input),
  browserAiKey: (input) => ipcRenderer.invoke("browser:ai-key", input),
  browserAiScroll: (input) => ipcRenderer.invoke("browser:ai-scroll", input),
  browserAiRead: () => ipcRenderer.invoke("browser:ai-read"),
  onBrowserState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("browser:state", handler);
    return () => ipcRenderer.removeListener("browser:state", handler);
  },
  onBrowserActivate: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("browser:activate", handler);
    return () => ipcRenderer.removeListener("browser:activate", handler);
  },
  onBrowserNewTab: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("browser:new-tab", handler);
    return () => ipcRenderer.removeListener("browser:new-tab", handler);
  },
  onAsk: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("ask:request", handler);
    return () => ipcRenderer.removeListener("ask:request", handler);
  },
  askRespond: (input) => ipcRenderer.invoke("ask:respond", input),
  runtime: () => ipcRenderer.invoke("runtime:status"),
  connect: () => ipcRenderer.invoke("runtime:connect"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  createProjectFolder: (input) => ipcRenderer.invoke("workspace:create-project-folder", input),
  createThread: (input) => ipcRenderer.invoke("thread:create", input),
  listThreads: (input) => ipcRenderer.invoke("thread:list", input),
  searchThreads: (input) => ipcRenderer.invoke("thread:search", input),
  resumeThread: (input) => ipcRenderer.invoke("thread:resume", input),
  renameThread: (input) => ipcRenderer.invoke("thread:rename", input),
  updateThreadMeta: (input) => ipcRenderer.invoke("thread:meta:update", input),
  forkThread: (input) => ipcRenderer.invoke("thread:fork", input),
  compactThread: (input) => ipcRenderer.invoke("thread:compact", input),
  startReview: (input) => ipcRenderer.invoke("thread:review", input),
  readThread: (input) => ipcRenderer.invoke("thread:read", input),
  cacheThreadHistory: (input) => ipcRenderer.invoke("thread:cache-history", input),
  syncThreadHistory: (input) => ipcRenderer.invoke("thread:sync-history", input),
  listProjects: (input) => ipcRenderer.invoke("thread:projects", input ?? {}),
  archiveThread: (input) => ipcRenderer.invoke("thread:archive", input),
  unarchiveThread: (input) => ipcRenderer.invoke("thread:unarchive", input),
  deleteThread: (input) => ipcRenderer.invoke("thread:delete", input),
  undoFileChanges: (input) => ipcRenderer.invoke("workspace:undo-file-changes", input),
  stageWorkspaceFiles: (input) => ipcRenderer.invoke("workspace:stage-files", input),
  unstageWorkspaceFiles: (input) => ipcRenderer.invoke("workspace:unstage-files", input),
  applyWorkspaceHunk: (input) => ipcRenderer.invoke("workspace:apply-hunk", input),
  listGitBranches: (input) => ipcRenderer.invoke("workspace:list-branches", input),
  switchGitBranch: (input) => ipcRenderer.invoke("workspace:switch-branch", input),
  listGitWorktrees: (input) => ipcRenderer.invoke("workspace:list-worktrees", input),
  createGitWorktree: (input) => ipcRenderer.invoke("workspace:create-worktree", input),
  listSkills: (input) => ipcRenderer.invoke("skills:list", input),
  listMcpServers: (input) => ipcRenderer.invoke("mcp:list", input ?? {}),
  callMcpTool: (input) => ipcRenderer.invoke("mcp:call", input),
  uploadFeedback: (input) => ipcRenderer.invoke("feedback:upload", input),
  commitWorkspace: (input) => ipcRenderer.invoke("workspace:commit", input),
  pushWorkspace: (input) => ipcRenderer.invoke("workspace:push", input),
  createPullRequest: (input) => ipcRenderer.invoke("workspace:create-pr", input),
  getWorkspaceChanges: (input) => ipcRenderer.invoke("workspace:changes", input),
  getWorkspaceDiff: (input) => ipcRenderer.invoke("workspace:diff", input),
  listWorkspaceDirectory: (input) => ipcRenderer.invoke("workspace:list-directory", input),
  readWorkspaceFile: (input) => ipcRenderer.invoke("workspace:read-file", input),
  writeWorkspaceFile: (input) => ipcRenderer.invoke("workspace:write-file", input),
  renameWorkspaceEntry: (input) => ipcRenderer.invoke("workspace:rename-entry", input),
  deleteWorkspaceEntry: (input) => ipcRenderer.invoke("workspace:delete-entry", input),
  createWorkspaceEntry: (input) => ipcRenderer.invoke("workspace:create-entry", input),
  watchWorkspaceFiles: (input) => ipcRenderer.invoke("workspace:watch", input),
  unwatchWorkspaceFiles: (input) => ipcRenderer.invoke("workspace:unwatch", input),
  onWorkspaceFilesChanged: (listener: (payload: { cwd: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("workspace:fs-changed", handler);
    return () => ipcRenderer.removeListener("workspace:fs-changed", handler);
  },
  findWorkspaceFile: (input) => ipcRenderer.invoke("workspace:find-file", input),
  previewLocalImage: (input) => ipcRenderer.invoke("file:preview-image", input),
  listOpenWorkspaceTargets: () => ipcRenderer.invoke("workspace:list-open-targets"),
  openNativeCodex: () => ipcRenderer.invoke("app:open-native-codex"),
  openExternalUrl: (input) => ipcRenderer.invoke("app:open-external-url", input),
  getFilePath: (file) => webUtils.getPathForFile(file),
  clipboardReadText: () => ipcRenderer.invoke("clipboard:read-text"),
  clipboardWriteText: (input) => ipcRenderer.invoke("clipboard:write-text", input),
  listTerminalShells: () => ipcRenderer.invoke("terminal:shells"),
  createTerminal: (input) => ipcRenderer.invoke("terminal:create", input),
  writeTerminal: (input) => ipcRenderer.invoke("terminal:write", input),
  resizeTerminal: (input) => ipcRenderer.invoke("terminal:resize", input),
  closeTerminal: (input) => ipcRenderer.invoke("terminal:close", input),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  getSubagentInfo: (input) => ipcRenderer.invoke("subagent:info", input),
  listClaudeSkills: () => ipcRenderer.invoke("claude:skills"),
  listClaudeSlashCommands: (input) => ipcRenderer.invoke("claude:slash-commands", input ?? {}),
  listClaudeMcpServers: (input) => ipcRenderer.invoke("claude:mcp-list", input ?? {}),
  listCodexPluginSkills: () => ipcRenderer.invoke("codex:plugin-skills"),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
  loadCodexSettings: () => ipcRenderer.invoke("settings:load"),
  saveCodexSettings: (input) => ipcRenderer.invoke("settings:save", input),
  devilMcpStatus: () => ipcRenderer.invoke("devil-mcp:status"),
  remoteStatus: () => ipcRenderer.invoke("remote:status"),
  remoteEnable: (input) => ipcRenderer.invoke("remote:enable", input),
  remoteDisable: () => ipcRenderer.invoke("remote:disable"),
  remoteRegenerateToken: () => ipcRenderer.invoke("remote:regenerate-token"),
  remoteRevokeDevice: (input) => ipcRenderer.invoke("remote:revoke-device", input),
  remoteTailscaleUp: () => ipcRenderer.invoke("remote:tailscale-up"),
  remoteScope: () => ipcRenderer.invoke("remote:scope"),
  onRemoteStatus: (listener: (status: RemoteControlStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("remote:status", handler);
    return () => ipcRenderer.removeListener("remote:status", handler);
  },
  translate: (input) => ipcRenderer.invoke("translate:text", input),
  loadProviderSettings: () => ipcRenderer.invoke("providers:load"),
  selectProvider: (input) => ipcRenderer.invoke("providers:select", input),
  saveProviderKey: (input) => ipcRenderer.invoke("providers:save-key", input),
  clearProviderKey: (input) => ipcRenderer.invoke("providers:clear-key", input),
  refreshProviderModels: (input) => ipcRenderer.invoke("providers:refresh-models", input),
  listCodexModels: () => ipcRenderer.invoke("codex:models"),
  newChatCwd: () => ipcRenderer.invoke("chat:new-chat-cwd"),
  providerAuthStatus: () => ipcRenderer.invoke("providers:auth-status"),
  providerLogin: (input) => ipcRenderer.invoke("providers:login", input),
  providerLogout: (input) => ipcRenderer.invoke("providers:logout", input),
  providerOauthModels: (input) => ipcRenderer.invoke("providers:oauth-models", input),
  providerUsage: (input) => ipcRenderer.invoke("providers:usage", input),
  providerRequestLog: () => ipcRenderer.invoke("providers:request-log"),
  onProviderAuth: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("provider:auth", handler);
    return () => ipcRenderer.removeListener("provider:auth", handler);
  },
  onProviderUsageChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("provider:usage-changed", handler);
    return () => ipcRenderer.removeListener("provider:usage-changed", handler);
  },
  openWorkspace: (input) => ipcRenderer.invoke("workspace:open-external", input),
  respondApproval: (input) => ipcRenderer.invoke("approval:respond", input),
  getThreadQueue: (input) => ipcRenderer.invoke("thread:queue:get", input),
  getThreadActive: (input) => ipcRenderer.invoke("thread:active", input),
  syncThreadQueue: (input) => ipcRenderer.invoke("thread:queue:sync", input),
  queueTurn: (input) => ipcRenderer.invoke("turn:queue:enqueue", input),
  updateQueuedTurn: (input) => ipcRenderer.invoke("turn:queue:update", input),
  removeQueuedTurn: (input) => ipcRenderer.invoke("turn:queue:remove", input),
  steerQueuedTurn: (input) => ipcRenderer.invoke("turn:queue:steer", input),
  clearQueuedTurns: (input) => ipcRenderer.invoke("turn:queue:clear", input),
  steerTurn: (input) => ipcRenderer.invoke("turn:steer", input),
  sendTurn: (input) => ipcRenderer.invoke("turn:send", input),
  interruptTurn: (input) => ipcRenderer.invoke("turn:interrupt", input),
  onAppServerEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("app-server:event", handler);
    return () => ipcRenderer.removeListener("app-server:event", handler);
  },
  onThreadQueueChanged: (listener: (state: ThreadQueueState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("thread:queue-changed", handler);
    return () => ipcRenderer.removeListener("thread:queue-changed", handler);
  },
  onThreadQueueCommand: (listener: (command: ThreadQueueCommand) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("thread:queue-command", handler);
    return () => ipcRenderer.removeListener("thread:queue-command", handler);
  },
  onThreadMetaChanged: (listener: (meta: ThreadMetaUpdate) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("thread:meta-changed", handler);
    return () => ipcRenderer.removeListener("thread:meta-changed", handler);
  },
  onApprovalResolved: (listener: (event: ApprovalResolvedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("approval:resolved", handler);
    return () => ipcRenderer.removeListener("approval:resolved", handler);
  },
  onTerminalData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("terminal:data", handler);
    return () => ipcRenderer.removeListener("terminal:data", handler);
  },
  onCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: AppCommand) => listener(command);
    ipcRenderer.on("app:command", handler);
    return () => ipcRenderer.removeListener("app:command", handler);
  },
};

contextBridge.exposeInMainWorld("devilCodex", api);
