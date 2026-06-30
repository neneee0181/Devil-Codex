import { useCallback, useEffect, useState } from "react";
import type { ProviderRequestLogEntry, ProviderUsageReport } from "../../shared/contracts";

interface RefreshOptions { quiet?: boolean; }

export function useProviderUsage(active: boolean): {
  report: ProviderUsageReport | null;
  requestLog: ProviderRequestLogEntry[];
  state: "idle" | "loading" | "ready" | "error";
  refresh: () => Promise<void>;
} {
  const [report, setReport] = useState<ProviderUsageReport | null>(null);
  const [requestLog, setRequestLog] = useState<ProviderRequestLogEntry[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const refresh = useCallback(async (options: RefreshOptions = {}): Promise<void> => {
    if (!options.quiet) setState("loading");
    try {
      const [nextReport, nextLog] = await Promise.all([
        window.devilCodex.providerUsage(),
        window.devilCodex.providerRequestLog(),
      ]);
      setReport(nextReport);
      setRequestLog(nextLog);
      setState("ready");
    } catch {
      setState((current) => options.quiet && current !== "idle" ? current : "error");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return undefined;
    const rerun = (): void => { void refresh(); };
    const dispose = window.devilCodex.onProviderAuth(rerun);
    window.addEventListener("focus", rerun);
    window.addEventListener("devil-codex:provider-auth-changed", rerun);
    return () => {
      dispose();
      window.removeEventListener("focus", rerun);
      window.removeEventListener("devil-codex:provider-auth-changed", rerun);
    };
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return undefined;
    let timer: number | undefined;
    const rerun = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refresh({ quiet: true });
      }, 150);
    };
    const dispose = window.devilCodex.onProviderUsageChanged(rerun);
    return () => {
      dispose();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, refresh]);

  const manualRefresh = useCallback(() => refresh(), [refresh]);

  return { report, requestLog, state, refresh: manualRefresh };
}
