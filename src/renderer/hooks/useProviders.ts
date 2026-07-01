import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderId, ProviderModel, ProviderSettings } from "../../shared/contracts";

export function useProviders(): {
  settings: ProviderSettings | null;
  state: "loading" | "saved" | "error";
  select: (input: { provider: ProviderId; accountId?: string; model: string }) => Promise<void>;
  saveKey: (input: { provider: ProviderId; key: string; accountId?: string; label?: string }) => Promise<void>;
  clearKey: (provider: ProviderId, accountId?: string) => Promise<void>;
  refreshModels: (provider: Exclude<ProviderId, "codex">, accountId?: string) => Promise<void>;
} {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [codexModels, setCodexModels] = useState<ProviderModel[]>([]);
  const [oauthModels, setOauthModels] = useState<Record<string, ProviderModel[]>>({});
  const [state, setState] = useState<"loading" | "saved" | "error">("loading");

  const hideUnverifiedLocalProviders = useCallback((value: ProviderSettings): ProviderSettings => ({
    ...value,
    providers: value.providers.map((provider) => provider.kind === "apikey" && !provider.keyRequired ? { ...provider, modelsLoaded: false } : provider),
  }), []);

  const run = useCallback(async (request: () => Promise<ProviderSettings>): Promise<void> => {
    setState("loading");
    try { setSettings(await request()); setState("saved"); }
    catch { setState("error"); }
  }, []);

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

  useEffect(() => {
    void (async () => {
      setState("loading");
      try {
        const loaded = await window.devilCodex.loadProviderSettings();
        setSettings(hideUnverifiedLocalProviders(loaded));
        setState("saved");
        window.devilCodex.listCodexModels().then((models) => { if (models.length) setCodexModels(models); }).catch(() => undefined);
        syncOauthModels(loaded);
        for (const provider of loaded.providers) {
          if (provider.kind === "apikey" && (!provider.keyRequired || provider.credentialSource !== "none")) {
            const accounts = provider.accounts.length ? provider.accounts : [undefined];
            accounts.forEach((account) => window.devilCodex.refreshProviderModels({ provider: provider.id as Exclude<ProviderId, "codex">, accountId: account?.id })
              .then(setSettings)
              .catch(() => window.devilCodex.loadProviderSettings().then((next) => setSettings(hideUnverifiedLocalProviders(next))).catch(() => undefined)));
          }
        }
      } catch { setState("error"); }
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
    return dispose;
  }, [hideUnverifiedLocalProviders, syncOauthModels]);

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
    select: async (input) => {
      setSettings((current) => current ? { ...current, provider: input.provider, accountId: input.accountId, model: input.model } : current);
      await run(() => window.devilCodex.selectProvider(input));
    },
    saveKey: (input) => run(() => window.devilCodex.saveProviderKey(input)),
    clearKey: (provider, accountId) => run(() => window.devilCodex.clearProviderKey({ provider, accountId })),
    refreshModels: (provider, accountId) => run(() => window.devilCodex.refreshProviderModels({ provider, accountId })),
  };
}
