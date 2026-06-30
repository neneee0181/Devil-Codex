import type { ContextUsage, ProviderTokenUsage, ThreadActivityEntry, ThreadAttachment, ThreadHistoryItem } from "./contracts.cjs";

type RawItem = Record<string, unknown>;
type RawTurn = Record<string, unknown> & { items?: RawItem[] };

function countDiff(diff: string): { additions: number; deletions: number } {
  return {
    additions: (diff.match(/^\+(?!\+\+)/gm) ?? []).length,
    deletions: (diff.match(/^-(?!--)/gm) ?? []).length,
  };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || "image";
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

function turnTokenUsageFromRaw(turn: RawItem): { tokenUsage?: ProviderTokenUsage; cumulativeTokenUsage?: ProviderTokenUsage } {
  const info = (turn.info ?? {}) as RawItem;
  const tokenUsage = tokenUsageField(turn, "lastTokenUsage", "last_token_usage", "usage", "tokenUsage", "token_usage")
    ?? tokenUsageField(info, "lastTokenUsage", "last_token_usage");
  const cumulativeTokenUsage = tokenUsageField(turn, "totalTokenUsage", "total_token_usage", "cumulativeTokenUsage", "cumulative_token_usage")
    ?? tokenUsageField(info, "totalTokenUsage", "total_token_usage");
  return {
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(cumulativeTokenUsage ? { cumulativeTokenUsage } : {}),
  };
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

// Pull image data URLs + text out of an MCP tool result so reloaded history
// renders screenshots/generated images inline (mirrors the live timeline path).
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
    if (type === "image" && typeof p.data === "string") images.push(`data:${String(p.mimeType ?? "image/png")};base64,${p.data}`);
    else if (type === "image_url") { const url = typeof p.image_url === "object" ? String((p.image_url as RawItem).url ?? "") : String(p.image_url ?? ""); if (url) images.push(url); }
    else if (type === "text" && typeof p.text === "string") texts.push(p.text);
  }
  if (!images.length && !texts.length && item.error) texts.push(String(typeof item.error === "string" ? item.error : JSON.stringify(item.error)));
  return { images, text: texts.join("\n").trim() };
}

// Build the user message text plus structured attachments. Stock Codex stores
// pasted images as `input_image` with a base64 `image_url` data URL (persistent
// in the rollout), so surface those as attachment cards rather than inlining.
function userContent(item: RawItem): { text: string; attachments: ThreadAttachment[] } {
  const content = (item.content as RawItem[]) ?? [];
  const text = content.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("");
  const skills = content.filter((part) => part.type === "skill").map((part) => `$${String(part.name ?? "")}`).filter((value) => value !== "$");
  const prefix = skills.length && !skills.every((skill) => text.includes(skill)) ? `${skills.join(" ")}\n` : "";
  const attachments: ThreadAttachment[] = [];
  for (const part of content) {
    if (part.type === "input_image" && typeof part.image_url === "string") {
      attachments.push({ name: "image", kind: "image", url: String(part.image_url) });
    } else if (part.type === "image" && typeof part.url === "string") {
      attachments.push({ name: "image", kind: "image", url: String(part.url) });
    } else if (part.type === "localImage" && typeof part.path === "string") {
      attachments.push({ name: baseName(String(part.path)), kind: "image", path: String(part.path) });
    } else if (part.type === "input_file" || part.type === "file") {
      const path = String(part.path ?? part.filename ?? part.file_id ?? "");
      if (path) attachments.push({ name: baseName(path), kind: "file", path });
    }
  }
  return { text: `${prefix}${text}`.trim(), attachments };
}

export function activityFromItem(item: RawItem, fallbackId: string = crypto.randomUUID()): ThreadActivityEntry | null {
  const id = String(item.id ?? fallbackId);
  const type = String(item.type ?? "");
  if (type === "reasoning") {
    const summary = ((item.summary as unknown[]) ?? []).map(String).join("\n\n");
    return { id, kind: "reasoning", title: "추론", detail: summary, status: "completed" };
  }
  if (type === "commandExecution") {
    return {
      id, kind: "command", title: String(item.command ?? "명령 실행"), detail: String(item.cwd ?? ""),
      output: item.aggregatedOutput == null ? "" : String(item.aggregatedOutput),
      status: String(item.status ?? "completed") as ThreadActivityEntry["status"],
    };
  }
  if (type === "fileChange") {
    const changes = ((item.changes as RawItem[]) ?? []).map((change) => {
      const counts = countDiff(String(change.diff ?? ""));
      return { path: String(change.path ?? "파일"), diff: String(change.diff ?? ""), ...counts };
    });
    return { id, kind: "fileChange", title: `파일 ${changes.length}개 수정`, files: changes, status: String(item.status ?? "completed") === "failed" ? "failed" : "completed" };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const tool = String(item.tool ?? "도구");
    const { images, text } = mcpResultContent(item);
    return { id, kind: "mcp", title: `${tool} 실행`, detail: text || undefined, images: images.length ? images : undefined, status: String(item.status ?? "completed") as ThreadActivityEntry["status"] };
  }
  if (type === "webSearch") return {
    id,
    kind: "webSearch",
    title: `웹 검색: ${String(item.query ?? "")}`,
    detail: String(item.detail ?? ""),
    status: String(item.status ?? "completed") as ThreadActivityEntry["status"],
  };
  // The model delegates work to a "sub agent" via collab tools; app-server
  // reports it as a collabAgentToolCall (the delegation) and subAgentActivity
  // (the sub agent's own activity). Render both as subagent cards.
  if (type === "collabAgentToolCall") {
    const tool = String(item.tool ?? "");
    const labels: Record<string, string> = {
      spawnAgent: "서브에이전트 생성", sendInput: "서브에이전트에 입력 전달",
      resumeAgent: "서브에이전트 재개", wait: "서브에이전트 대기", closeAgent: "서브에이전트 종료",
    };
    const receivers = (item.receiverThreadIds as unknown[] | undefined)?.map(String) ?? [];
    return {
      id, kind: "subagent",
      title: labels[tool] ?? "서브에이전트 작업",
      status: String(item.status ?? "inProgress") as ThreadActivityEntry["status"],
      subagent: { agentThreadId: receivers[0] ?? "" },
    };
  }
  if (type === "subAgentActivity") {
    const state = String(item.kind ?? "started");
    const agentPath = String(item.agentPath ?? item.agent_path ?? "");
    const role = agentPath ? (agentPath.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "") : "";
    return {
      id, kind: "subagent",
      title: role ? `서브에이전트: ${role}` : "서브에이전트",
      detail: agentPath || undefined,
      status: state === "interrupted" ? "failed" : state === "started" ? "inProgress" : "completed",
      subagent: {
        agentThreadId: String(item.agentThreadId ?? item.agent_thread_id ?? ""),
        agentPath: agentPath || undefined,
        source: "thread_spawn",
        role: role || undefined,
      },
    };
  }
  if (type === "contextCompaction") return { id, kind: "compaction", title: "컨텍스트가 자동으로 압축됨", status: "completed" };
  if (type === "plan") return { id, kind: "message", title: "계획", detail: String(item.text ?? ""), status: "completed" };
  return null;
}

export function mapThreadHistory(turns: RawTurn[]): ThreadHistoryItem[] {
  const history: ThreadHistoryItem[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    const turnId = String(turn.id ?? `turn-${turnIndex}`);
    const items = turn.items ?? [];
    let lastAgent = -1;
    items.forEach((item, index) => { if (item.type === "agentMessage") lastAgent = index; });
    const activities: ThreadActivityEntry[] = [];
    const finalMessages: ThreadHistoryItem[] = [];

    items.forEach((item, index) => {
      const id = String(item.id ?? `${turnId}-${index}`);
      const type = String(item.type ?? "");
      if (type === "userMessage") {
        const { text, attachments } = userContent(item);
        if (text || attachments.length) history.push({ id, kind: "user", text, turnId, ...(attachments.length ? { attachments } : {}) });
        return;
      }
      if (type === "agentMessage") {
        const text = String(item.text ?? "").trim();
        if (!text) return;
        const commentary = item.phase === "commentary" || (item.phase == null && index !== lastAgent);
        if (commentary) activities.push({ id, kind: "message", title: "작업 메모", detail: text, status: "completed" });
        else finalMessages.push({ id, kind: "agent", text, turnId });
        return;
      }
      const activity = activityFromItem(item, id);
      if (activity) activities.push(activity);
    });

    const startedAt = Number(turn.startedAt ?? 0);
    const completedAt = Number(turn.completedAt ?? 0);
    history.push({
      id: `activity-${turnId}`, kind: "activity", text: "", turnId, activities,
      status: String(turn.status ?? "completed") as ThreadHistoryItem["status"],
      durationMs: Number(turn.durationMs ?? (startedAt && completedAt ? (completedAt - startedAt) * 1000 : 0)), startedAt: startedAt * 1000,
      contextUsage: contextUsageFromRaw(turn),
      ...turnTokenUsageFromRaw(turn),
    });
    history.push(...finalMessages);
  }
  return history;
}
