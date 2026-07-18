import { useCallback, useEffect, useState } from "react";
import type { CodexSettings } from "../../shared/contracts";

export function useCodexSettings(): { settings: CodexSettings | null; state: "loading" | "saved" | "error"; save: (settings: CodexSettings) => void; reload: () => void } {
  const [settings, setSettings] = useState<CodexSettings | null>(null);
  const [state, setState] = useState<"loading" | "saved" | "error">("loading");
  const reload = useCallback(() => { void window.devilCodex.loadCodexSettings().then((value) => { setSettings(value); setState("saved"); }).catch(() => setState("error")); }, []);
  useEffect(() => {
    reload();
    const disposeSettingsChanged = window.devilCodex.onSettingsChanged((value) => {
      setSettings(value);
      setState("saved");
    });
    const onSettingsChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ key?: keyof CodexSettings; value?: unknown }>).detail;
      if (!detail?.key) return;
      setSettings((current) => current ? { ...current, [detail.key as keyof CodexSettings]: detail.value } as CodexSettings : current);
    };
    window.addEventListener("devil-codex:settings-changed", onSettingsChanged);
    return () => {
      disposeSettingsChanged();
      window.removeEventListener("devil-codex:settings-changed", onSettingsChanged);
    };
  }, [reload]);
  const save = useCallback((next: CodexSettings) => { setSettings(next); setState("loading"); void window.devilCodex.saveCodexSettings(next).then(() => setState("saved")).catch(() => setState("error")); }, []);
  return { settings, state, save, reload };
}
