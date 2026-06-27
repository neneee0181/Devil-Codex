import type { DevilCodexApi } from "../shared/contracts";

declare global {
  interface Window {
    devilCodex: DevilCodexApi;
  }
}

export {};
