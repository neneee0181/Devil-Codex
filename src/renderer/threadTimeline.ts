import type { AppServerEvent, ContextUsage, ProviderTokenUsage, ThreadActivityEntry, ThreadHistoryItem } from "../shared/contracts";

type RawItem = Record<string, unknown>;


const completedTurns = new Set<string>();
function diffCounts(diff: string): { additions: number; deletions: number } {
  return { additions: (diff.match(/^\+(?!\+\+)/gm) ?? []).length, deletions: (diff.match(/^-(?!--)/gm) ?? []).length };
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function tokenNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function tokenUsageFromRaw(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as RawItem;
  const inputTokens = tokenNumber(raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens) ?? 0;
  const outputTokens = tokenNumber(raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens) ?? 0;
  const totalTokens = tokenNumber(raw.totalTokens ?? raw.total_tokens) ?? inputTokens + outputTokens;
  if (totalTokens <= 0) return undefined;
  const cachedInputTokens = tokenNumber(raw.cachedInputTokens ?? raw.cached_input_tokens);
  const reasoningOutputTokens = tokenNumber(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens);
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens,
  };
}

function tokenUsageField(raw: RawItem, ...keys: string[]): ProviderTokenUsage | undefined {
  for (const key of keys) {
    const usage = tokenUsageFromRaw(raw[key]);
    if (usage) return usage;
  }
  return undefined;
}

function tokenUsageSnapshotFromRaw(...values: Array<unknown>): { tokenUsage?: ProviderTokenUsage; cumulativeTokenUsage?: ProviderTokenUsage; contextUsage?: ContextUsage } | undefined {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const raw = value as RawItem;
    const payload = (raw.payload ?? {}) as RawItem;
    const info = (raw.info ?? payload.info ?? {}) as RawItem;
    const tokenUsage = tokenUsageField(raw, "lastTokenUsage", "last_token_usage", "usage", "tokenUsage", "token_usage")
      ?? tokenUsageField(info, "lastTokenUsage", "last_token_usage");
    const cumulativeTokenUsage = tokenUsageField(raw, "totalTokenUsage", "total_token_usage", "cumulativeTokenUsage", "cumulative_token_usage")
      ?? tokenUsageField(info, "totalTokenUsage", "total_token_usage");
    const maxTokens = finiteNumber(raw.modelContextWindow ?? raw.model_context_window ?? payload.modelContextWindow ?? payload.model_context_window ?? info.modelContextWindow ?? info.model_context_window);
    const usedTokens = tokenUsage ? tokenUsage.totalTokens ?? tokenUsage.inputTokens + tokenUsage.outputTokens : undefined;
    const contextUsage = usedTokens && maxTokens ? { usedTokens, maxTokens } : undefined;
    if (tokenUsage || cumulativeTokenUsage || contextUsage) {
      return {
        ...(tokenUsage ? { tokenUsage } : {}),
        ...(cumulativeTokenUsage ? { cumulativeTokenUsage } : {}),
        ...(contextUsage ? { contextUsage } : {}),
      };
    }
  }
  return undefined;
}

function assistantText(item: RawItem): string {
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is RawItem => Boolean(part) && typeof part === "object")
    .map((part) => String(part.text ?? part.output_text ?? ""))
    .join("");
}

function isAssistantMessageItem(item: RawItem, type: string): boolean {
  if (type === "agentMessage" || type === "agent_message") return true;
  if (type !== "message") return false;
  const role = String(item.role ?? "");
  return !role || role === "assistant";
}

function isFinalAssistantMessage(item: RawItem): boolean {
  const phase = String(item.phase ?? "");
  return phase !== "commentary";
}

function contextUsageFromRaw(...values: Array<unknown>): ContextUsage | undefined {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const raw = value as RawItem;
    const nested = [raw.contextUsage, raw.context_usage, raw.usage, raw.tokenUsage, raw.token_usage].filter(Boolean) as RawItem[];
    const candidates = [raw, ...nested];
    for (const candidate of candidates) {
      const used = finiteNumber(candidate.usedTokens ?? candidate.used_tokens ?? candidate.totalTokens ?? candidate.total_tokens ?? candidate.tokenCount ?? candidate.token_count ?? candidate.inputTokens ?? candidate.input_tokens);
      const max = finiteNumber(candidate.maxTokens ?? candidate.max_tokens ?? candidate.contextWindow ?? candidate.context_window ?? candidate.windowTokens ?? candidate.window_tokens ?? candidate.limitTokens ?? candidate.limit_tokens);
      if (used && max) return { usedTokens: used, maxTokens: max };
    }
  }
  return undefined;
}

// Pull image data URLs + text out of an MCP tool result so the timeline can
// render screenshots (computer_screenshot) and generated images inline, rather
// than dumping raw JSON. Handles the MCP CallToolResult `content` array as well
// as app-server `contentItems` shapes.
function mcpResultContent(item: RawItem): { images: string[]; text: string } {
  const result = item.result as RawItem | undefined;
  const raw = (result?.content ?? item.contentItems ?? (Array.isArray(item.result) ? item.result : undefined)) as unknown;
  const parts = Array.isArray(raw) ? raw : [];
  const images: string[] = [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as RawItem;
    const type = String(p.type ?? "");
    if (type === "image" && typeof p.data === "string") {
      images.push(`data:${String(p.mimeType ?? "image/png")};base64,${p.data}`);
    } else if (type === "image_url") {
      const url = typeof p.image_url === "object" ? String((p.image_url as RawItem).url ?? "") : String(p.image_url ?? "");
      if (url) images.push(url);
    } else if (type === "text" && typeof p.text === "string") {
      texts.push(p.text);
    }
  }
  if (!images.length && !texts.length && item.error) texts.push(String(typeof item.error === "string" ? item.error : JSON.stringify(item.error)));
  return { images, text: texts.join("\n").trim() };
}

function entryFromItem(item: RawItem): ThreadActivityEntry | null {
  const id = String(item.id ?? crypto.randomUUID());
  const type = String(item.type ?? "");
  if (type === "reasoning") return { id, kind: "reasoning", title: "추론", detail: ((item.summary as unknown[]) ?? []).map(String).join("\n\n"), status: "completed" };
  if (type === "commandExecution") return { id, kind: "command", title: String(item.command ?? "명령 실행"), detail: String(item.cwd ?? ""), output: String(item.aggregatedOutput ?? ""), status: String(item.status ?? "inProgress") as ThreadActivityEntry["status"] };
  if (type === "fileChange") {
    const files = ((item.changes as RawItem[]) ?? []).map((change) => ({ path: String(change.path ?? "파일"), diff: String(change.diff ?? ""), ...diffCounts(String(change.diff ?? "")) }));
    return { id, kind: "fileChange", title: `파일 ${files.length}개 수정`, files, status: String(item.status ?? "completed") === "failed" ? "failed" : "completed" };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const { images, text } = mcpResultContent(item);
    return { id, kind: "mcp", title: `${String(item.tool ?? "도구")} 실행`, detail: text || undefined, images: images.length ? images : undefined, status: String(item.status ?? "inProgress") as ThreadActivityEntry["status"] };
  }
  if (type === "webSearch") return {
    id,
    kind: "webSearch",
    title: `웹 검색: ${String(item.query ?? "")}`,
    detail: String(item.detail ?? ""),
    status: String(item.status ?? "completed") as ThreadActivityEntry["status"],
  };
  if (type === "collabAgentToolCall") {
    const tool = String(item.tool ?? "");
    const labels: Record<string, string> = {
      spawnAgent: "서브에이전트 생성", sendInput: "서브에이전트에 입력 전달",
      resumeAgent: "서브에이전트 재개", wait: "서브에이전트 대기", closeAgent: "서브에이전트 종료",
    };
    const receivers = (item.receiverThreadIds as unknown[] | undefined)?.map(String) ?? [];
    return {
      id, kind: "subagent", title: labels[tool] ?? "서브에이전트 작업",
      status: String(item.status ?? "inProgress") as ThreadActivityEntry["status"],
      subagent: { agentThreadId: receivers[0] ?? "" },
    };
  }
  if (type === "subAgentActivity") {
    const state = String(item.kind ?? "started");
    const agentPath = String(item.agentPath ?? item.agent_path ?? "");
    const role = agentPath ? (agentPath.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "") : "";
    return {
      id, kind: "subagent", title: role ? `서브에이전트: ${role}` : "서브에이전트",
      detail: agentPath || undefined,
      status: state === "interrupted" ? "failed" : state === "started" ? "inProgress" : "completed",
      subagent: { agentThreadId: String(item.agentThreadId ?? item.agent_thread_id ?? ""), agentPath: agentPath || undefined, source: "thread_spawn", role: role || undefined },
    };
  }
  if (type === "contextCompaction") return { id, kind: "compaction", title: "컨텍스트가 자동으로 압축됨", status: "completed" };
  if (type === "providerDiagnostics") return { id, kind: "diagnostic", title: String(item.title ?? "Provider 진단"), detail: String(item.detail ?? ""), status: String(item.status ?? "completed") as ThreadActivityEntry["status"] };
  if (type === "error") return { id, kind: "message", title: "Provider 응답 실패", detail: String(item.message ?? item.text ?? item.error ?? "Provider가 이유를 알 수 없는 실패를 반환했습니다."), status: "failed" };
  if (type === "plan") return { id, kind: "message", title: "계획", detail: String(item.text ?? ""), status: "completed" };
  if (isAssistantMessageItem(item, type) && !isFinalAssistantMessage(item)) return { id, kind: "message", title: "작업 메모", detail: assistantText(item), status: "inProgress" };
  return null;
}

function updateActivity(items: ThreadHistoryItem[], turnId: string, update: (item: ThreadHistoryItem) => ThreadHistoryItem): ThreadHistoryItem[] {
  const index = items.findIndex((item) => item.kind === "activity" && item.turnId === turnId);
  if (index >= 0) return items.map((item, itemIndex) => itemIndex === index ? update(item) : item);
  return [...items, update({ id: `activity-${turnId}`, kind: "activity", text: "", turnId, status: "inProgress", startedAt: Date.now(), activities: [] })];
}

function upsertEntry(items: ThreadHistoryItem[], turnId: string, entry: ThreadActivityEntry): ThreadHistoryItem[] {
  return updateActivity(items, turnId, (activity) => {
    const entries = activity.activities ?? [];
    const exists = entries.some((current) => current.id === entry.id);
    return { ...activity, activities: exists ? entries.map((current) => current.id === entry.id ? { ...current, ...entry } : current) : [...entries, entry] };
  });
}

function applyTokenUsageSnapshot(items: ThreadHistoryItem[], turnId: string, snapshot: { tokenUsage?: ProviderTokenUsage; cumulativeTokenUsage?: ProviderTokenUsage; contextUsage?: ContextUsage }): ThreadHistoryItem[] {
  return updateActivity(items, turnId, (activity) => ({
    ...activity,
    ...(snapshot.contextUsage ? { contextUsage: snapshot.contextUsage } : {}),
    ...(snapshot.tokenUsage ? { tokenUsage: snapshot.tokenUsage } : {}),
    ...(snapshot.cumulativeTokenUsage ? { cumulativeTokenUsage: snapshot.cumulativeTokenUsage } : {}),
  }));
}

function appendEntryText(items: ThreadHistoryItem[], turnId: string, itemId: string, kind: ThreadActivityEntry["kind"], delta: string): ThreadHistoryItem[] {
  return updateActivity(items, turnId, (activity) => {
    const entries = activity.activities ?? [];
    const existing = entries.find((entry) => entry.id === itemId);
    const next = existing
      ? entries.map((entry) => entry.id === itemId ? { ...entry, detail: `${entry.detail ?? ""}${delta}` } : entry)
      : [...entries, { id: itemId, kind, title: kind === "reasoning" ? "추론" : "작업 메모", detail: delta, status: "inProgress" as const }];
    return { ...activity, activities: next };
  });
}

// Move standalone agent-message items of this turn INTO the turn's activity as
// intermediate "작업 메모" entries, so work narration interleaves chronologically
// with tools/commands rather than piling up below the work. Called right before
// new turn content is added: anything that follows an agent message proves that
// message was intermediate, not the final answer. The genuinely-final message
// is the last one — nothing follows it, so it is never demoted and stays as the
// standalone final response shown after the collapsed work. `exceptId` keeps the
// message currently being (re)written from demoting itself. Mirrors the offline
// mapThreadHistory "all agent messages but the last are commentary" rule.
function demotePriorAgentMessages(items: ThreadHistoryItem[], turnId: string, exceptId?: string): ThreadHistoryItem[] {
  // Late synthetic items (diagnostics, file rollups) arrive after turn
  // completion and must not demote the final agent response back into the
  // work tab. React 18 batches setItems calls, so checking activity.status
  // is unreliable — use the module-level completedTurns Set instead, which
  // is mutated atomically inside the same setItems callback that processes
  // turn/completed.
  if (completedTurns.has(turnId)) return items;

  const isPrior = (item: ThreadHistoryItem): boolean => item.kind === "agent" && item.turnId === turnId && item.id !== exceptId;
  if (!items.some(isPrior)) return items;
  let next = items.filter((item) => !isPrior(item));
  for (const msg of items.filter(isPrior)) {
    next = upsertEntry(next, turnId, { id: msg.id, kind: "message", title: "작업 메모", detail: msg.text, status: "completed" });
  }
  return next;
}

function responseErrorMessage(response: RawItem | undefined): string {
  const error = (response?.error ?? response?.last_error) as RawItem | undefined;
  return String(error?.message ?? error?.code ?? error?.type ?? "Provider가 이유를 알 수 없는 실패를 반환했습니다.");
}

function latestActivityTurnId(items: ThreadHistoryItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "activity" && item.status === "inProgress" && item.turnId) return item.turnId;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "activity" && item.turnId) return item.turnId;
  }
  return "";
}

function hasFailureEntry(item: ThreadHistoryItem): boolean {
  return item.kind === "activity" && Boolean(item.activities?.some((entry) => entry.status === "failed"));
}

export function applyTimelineEvent(items: ThreadHistoryItem[], event: AppServerEvent): ThreadHistoryItem[] {
  const params = (event.params ?? {}) as Record<string, unknown>;
  const explicitTurnId = String(params.turnId ?? (params.turn as RawItem | undefined)?.id ?? "");
  const turnId = explicitTurnId || latestActivityTurnId(items);
  const item = params.item as RawItem | undefined;
  const liveTokenUsage = tokenUsageSnapshotFromRaw(params);
  const payload = (params.payload ?? {}) as RawItem;
  const tokenEvent = /token/i.test(event.method) || String(params.type ?? payload.type ?? "") === "token_count";

  if (turnId && liveTokenUsage && tokenEvent) {
    return applyTokenUsageSnapshot(items, turnId, liveTokenUsage);
  }

  if (event.method === "turn/started" && turnId) {
    const turn = (params.turn ?? {}) as RawItem;
    return updateActivity(items, turnId, (activity) => ({ ...activity, status: "inProgress", startedAt: Number(turn.startedAt ?? 0) * 1000 || Date.now() }));
  }
  if (event.method === "turn/completed" && turnId) {
    completedTurns.add(turnId);
    const turn = (params.turn ?? {}) as RawItem;
    const status = String(turn.status ?? "completed") as ThreadHistoryItem["status"];
    const contextUsage = contextUsageFromRaw(turn, params);
    const tokenUsage = tokenUsageSnapshotFromRaw(turn, params);
    const completed = updateActivity(items, turnId, (activity) => ({
      ...activity,
      status,
      durationMs: Number(turn.durationMs ?? (Date.now() - (activity.startedAt ?? Date.now()))),
      contextUsage: contextUsage ?? tokenUsage?.contextUsage ?? activity.contextUsage,
      ...(tokenUsage?.tokenUsage ? { tokenUsage: tokenUsage.tokenUsage } : {}),
      ...(tokenUsage?.cumulativeTokenUsage ? { cumulativeTokenUsage: tokenUsage.cumulativeTokenUsage } : {}),
    }));
    const activity = completed.find((current) => current.kind === "activity" && current.turnId === turnId);
    if (status === "failed" && activity && !hasFailureEntry(activity)) {
      return upsertEntry(completed, turnId, {
        id: `response-error-${turnId}`,
        kind: "message",
        title: "Provider 응답 실패",
        detail: "Provider가 실패했지만 상세 이유 이벤트를 전달하지 않았습니다. 로그인/토큰 만료, 모델 미지원, 사용량 한도, 네트워크 문제 중 하나일 수 있습니다. 터미널 로그나 Provider 연결 상태를 확인해 주세요.",
        status: "failed",
      });
    }
    return completed;
  }
  if (event.method === "response.failed" && turnId) {
    const response = params.response as RawItem | undefined;
    const message = responseErrorMessage(response);
    return upsertEntry(items, turnId, {
      id: `response-error-${turnId}`,
      kind: "message",
      title: "Provider 응답 실패",
      detail: message,
      status: "failed",
    });
  }
  if ((event.method === "item/started" || event.method === "item/completed") && item && turnId) {
    const type = String(item.type ?? "");
    if (!explicitTurnId && (type === "providerDiagnostics" || type === "fileChange" || type === "webSearch" || type === "contextCompaction")) return items;
    if (isAssistantMessageItem(item, type) && isFinalAssistantMessage(item)) {
      const id = String(item.id ?? crypto.randomUUID());
      const text = assistantText(item);
      const exists = items.some((current) => current.id === id);
      // A new agent message means any earlier one was intermediate → fold it
      // into the work timeline; keep this latest message standalone (the final
      // answer until something later proves otherwise).
      const base = demotePriorAgentMessages(items, turnId, id);
      return exists ? base.map((current) => current.id === id ? { ...current, text } : current) : [...base, { id, kind: "agent", text, turnId }];
    }
    const mapped = entryFromItem(item);
    const entry = mapped && event.method === "item/completed" ? { ...mapped, status: mapped.status === "failed" || mapped.status === "declined" ? mapped.status : "completed" as const } : mapped;
    if (!entry) return items;
    // Only genuine work following narration proves the narration was
    // intermediate → fold pending messages in (chronological). Late synthetic
    // items (Provider 진단, compaction) must NOT demote the final answer into the
    // work tab — they arrive after it.
    const WORK_KINDS = new Set(["command", "fileChange", "mcp", "webSearch", "subagent"]);
    const base = WORK_KINDS.has(entry.kind) ? demotePriorAgentMessages(items, turnId) : items;
    return upsertEntry(base, turnId, entry);
  }
  if (event.method === "item/agentMessage/delta" && turnId) {
    const itemId = String(params.itemId ?? "stream");
    const delta = String(params.delta ?? "");
    const activityHasItem = items.some((current) => current.kind === "activity" && current.turnId === turnId && current.activities?.some((entry) => entry.id === itemId));
    if (activityHasItem) return appendEntryText(items, turnId, itemId, "message", delta);
    const exists = items.some((current) => current.id === itemId);
    if (exists) return items.map((current) => current.id === itemId ? { ...current, text: current.text + delta } : current);
    // First delta of a brand-new message: fold any earlier message into the
    // work timeline, keep this one streaming standalone.
    return [...demotePriorAgentMessages(items, turnId, itemId), { id: itemId, kind: "agent", text: delta, turnId }];
  }
  if ((event.method === "item/reasoning/summaryTextDelta" || event.method === "item/plan/delta") && turnId) return appendEntryText(items, turnId, String(params.itemId ?? crypto.randomUUID()), event.method.includes("reasoning") ? "reasoning" : "message", String(params.delta ?? ""));
  if (event.method === "item/commandExecution/outputDelta" && turnId) {
    const itemId = String(params.itemId ?? "command");
    return updateActivity(items, turnId, (activity) => ({ ...activity, activities: (activity.activities ?? []).map((entry) => entry.id === itemId ? { ...entry, output: `${entry.output ?? ""}${String(params.delta ?? "")}` } : entry) }));
  }
  if (event.method === "thread/compacted" && turnId) return upsertEntry(items, turnId, { id: `compaction-${turnId}`, kind: "compaction", title: "컨텍스트가 자동으로 압축됨", status: "completed" });
  return items;
}
