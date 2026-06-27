import type { ApprovalDecision, ApprovalPrompt, AppServerEvent } from "../shared/contracts";

const decisions = new Set<ApprovalDecision>(["accept", "acceptForSession", "decline", "cancel"]);

export function approvalPromptFromEvent(event: AppServerEvent): ApprovalPrompt | null {
  if (event.requestId === undefined) return null;
  const command = event.method === "item/commandExecution/requestApproval";
  const fileChange = event.method === "item/fileChange/requestApproval";
  if (!command && !fileChange) return null;
  const params = (event.params ?? {}) as Record<string, unknown>;
  const available = ((params.availableDecisions as unknown[]) ?? []).filter((value): value is ApprovalDecision => typeof value === "string" && decisions.has(value as ApprovalDecision));
  return {
    requestId: event.requestId,
    kind: command ? "command" : "fileChange",
    threadId: String(params.threadId ?? ""), turnId: String(params.turnId ?? ""), itemId: String(params.itemId ?? ""),
    command: params.command == null ? undefined : String(params.command),
    cwd: params.cwd == null ? undefined : String(params.cwd),
    reason: params.reason == null ? undefined : String(params.reason),
    grantRoot: params.grantRoot == null ? undefined : String(params.grantRoot),
    availableDecisions: available.length ? available : ["accept", "acceptForSession", "decline"],
  };
}
