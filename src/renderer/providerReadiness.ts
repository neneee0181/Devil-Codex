import type { ProviderAccount, ProviderInfo } from "../shared/contracts";

export function providerAccountModelCount(provider: ProviderInfo, account: ProviderAccount): number {
  return account.models?.length ?? provider.models.length;
}

export function providerAccountReady(provider: ProviderInfo, account: ProviderAccount): boolean {
  const hasModels = providerAccountModelCount(provider, account) > 0;
  if (provider.id === "opencode-free") return hasModels;
  // useProviders deliberately clears the provider-level flag on every fresh
  // settings load. A local endpoint becomes selectable only after its model
  // refresh succeeds in this renderer session, not merely because an older
  // cached account model list still exists on disk.
  if (account.credentialKind === "local") return Boolean(provider.modelsLoaded && account.modelsLoaded) && hasModels;
  return account.credentialSource !== "none" && hasModels;
}

export function selectableApiProvider(provider: ProviderInfo): boolean {
  return provider.kind === "apikey" && provider.accounts.some((account) => providerAccountReady(provider, account));
}
