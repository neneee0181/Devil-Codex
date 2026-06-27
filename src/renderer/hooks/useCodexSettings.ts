import { useCallback, useEffect, useState } from "react";
import type { CodexSettings } from "../../shared/contracts";

export function useCodexSettings(): { settings: CodexSettings | null; state: "loading" | "saved" | "error"; save: (settings: CodexSettings) => void; reload: () => void } {
  const [settings, setSettings] = useState<CodexSettings | null>(null);
  const [state, setState] = useState<"loading" | "saved" | "error">("loading");
  const reload = useCallback(() => { void window.devilCodex.loadCodexSettings().then((value) => { setSettings(value); setState("saved"); }).catch(() => setState("error")); }, []);
  useEffect(() => { reload(); }, [reload]);
  const save = useCallback((next: CodexSettings) => { setSettings(next); setState("loading"); void window.devilCodex.saveCodexSettings(next).then(() => setState("saved")).catch(() => setState("error")); }, []);
  return { settings, state, save, reload };
}
