import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticLogger, sanitizeDiagnosticValue } from "./diagnostic-log.cjs";

test("diagnostic sanitizer removes credentials and binary payloads without hiding counters", () => {
  const proxySecret = "a".repeat(64);
  const legacyProxySecret = "b".repeat(32);
  const inlineBase64 = Buffer.alloc(768, 11).toString("base64");
  const value = {
    Authorization: "Bearer bearer-secret-value-123456789",
    nested: {
      apiKey: "sk-test-secret-123456789012345",
      token: "generic-token-secret",
      "x-goog-api-key": "AIzaGoogleSecretValue123456789012345",
      "x-auth-token": "auth-header-secret",
      "x-oai-attestation": "attestation-secret-value",
      AWS_SECRET_ACCESS_KEY: "aws-secret-value",
      private_key: "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
      rawJson: JSON.stringify({ inline_data: { data: inlineBase64 }, secret: "raw-json-secret" }),
      access_token: "ya29.oauth-secret-value-123456789012345",
      Cookie: "session=private-cookie",
      inputTokens: 135304,
      outputTokens: 3,
      finishReason: "STOP",
      dataUrl: `data:image/png;base64,${Buffer.alloc(512, 7).toString("base64")}`,
      url: `https://user:password@example.test/path?code=oauth-code-secret&key=query-secret-value http://127.0.0.1:49873/${proxySecret}/stock/v1/responses http://127.0.0.1:49873/${legacyProxySecret}/v1/responses`,
    },
  };
  const serialized = JSON.stringify(sanitizeDiagnosticValue(value));
  for (const secret of ["bearer-secret", "sk-test-secret", "generic-token-secret", "GoogleSecret", "auth-header-secret", "attestation-secret", "aws-secret-value", "private-material", "raw-json-secret", inlineBase64.slice(0, 80), "oauth-secret", "oauth-code-secret", "private-cookie", "password@example", proxySecret, legacyProxySecret, "query-secret-value"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(serialized, /data-url omitted/);
  assert.match(serialized, /"inputTokens":135304/);
  assert.match(serialized, /"outputTokens":3/);
  assert.match(serialized, /"finishReason":"STOP"/);
});

test("diagnostic logger writes parseable serialized JSONL with restrictive permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devil-diagnostics-"));
  try {
    const logger = new DiagnosticLogger({ directory, role: "desktop-main", sessionId: "session-test" });
    await writeFile(logger.activePath("app"), "", { mode: 0o666 });
    await chmod(logger.activePath("app"), 0o666);
    const circular: Record<string, unknown> = { label: "root" };
    circular.self = circular;
    const cause = new Error("Bearer error-secret-123456789");
    const error = new Error("top-level failure", { cause });
    for (let index = 0; index < 30; index += 1) {
      logger.log("app", "concurrent.event", { index, line: "one\ntwo", circular, error, bigint: 10n }, { requestId: `request-${index}` });
    }
    await logger.flush();
    const path = logger.activePath("app");
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 30);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(records.map((record) => record.sequence), Array.from({ length: 30 }, (_value, index) => index + 1));
    assert.equal(new Set(records.map((record) => record.requestId)).size, 30);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(lines.some((line) => line.includes("error-secret")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic logger chunks oversized sanitized records and rotates role-specific files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devil-diagnostics-"));
  try {
    const desktop = new DiagnosticLogger({ directory, role: "desktop-main", maxFileBytes: 4_096, maxFiles: 3, maxRecordBytes: 2_048, sessionId: "desktop" });
    const stock = new DiagnosticLogger({ directory, role: "stock-bridge", maxFileBytes: 4_096, maxFiles: 3, maxRecordBytes: 2_048, sessionId: "stock" });
    desktop.log("bridge", "large.request", { body: `${"한글🙂".repeat(350)} Bearer enormous-secret-123456789012345` }, { requestId: "large-request" });
    for (let index = 0; index < 24; index += 1) stock.log("bridge", "rotate.event", { index, text: "x".repeat(700) }, { requestId: `stock-${index}` });
    await Promise.all([desktop.flush(), stock.flush()]);

    const names = await readdir(directory);
    const desktopFiles = names.filter((name) => name.startsWith("bridge-desktop-main-"));
    const stockFiles = names.filter((name) => name.startsWith("bridge-stock-bridge-"));
    assert.ok(desktopFiles.length >= 1 && desktopFiles.length <= 3);
    assert.ok(stockFiles.length >= 2 && stockFiles.length <= 3);

    const desktopLines = (await Promise.all(desktopFiles.map((name) => readFile(join(directory, name), "utf8"))))
      .join("").trim().split("\n").filter(Boolean);
    assert.ok(desktopLines.every((line) => Buffer.byteLength(line) <= 2_048));
    const desktopRecords = desktopLines.map((line) => JSON.parse(line) as { chunk?: { index?: number; count?: number; data?: string; sha256?: string } });
    const chunks = desktopRecords.flatMap((record) => record.chunk?.data ? [record.chunk] : []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    assert.ok(chunks.length > 1);
    assert.equal(chunks.length, chunks[0]?.count);
    assert.deepEqual(chunks.map((chunk) => chunk.index), Array.from({ length: chunks.length }, (_value, index) => index));
    const decoded = chunks.map((chunk) => Buffer.from(chunk.data!, "base64"));
    const reconstructed = Buffer.concat(decoded).toString("utf8");
    assert.equal(reconstructed.includes("enormous-secret"), false);
    assert.doesNotThrow(() => JSON.parse(reconstructed));

    for (const name of stockFiles) {
      const lines = (await readFile(join(directory, name), "utf8")).trim().split("\n").filter(Boolean);
      for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic logger reports filesystem write failures from flush", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devil-diagnostics-"));
  try {
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "blocked");
    const logger = new DiagnosticLogger({ directory: blocked, role: "desktop-main" });
    logger.log("app", "write.failure", { value: 1 });
    await assert.rejects(() => logger.flush(), /ENOTDIR|EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
