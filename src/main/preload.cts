import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppCommand, DevilCodexApi } from "./contracts.cjs";

const api: DevilCodexApi = {
  appInfo: () => ipcRenderer.invoke("app:info"),
  windowControl: (input) => ipcRenderer.invoke("app:window-control", input),
  showNotification: (input) => ipcRenderer.invoke("app:notify", input),
  openPermission: (input) => ipcRenderer.invoke("app:open-permission", input),
  browserNavigate: (input) => ipcRenderer.invoke("browser:navigate", input),
  browserBack: () => ipcRenderer.invoke("browser:back"),
  browserForward: () => ipcRenderer.invoke("browser:forward"),
  browserReload: () => ipcRenderer.invoke("browser:reload"),
  browserStop: () => ipcRenderer.invoke("browser:stop"),
  browserHardReload: () => ipcRenderer.invoke("browser:hard-reload"),
  browserState: () => ipcRenderer.invoke("browser:state"),
  browserScreenshot: () => ipcRenderer.invoke("browser:screenshot"),
  browserFind: (input) => ipcRenderer.invoke("browser:find", input),
  browserStopFind: () => ipcRenderer.invoke("browser:stop-find"),
  browserZoom: (input) => ipcRenderer.invoke("browser:zoom", input),
  browserClearCookies: () => ipcRenderer.invoke("browser:clear-cookies"),
  browserClearCache: () => ipcRenderer.invoke("browser:clear-cache"),
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
  forkThread: (input) => ipcRenderer.invoke("thread:fork", input),
  compactThread: (input) => ipcRenderer.invoke("thread:compact", input),
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
  sendTurn: (input) => ipcRenderer.invoke("turn:send", input),
  interruptTurn: (input) => ipcRenderer.invoke("turn:interrupt", input),
  onAppServerEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on("app-server:event", handler);
    return () => ipcRenderer.removeListener("app-server:event", handler);
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
