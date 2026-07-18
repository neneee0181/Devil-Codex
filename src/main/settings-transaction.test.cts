import test from "node:test";
import assert from "node:assert/strict";
import { AsyncSerialQueue, persistAndApplyWithRollback } from "./settings-transaction.cjs";

test("settings transaction persists the previous snapshot and restores runtime after apply failure", async () => {
  const persisted: string[] = [];
  const restored: Array<[string, string]> = [];
  await assert.rejects(() => persistAndApplyWithRollback({
    previous: "off",
    next: "on",
    persist: async (value) => { persisted.push(value); return value; },
    apply: async () => { throw new Error("bridge health check failed"); },
    restore: async (failed, previous) => { restored.push([failed, previous]); },
  }), /bridge health check failed.*이전 설정으로 복구했습니다/);
  assert.deepEqual(persisted, ["on", "off"]);
  assert.deepEqual(restored, [["on", "off"]]);
});

test("settings transition queue keeps runtime side effects in invocation order", async () => {
  const queue = new AsyncSerialQueue();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = queue.run(async () => { order.push("first:start"); await firstGate; order.push("first:end"); });
  const second = queue.run(async () => { order.push("second:start"); order.push("second:end"); });
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});
