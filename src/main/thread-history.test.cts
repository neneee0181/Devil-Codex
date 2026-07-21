import test from "node:test";
import assert from "node:assert/strict";
import { mapThreadHistory } from "./thread-history.cjs";

test("thread history keeps each path only on its latest fileChange card", () => {
  const history = mapThreadHistory([{
    id: "turn-files",
    status: "completed",
    items: [
      {
        id: "first-change",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "C:\\repo\\src\\example.ts", diff: "+const first = true;" },
          { path: "src/other.ts", diff: "+const other = true;" },
        ],
      },
      {
        id: "final-change",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/example.ts", diff: "+const final = true;" }],
      },
    ],
  }]);

  const entries = history.find((item) => item.kind === "activity" && item.turnId === "turn-files")?.activities ?? [];
  assert.deepEqual(entries.map((entry) => ({ id: entry.id, paths: entry.files?.map((file) => file.path) })), [
    { id: "first-change", paths: ["src/other.ts"] },
    { id: "final-change", paths: ["src/example.ts"] },
  ]);
  assert.equal(entries[1]?.files?.[0]?.diff, "+const final = true;");
});
