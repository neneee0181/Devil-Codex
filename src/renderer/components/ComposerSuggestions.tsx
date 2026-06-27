import { motion } from "motion/react";
import { createPortal } from "react-dom";
import { Command, Cuboid } from "lucide-react";
import type { CaretPosition } from "./composerCaret";

export type ComposerSuggestion = {
  id: string;
  label: string;
  detail: string;
  kind: "skill" | "command";
};

const commands = ["feedback", "goal", "init", "mcp", "plan", "review", "status"];

export function suggestionsFor(sigil: "$" | "/", query: string, skills: Array<{ name: string; description: string }>): ComposerSuggestion[] {
  const normalized = query.toLowerCase();
  const skillItems = skills.filter((skill) => skill.name.toLowerCase().includes(normalized)).map((skill) => ({ id: `skill:${skill.name}`, label: sigil === "$" ? `$${skill.name}` : `/${skill.name}`, detail: skill.description || "스킬", kind: "skill" as const }));
  if (sigil === "$") return skillItems;
  const commandItems = commands.filter((name) => name.includes(normalized)).map((name) => ({ id: `command:${name}`, label: `/${name}`, detail: "명령", kind: "command" as const }));
  return [...skillItems, ...commandItems];
}

export function ComposerSuggestions({ items, activeIndex, position, onSelect }: { items: ComposerSuggestion[]; activeIndex: number; position: CaretPosition; onSelect: (item: ComposerSuggestion) => void }): React.JSX.Element {
  return createPortal(<motion.div className="composer-suggestions" style={{ left: position.left, top: position.top }} initial={{ opacity: 0, scale: .98, y: -3 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: -2 }} role="listbox">
    {items.map((item, index) => <button type="button" className={index === activeIndex ? "active" : ""} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(item)} role="option" aria-selected={index === activeIndex}>{item.kind === "skill" ? <Cuboid size={16} /> : <Command size={16} />}<span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}
  </motion.div>, document.body);
}
