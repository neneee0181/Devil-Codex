import { useCallback, useEffect, useState } from "react";
import type { ProviderRequestLogEntry, ProviderUsageReport } from "../../shared/contracts";

export function useProviderUsage(active: boolean): {
  report: ProviderUsageReport | null;
  requestLog: ProviderRequestLogEntry[];
  state: "idle" | "loading" | "ready" | "error";
  refresh: () => Promise<void>;
} {
  const [report, setReport] = useState<ProviderUsageReport | null>(null);
  const [requestLog, setRequestLog] = useState<ProviderRequestLogEntry[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const refresh = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const [nextReport, nextLog] = await Promise.all([
        window.devilCodex.providerUsage(),
        window.devilCodex.providerRequestLog(),
      ]);
      setReport(nextReport);
      setRequestLog(nextLog);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  return { report, requestLog, state, refresh };
}
