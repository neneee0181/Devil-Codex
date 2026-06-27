import { Cuboid } from "lucide-react";

function displayName(skill: string): string {
  const [namespace, name] = skill.split(":", 2);
  const words = (name ?? namespace).split(/[-_]/).filter(Boolean).map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`);
  return namespace === name || !name ? words.join(" ") : `${namespace[0]?.toUpperCase() ?? ""}${namespace.slice(1)} · ${words.join(" ")}`;
}

export function splitSkillTokens(text: string): { skills: string[]; text: string } {
  const match = text.match(/^((?:\$[\w:-]+[ \t]*)+)(?:\r?\n)?/);
  if (!match) return { skills: [], text };
  return { skills: [...match[1].matchAll(/\$([\w:-]+)/g)].map((item) => item[1]), text: text.slice(match[0].length) };
}

export function SkillTokens({ skills }: { skills: string[] }): React.JSX.Element | null {
  if (skills.length === 0) return null;
  return <div className="message-skill-tokens">{skills.map((skill) => <span key={skill} title={`사용한 스킬: ${skill}`}><Cuboid size={16} />{displayName(skill)}</span>)}</div>;
}
