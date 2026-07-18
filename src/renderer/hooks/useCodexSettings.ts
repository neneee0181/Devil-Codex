import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexSettings } from "../../shared/contracts";

export type CodexSettingsSaveState = "loading" | "saved" | "error";
export type CodexSettingsSaveResult = { ok: true; settings: CodexSettings } | { ok: false; error: string };
export type CodexSettingsController = {
  settings: CodexSettings | null;
  state: CodexSettingsSaveState;
  error: string;
  save: (settings: CodexSettings) => Promise<CodexSettingsSaveResult>;
  reload: () => void;
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "").trim() || "알 수 없는 오류";
}

export function useCodexSettings(): CodexSettingsController {
  const [settings, setSettings] = useState<CodexSettings | null>(null);
  const [state, setState] = useState<CodexSettingsSaveState>("loading");
  const [error, setError] = useState("");
  const latestSave = useRef(0);
  const pendingSaves = useRef(0);

  const commitSettings = useCallback((value: CodexSettings): void => {
    setSettings(value);
  }, []);

  const reload = useCallback(() => {
    setState("loading");
    setError("");
    void window.devilCodex.loadCodexSettings()
      .then((value) => { commitSettings(value); setState("saved"); })
      .catch((reason) => { setError(errorMessage(reason)); setState("error"); });
  }, [commitSettings]);

  useEffect(() => {
    reload();
    const disposeSettingsChanged = window.devilCodex.onSettingsChanged((value) => {
      // A settings transaction emits its authoritative result immediately
      // before the matching invoke resolves. Let the latest save promise own
      // that state so an older completion cannot overwrite a newer click.
      if (pendingSaves.current > 0) return;
      commitSettings(value);
      setError("");
      setState("saved");
    });
    return disposeSettingsChanged;
  }, [commitSettings, reload]);

  const save = useCallback(async (next: CodexSettings): Promise<CodexSettingsSaveResult> => {
    const saveId = ++latestSave.current;
    pendingSaves.current += 1;
    commitSettings(next);
    setError("");
    setState("loading");
    try {
      const saved = await window.devilCodex.saveCodexSettings(next);
      if (saveId === latestSave.current) {
        commitSettings(saved);
        setState("saved");
      }
      return { ok: true, settings: saved };
    } catch (reason) {
      const message = errorMessage(reason);
      if (saveId === latestSave.current) {
        const restored = await window.devilCodex.loadCodexSettings().catch(() => null);
        if (restored) commitSettings(restored);
        setError(message);
        setState("error");
      }
      return { ok: false, error: message };
    } finally {
      pendingSaves.current = Math.max(0, pendingSaves.current - 1);
    }
  }, [commitSettings]);

  return { settings, state, error, save, reload };
}
