import assert from "node:assert/strict";
import test from "node:test";
import {
  identityFromKimiTokens,
  KIMI_CLIENT_ID,
  KIMI_CODE_BASE_URL,
  KIMI_DEFAULT_OAUTH_HOST,
  kimiCommonHeaders,
  kimiStorageBackendAllowsWrite,
  matchingKimiAccountId,
  parseKimiDeviceAuthorization,
  parseKimiModelsPayload,
  parseKimiTokenPayload,
} from "./provider-kimi.cjs";
import { kimiUsageWindows } from "./provider-usage.cjs";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("Kimi constants and device identity match Kimi Code CLI", () => {
  assert.equal(KIMI_CLIENT_ID, "17e5f671-d194-4dfb-9706-5516cb48c098");
  assert.equal(KIMI_DEFAULT_OAUTH_HOST, "https://auth.kimi.com");
  assert.equal(KIMI_CODE_BASE_URL, "https://api.kimi.com/coding/v1");
  assert.deepEqual(kimiCommonHeaders({
    platform: "win32",
    release: "10.0.26100",
    arch: "x64",
    hostname: "DEVBOX",
    osVersion: "Windows 11 Pro",
    deviceId: "abc123",
  }), {
    "User-Agent": "KimiCLI/0.14.0",
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": "0.14.0",
    "X-Msh-Device-Name": "DEVBOX",
    "X-Msh-Device-Model": "Windows 10.0.26100 x64",
    "X-Msh-Os-Version": "Windows 11 Pro",
    "X-Msh-Device-Id": "abc123",
  });
  assert.equal(kimiStorageBackendAllowsWrite("linux", "basic_text"), false);
  assert.equal(kimiStorageBackendAllowsWrite("linux", "gnome_libsecret"), true);
  assert.equal(kimiStorageBackendAllowsWrite("win32", "basic_text"), true);
});

test("Kimi identity prefers user_id across tokens and normalizes email", () => {
  const access = jwt({ sub: "weak-access", email: "USER@Example.COM" });
  const refresh = jwt({ user_id: "strong-refresh", sub: "weak-refresh" });
  assert.deepEqual(identityFromKimiTokens(access, refresh), {
    accountId: "strong-refresh",
    email: "user@example.com",
  });
  assert.deepEqual(identityFromKimiTokens("not-a-jwt", jwt({ sub: "fallback" })), { accountId: "fallback" });
});

test("Kimi multiauth prioritizes user IDs and only email-matches weak identities", () => {
  const account = (id: string, userId?: string, email?: string) => ({
    id,
    provider: "kimi" as const,
    label: id,
    userId,
    email,
    credentialSource: "keychain" as const,
    credentialKind: "oauth" as const,
  });
  assert.equal(matchingKimiAccountId([account("a", "user-a"), account("b", "user-b")], { userId: "user-b" }), "b");
  assert.equal(matchingKimiAccountId([account("legacy")], { userId: "identified" }), "legacy");
  assert.equal(matchingKimiAccountId([account("active"), account("sibling", "user-b")], {}), "active");
  assert.equal(matchingKimiAccountId([account("a", "user-a")], { userId: "new-user" }), undefined);
  assert.equal(matchingKimiAccountId([
    account("a", "user-a", "same@example.com"),
    account("b", "user-b", "same@example.com"),
  ], { userId: "user-c", email: "same@example.com" }), undefined);
  assert.equal(matchingKimiAccountId([
    account("legacy-email", undefined, "same@example.com"),
    account("a", "user-a", "same@example.com"),
  ], { userId: "user-c", email: "same@example.com" }), "legacy-email");
});

test("Kimi token and device parsers preserve refresh rotation and server timing", () => {
  const now = 10_000_000;
  const access = jwt({ user_id: "user-1", email: "A@B.COM" });
  assert.deepEqual(parseKimiTokenPayload({ access_token: access, expires_in: 3600 }, "refresh-1", now), {
    accessToken: access,
    refreshToken: "refresh-1",
    expiresAt: now + 3_600_000 - 300_000,
    email: "a@b.com",
    userId: "user-1",
  });
  assert.throws(() => parseKimiTokenPayload({ access_token: "access", expires_in: 3600 }), /missing refresh token/);

  assert.deepEqual(parseKimiDeviceAuthorization({
    user_code: "ABCD-EFGH",
    device_code: "device-token",
    verification_uri: "https://www.kimi.com/device",
    verification_uri_complete: "https://www.kimi.com/device?code=ABCD-EFGH",
    expires_in: 600,
    interval: 7,
  }), {
    userCode: "ABCD-EFGH",
    deviceCode: "device-token",
    verificationUri: "https://www.kimi.com/device?code=ABCD-EFGH",
    expiresIn: 600,
    interval: 7,
  });
});

test("Kimi model parser accepts OpenAI model catalogs and removes duplicates", () => {
  assert.deepEqual(parseKimiModelsPayload({ data: [
    { id: "k3", display_name: "Kimi K3" },
    { id: "k3", display_name: "duplicate" },
    { id: "kimi-k2.7-code", name: "Kimi Code" },
    { id: "" },
  ] }), [
    { id: "k3", label: "Kimi K3" },
    { id: "kimi-k2.7-code", label: "Kimi Code" },
  ]);
});

test("Kimi usage parser reads subscription windows from the nested quota envelope", () => {
  const resetAt = 1_800_000_000_000;
  assert.deepEqual(kimiUsageWindows({ data: {
    limits: [
      { name: "5 hour", detail: { limit: 100, used: 25 }, window: { duration: 5, timeUnit: "HOUR", resetAt } },
      { name: "weekly", detail: { limit: 1_000, remaining: 700 }, window: { duration: 7, timeUnit: "DAY" } },
    ],
    totalQuota: { limit: 500, used: 100 },
  } }), [
    { label: "5시간", usedPercent: 25, remainingPercent: 75, resetsAt: resetAt },
    { label: "7일", usedPercent: 30, remainingPercent: 70, resetsAt: null },
    { label: "구독 크레딧", usedPercent: 20, remainingPercent: 80, resetsAt: null },
  ]);
});
