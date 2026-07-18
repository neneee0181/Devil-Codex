type ParsedVersion = {
  core: [number, number, number];
  prerelease?: string;
  build?: string;
};

function parsedVersion(value: string): ParsedVersion | undefined {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { prerelease: match[4] } : {}),
    ...(match[5] ? { build: match[5] } : {}),
  };
}

function compareVersionNames(left: string, right: string): number {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  if (a && !b) return 1;
  if (!a && b) return -1;
  if (!a || !b) return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
  for (let index = 0; index < a.core.length; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference) return difference;
  }
  if (a.prerelease !== b.prerelease) {
    if (!a.prerelease) return 1;
    if (!b.prerelease) return -1;
    return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true, sensitivity: "base" });
  }
  return (a.build ?? "").localeCompare(b.build ?? "", "en", { numeric: true, sensitivity: "base" });
}

export function latestPluginVersionName(versions: readonly string[]): string | undefined {
  return versions.reduce<string | undefined>((latest, candidate) => (
    latest === undefined || compareVersionNames(candidate, latest) > 0 ? candidate : latest
  ), undefined);
}
