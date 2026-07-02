import { motion } from "motion/react";
import { createPortal } from "react-dom";
import {
  Bot,
  Box,
  Brain,
  Code2,
  Command,
  Cuboid,
  FastForward,
  Flag,
  GitFork,
  Heart,
  MessageSquarePlus,
  Package,
  PanelRight,
  RefreshCcw,
  Settings,
  SlidersHorizontal,
  Target,
  Zap,
} from "lucide-react";
import type { CaretPosition } from "./composerCaret";
import type { ApprovalMode } from "./ApprovalPicker";
import type { McpServerInfo, ReasoningEffort, ResponseSpeed } from "../../shared/contracts";

export type SlashCommandId =
  | "mcp"
  | "fast"
  | "memory"
  | "model"
  | "goal"
  | "side"
  | "status"
  | "settings"
  | "compact"
  | "init"
  | "reasoning"
  | "review"
  | "pet"
  | "fork"
  | "plan"
  | "feedback";

type SlashCommand = {
  id: SlashCommandId;
  label: string;
  detail: string | ((context: SlashCommandContext) => string);
  aliases?: string[];
};

export type SlashCommandContext = {
  model: string;
  reasoningEffort: ReasoningEffort;
  responseSpeed: ResponseSpeed;
  approvalMode: ApprovalMode;
  petVisible: boolean;
  runtime?: "codex" | "claude-code";
};

export type ComposerSuggestion = {
  id: string;
  label: string;
  detail: string;
  kind: "skill" | "command" | "mcp";
  command?: SlashCommandId;
  token?: string;
};

const reasoningLabels: Record<ReasoningEffort, string> = {
  low: "낮음",
  medium: "중간",
  high: "높음",
  xhigh: "매우 높음",
};

const commands: SlashCommand[] = [
  { id: "mcp", label: "MCP", detail: "MCP 서버 상태 보기", aliases: ["server", "tool"] },
  { id: "fast", label: "고속", detail: ({ responseSpeed }) => responseSpeed === "fast" ? "고속을 끄고 표준 속도로 돌아갑니다" : "고속 응답을 켭니다", aliases: ["speed", "빠름"] },
  { id: "memory", label: "메모리", detail: "생성: 현재 대화에서 기억할 내용을 정리합니다", aliases: ["remember", "메모"] },
  { id: "model", label: "모델", detail: ({ model }) => model, aliases: ["provider"] },
  { id: "goal", label: "목표", detail: "Codex가 계속 달성해 나갈 목표를 설정합니다", aliases: ["target"] },
  { id: "side", label: "사이드", detail: "임시 보조에서 별도 대화를 시작합니다", aliases: ["side-chat", "sub"] },
  { id: "status", label: "상태", detail: "채팅 ID, 컨텍스트 사용량, 속도 제한을 표시합니다", aliases: ["info"] },
  { id: "settings", label: "설정", detail: "Codex 응답 방식을 선택합니다", aliases: ["config"] },
  { id: "compact", label: "압축", detail: "이 스레드의 컨텍스트를 압축해줘", aliases: ["compress"] },
  { id: "init", label: "초기화", detail: "Codex용 지침이 담긴 AGENTS.md 파일을 작성합니다", aliases: ["agents"] },
  { id: "reasoning", label: "추론 수준", detail: ({ reasoningEffort }) => reasoningLabels[reasoningEffort], aliases: ["effort", "think"] },
  { id: "review", label: "코드 검토", detail: "스테이징되지 않은 변경 사항을 검토하거나 브랜치와 비교합니다", aliases: ["code-review"] },
  { id: "pet", label: "펫", detail: ({ petVisible }) => petVisible ? "데스크톱 펫 숨기기" : "데스크톱 펫 깨우기", aliases: ["buddy"] },
  { id: "fork", label: "포크", detail: "이 채팅을 로컬 또는 새 워크트리로 포크합니다", aliases: ["copy"] },
  { id: "plan", label: "플랜 모드", detail: ({ approvalMode }) => approvalMode === "full" ? "플랜 모드 켜기 · 전체 접근 승인 사용 중" : "플랜 모드 켜기", aliases: ["planning"] },
  { id: "feedback", label: "피드백", detail: "이 채팅에 대한 피드백 보내기", aliases: ["bug"] },
];

export function suggestionsFor(sigil: "$" | "/", query: string, skills: Array<{ name: string; description: string }>, context: SlashCommandContext, mcpServers: McpServerInfo[] = []): ComposerSuggestion[] {
  const normalized = query.toLowerCase();
  const skillItems = skills.filter((skill) => skill.name.toLowerCase().includes(normalized)).map((skill) => ({ id: `skill:${skill.name}`, label: sigil === "$" ? `$${skill.name}` : `/${skill.name}`, detail: skill.description || "스킬", kind: "skill" as const }));
  if (sigil === "$") return skillItems;
  const mcpItems = mcpServers
    .filter((server) => {
      if (!normalized) return true;
      return [server.name, server.authStatus, ...server.tools.flatMap((tool) => [tool.name, tool.title, tool.description])].some((part) => part.toLowerCase().includes(normalized));
    })
    .map((server) => ({
      id: `mcp:${server.name}`,
      label: `/${server.name}`,
      detail: `${server.tools.length}개 도구 · ${server.authStatus === "authenticated" || server.authStatus === "unsupported" ? "연결됨" : server.authStatus || "연결됨"}`,
      kind: "mcp" as const,
      token: `mcp:${server.name}`,
    }));
  // Claude Code turns skip Codex-only controls (fast/reasoning/compact/fork/
  // side/mcp/feedback); prompt-based and runtime-agnostic commands stay.
  const commandSource = context.runtime === "claude-code"
    ? commands.filter((command) => ["goal", "plan", "status", "model", "settings", "memory", "init", "review", "pet"].includes(command.id))
    : commands;
  const commandItems = commandSource
    .filter((command) => {
      if (!normalized) return true;
      return [command.id, command.label, command.detail instanceof Function ? "" : command.detail, ...(command.aliases ?? [])].some((part) => part.toLowerCase().includes(normalized));
    })
    .map((command) => ({
      id: `command:${command.id}`,
      label: command.label,
      detail: command.detail instanceof Function ? command.detail(context) : command.detail,
      kind: "command" as const,
      command: command.id,
    }));
  return [...commandItems, ...mcpItems, ...skillItems];
}

export function ComposerSuggestions({ items, activeIndex, position, onSelect }: { items: ComposerSuggestion[]; activeIndex: number; position: CaretPosition; onSelect: (item: ComposerSuggestion) => void }): React.JSX.Element {
  return createPortal(<motion.div className="composer-suggestions" style={{ left: position.left, top: position.top }} initial={{ opacity: 0, scale: .98, y: -3 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: -2 }} role="listbox">
    {items.map((item, index) => <button type="button" className={index === activeIndex ? "active" : ""} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(item)} role="option" aria-selected={index === activeIndex}>{iconFor(item)}<span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}
  </motion.div>, document.body);
}

function iconFor(item: ComposerSuggestion): React.JSX.Element {
  if (item.kind === "skill") return <Cuboid size={16} />;
  if (item.kind === "mcp") return <PlugIcon />;
  switch (item.command) {
    case "mcp": return <Package size={16} />;
    case "fast": return <FastForward size={16} />;
    case "memory": return <Box size={16} />;
    case "model": return <SlidersHorizontal size={16} />;
    case "goal": return <Target size={16} />;
    case "side": return <MessageSquarePlus size={16} />;
    case "status": return <Flag size={16} />;
    case "settings": return <Settings size={16} />;
    case "compact": return <RefreshCcw size={16} />;
    case "init": return <Code2 size={16} />;
    case "reasoning": return <Brain size={16} />;
    case "review": return <Zap size={16} />;
    case "pet": return <Bot size={16} />;
    case "fork": return <GitFork size={16} />;
    case "plan": return <PanelRight size={16} />;
    case "feedback": return <Heart size={16} />;
    default: return <Command size={16} />;
  }
}

function PlugIcon(): React.JSX.Element {
  return <Package size={16} />;
}
