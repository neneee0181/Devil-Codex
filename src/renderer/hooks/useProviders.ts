import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderId, ProviderModel, ProviderSettings } from "../../shared/contracts";

export function useProviders(): {
  settings: ProviderSettings | null;
  state: "loading" | "saved" | "error";
  select: (input: { provider: ProviderId; model: string }) => Promise<void>;
  saveKey: (input: { provider: ProviderId; key: string }) => Promise<void>;
  clearKey: (provider: ProviderId) => Promise<void>;
  refreshModels: (provider: Exclude<ProviderId, "codex">) => Promise<void>;
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

  const syncOauthModels = useCallback((): void => {
    (["copilot", "claude-code"] as const).forEach((provider) => {
      window.devilCodex.providerOauthModels({ provider }).then((models) => {
        setOauthModels((prev) => {
          const next = { ...prev };
          if (models.length) next[provider] = models;
          else delete next[provider];
          return next;
        });
      }).catch(() => setOauthModels((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      }));
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
        syncOauthModels();
        for (const provider of loaded.providers) {
          if (provider.kind === "apikey" && (!provider.keyRequired || provider.credentialSource !== "none")) {
            window.devilCodex.refreshProviderModels({ provider: provider.id as Exclude<ProviderId, "codex"> })
              .then(setSettings)
              .catch(() => window.devilCodex.loadProviderSettings().then((next) => setSettings(hideUnverifiedLocalProviders(next))).catch(() => undefined));
          }
        }
      } catch { setState("error"); }
    })();
    const dispose = window.devilCodex.onProviderAuth((status) => {
      setOauthModels((prev) => {
        const next = { ...prev };
        if (!status.copilot) delete next.copilot;
        if (!status.claude) delete next["claude-code"];
        return next;
      });
      syncOauthModels();
    });
    return dispose;
  }, [hideUnverifiedLocalProviders, syncOauthModels]);

  const merged = useMemo<ProviderSettings | null>(() => {
    if (!settings) return null;
    return {
      ...settings,
      providers: settings.providers.map((provider) => {
        if (provider.id === "codex" && codexModels.length) return { ...provider, models: codexModels, modelsLoaded: true };
        const live = oauthModels[provider.id];
        if (live?.length) return { ...provider, models: live, modelsLoaded: true };
        return provider;
      }),
    };
  }, [settings, codexModels, oauthModels]);

  return {
    settings: merged,
    state,
    select: async (input) => {
      setSettings((current) => current ? { ...current, provider: input.provider, model: input.model } : current);
      await run(() => window.devilCodex.selectProvider(input));
    },
    saveKey: (input) => run(() => window.devilCodex.saveProviderKey(input)),
    clearKey: (provider) => run(() => window.devilCodex.clearProviderKey({ provider })),
    refreshModels: (provider) => run(() => window.devilCodex.refreshProviderModels({ provider })),
  };
}
