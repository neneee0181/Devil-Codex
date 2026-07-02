import { useCallback, useEffect, useState } from "react";
import type { ProviderRequestLogEntry, ProviderUsageReport } from "../../shared/contracts";

interface RefreshOptions { quiet?: boolean; force?: boolean; }

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
        window.devilCodex.providerUsage({ force: options.force }),
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
    void refresh({ force: true });
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
    const rerun = (event?: { completed?: boolean }): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refresh({ quiet: true, force: Boolean(event?.completed) });
      }, 150);
    };
    const dispose = window.devilCodex.onProviderUsageChanged(rerun);
    const forceRerun = (): void => rerun({ completed: true });
    window.addEventListener("devil-codex:provider-usage-refresh", forceRerun);
    return () => {
      dispose();
      window.removeEventListener("devil-codex:provider-usage-refresh", forceRerun);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, refresh]);

  const manualRefresh = useCallback(() => refresh({ force: true }), [refresh]);

  return { report, requestLog, state, refresh: manualRefresh };
}
