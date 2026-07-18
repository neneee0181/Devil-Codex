import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderId, ProviderModel, ProviderSettings } from "../../shared/contracts";

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "").trim() || "알 수 없는 오류";
}

export function useProviders(): {
  settings: ProviderSettings | null;
  state: "loading" | "saved" | "error";
  error: string;
  select: (input: { provider: ProviderId; accountId?: string; model: string }) => Promise<void>;
  saveKey: (input: { provider: ProviderId; key: string; accountId?: string; label?: string }) => Promise<void>;
  clearKey: (provider: ProviderId, accountId?: string) => Promise<void>;
  refreshModels: (provider: Exclude<ProviderId, "codex">, accountId?: string) => Promise<void>;
} {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [codexModels, setCodexModels] = useState<ProviderModel[]>([]);
  const [oauthModels, setOauthModels] = useState<Record<string, ProviderModel[]>>({});
  const [state, setState] = useState<"loading" | "saved" | "error">("loading");
  const [error, setError] = useState("");

  const hideUnverifiedLocalProviders = useCallback((value: ProviderSettings): ProviderSettings => ({
    ...value,
    providers: value.providers.map((provider) => provider.kind === "apikey" && !provider.keyRequired ? { ...provider, modelsLoaded: false } : provider),
  }), []);

  const loadVisibleSettings = useCallback(async (): Promise<ProviderSettings> => hideUnverifiedLocalProviders(await window.devilCodex.loadProviderSettings()), [hideUnverifiedLocalProviders]);

  const run = useCallback(async (request: () => Promise<ProviderSettings>): Promise<void> => {
    setError("");
    setState("loading");
    try {
      setSettings(await request());
      setState("saved");
    } catch (reason) {
      const restored = await loadVisibleSettings().catch(() => null);
      if (restored) setSettings(restored);
      setError(errorMessage(reason));
      setState("error");
    }
  }, [loadVisibleSettings]);

  const accountCount = (source: ProviderSettings | null, provider: ProviderId): number => source?.providers.find((item) => item.id === provider)?.accounts.length ?? 0;

  const oauthModelKey = (provider: ProviderId, accountId: string): string => `${provider}:${accountId}`;
  const syncOauthModels = useCallback((source?: ProviderSettings | null): void => {
    (["copilot", "claude-code", "antigravity"] as const).forEach((provider) => {
      const accounts = source?.providers.find((item) => item.id === provider)?.accounts ?? [];
      accounts.forEach((account) => window.devilCodex.providerOauthModels({ provider, accountId: account.id }).then((models) => {
        setOauthModels((prev) => {
          const next = { ...prev };
          const key = oauthModelKey(provider, account.id);
          if (models.length) next[key] = models;
          else delete next[key];
          return next;
        });
      }).catch(() => setOauthModels((prev) => {
        const next = { ...prev };
        delete next[oauthModelKey(provider, account.id)];
        return next;
      })));
    });
  }, []);

  const refreshCodexModels = useCallback(async (): Promise<boolean> => {
    const models = await window.devilCodex.listCodexModels();
    if (!models.length) return false;
    setCodexModels(models);
    return true;
  }, []);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      setState("loading");
      setError("");
      try {
        const loaded = await window.devilCodex.loadProviderSettings();
        setSettings(hideUnverifiedLocalProviders(loaded));
        setState("saved");
        // The app-server can still be starting while provider settings load.
        // Retry discovery once so a temporary startup failure cannot leave the
        // native picker permanently limited to its static fallback list.
        refreshCodexModels().then((found) => {
          if (!found) retryTimer = setTimeout(() => { void refreshCodexModels().catch(() => undefined); }, 2_000);
        }).catch(() => {
          retryTimer = setTimeout(() => { void refreshCodexModels().catch(() => undefined); }, 2_000);
        });
        syncOauthModels(loaded);
        for (const provider of loaded.providers) {
          if (provider.kind === "apikey" && (!provider.keyRequired || provider.credentialSource !== "none")) {
            const accounts = provider.accounts.length ? provider.accounts : [undefined];
            accounts.forEach((account) => window.devilCodex.refreshProviderModels({ provider: provider.id as Exclude<ProviderId, "codex">, accountId: account?.id })
              .then(setSettings)
              .catch(() => window.devilCodex.loadProviderSettings().then((next) => setSettings(hideUnverifiedLocalProviders(next))).catch(() => undefined)));
          }
        }
      } catch (reason) {
        setError(errorMessage(reason));
        setState("error");
      }
    })();
    const dispose = window.devilCodex.onProviderAuth((status) => {
      setOauthModels((prev) => {
        const next = { ...prev };
        if (!status.copilot) for (const key of Object.keys(next)) if (key.startsWith("copilot:")) delete next[key];
        if (!status.claude) for (const key of Object.keys(next)) if (key.startsWith("claude-code:")) delete next[key];
        if (!status.antigravity) for (const key of Object.keys(next)) if (key.startsWith("antigravity:")) delete next[key];
        return next;
      });
      window.devilCodex.loadProviderSettings().then((next) => {
        const visible = hideUnverifiedLocalProviders(next);
        setSettings(visible);
        syncOauthModels(visible);
      }).catch(() => undefined);
    });
    const reloadProviderSettings = (): void => {
      window.devilCodex.loadProviderSettings().then((next) => {
        const visible = hideUnverifiedLocalProviders(next);
        setSettings(visible);
        syncOauthModels(visible);
      }).catch(() => undefined);
    };
    window.addEventListener("devil-codex:provider-auth-changed", reloadProviderSettings);
    return () => {
      dispose();
      window.removeEventListener("devil-codex:provider-auth-changed", reloadProviderSettings);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [hideUnverifiedLocalProviders, refreshCodexModels, syncOauthModels]);

  const merged = useMemo<ProviderSettings | null>(() => {
    if (!settings) return null;
    return {
      ...settings,
      providers: settings.providers.map((provider) => {
        if (provider.id === "codex" && codexModels.length) return { ...provider, models: codexModels, modelsLoaded: true };
        if (provider.kind === "login" && provider.id !== "codex") {
          const accounts = provider.accounts.map((account) => {
            const live = oauthModels[oauthModelKey(provider.id, account.id)];
            return live?.length ? { ...account, models: live, modelsLoaded: true } : account;
          });
          const activeAccount = accounts.find((account) => account.id === settings.accountId) ?? accounts[0];
          return { ...provider, accounts, models: activeAccount?.models?.length ? activeAccount.models : provider.models, modelsLoaded: Boolean(activeAccount?.modelsLoaded || provider.modelsLoaded) };
        }
        return provider;
      }),
    };
  }, [settings, codexModels, oauthModels]);

  return {
    settings: merged,
    state,
    error,
    select: async (input) => {
      const next: { provider: ProviderId; accountId?: string; model: string } = input.provider === "codex" ? { provider: input.provider, model: input.model } : input;
      setSettings((current) => current ? { ...current, provider: next.provider, accountId: next.accountId, model: next.model } : current);
      await run(() => window.devilCodex.selectProvider(next));
    },
    saveKey: async (input) => {
      const previousCount = accountCount(settings, input.provider);
      setState("loading");
      setError("");
      try {
        await window.devilCodex.saveProviderKey(input);
        setSettings(await loadVisibleSettings());
        setState("saved");
      } catch (reason) {
        const loaded = await loadVisibleSettings().catch(() => null);
        if (loaded && accountCount(loaded, input.provider) > previousCount) {
          setSettings(loaded);
          setState("saved");
          return;
        }
        setError(errorMessage(reason));
        setState("error");
      }
    },
    clearKey: (provider, accountId) => run(() => window.devilCodex.clearProviderKey({ provider, accountId })),
    refreshModels: (provider, accountId) => run(() => window.devilCodex.refreshProviderModels({ provider, accountId })),
  };
}
