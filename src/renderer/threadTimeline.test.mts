import test from "node:test";
import assert from "node:assert/strict";
import type { AppServerEvent, ThreadHistoryItem } from "../shared/contracts";
import { applyTimelineEvent, dedupeRepeatedWorkMemos } from "./threadTimeline.ts";

function activity(turnId: string, status: ThreadHistoryItem["status"]): ThreadHistoryItem {
  return { id: `activity-${turnId}`, kind: "activity", text: "", turnId, status, activities: [] };
}

function fileChangeEvent(): AppServerEvent {
  return {
    method: "item/completed",
    params: {
      item: {
        id: "file-change-1",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/example.ts", diff: "+const fixed = true;" }],
      },
    },
  };
}

test("turnId 없는 fileChange는 유일한 진행 중 턴에 연결한다", () => {
  const items: ThreadHistoryItem[] = [
    activity("turn-complete", "completed"),
    activity("turn-active", "inProgress"),
  ];

  const result = applyTimelineEvent(items, fileChangeEvent());
  const active = result.find((item) => item.kind === "activity" && item.turnId === "turn-active");

  assert.equal(active?.activities?.length, 1);
  assert.equal(active?.activities?.[0]?.kind, "fileChange");
  assert.equal(active?.activities?.[0]?.files?.[0]?.path, "src/example.ts");
});

test("turnId 없는 fileChange는 활성 턴이 없거나 여러 개면 버린다", () => {
  const cases: ThreadHistoryItem[][] = [
    [activity("turn-complete", "completed")],
    [activity("turn-a", "inProgress"), activity("turn-b", "inProgress")],
  ];

  for (const items of cases) {
    assert.strictEqual(applyTimelineEvent(items, fileChangeEvent()), items);
  }
});

test("turnId 없는 늦은 검색과 압축 이벤트는 계속 버린다", () => {
  const items: ThreadHistoryItem[] = [activity("turn-active", "inProgress")];
  for (const type of ["webSearch", "contextCompaction"]) {
    const event: AppServerEvent = {
      method: "item/completed",
      params: { item: { id: `late-${type}`, type, status: "completed" } },
    };
    assert.strictEqual(applyTimelineEvent(items, event), items);
  }
});

test("같은 경로의 연속 fileChange는 마지막 카드에만 남긴다", () => {
  const turnId = "turn-files";
  let items: ThreadHistoryItem[] = [activity(turnId, "inProgress")];
  const event = (id: string, changes: Array<{ path: string; diff: string }>): AppServerEvent => ({
    method: "item/completed",
    params: { turnId, item: { id, type: "fileChange", status: "completed", changes } },
  });

  items = applyTimelineEvent(items, event("first-change", [
    { path: "C:\\repo\\src\\example.ts", diff: "+const first = true;" },
    { path: "src/other.ts", diff: "+const other = true;" },
  ]));
  items = applyTimelineEvent(items, event("final-change", [
    { path: "src/example.ts", diff: "+const final = true;" },
  ]));

  const entries = items.find((item) => item.kind === "activity" && item.turnId === turnId)?.activities ?? [];
  assert.deepEqual(entries.map((entry) => ({ id: entry.id, paths: entry.files?.map((file) => file.path) })), [
    { id: "first-change", paths: ["src/other.ts"] },
    { id: "final-change", paths: ["src/example.ts"] },
  ]);
});

test("같은 실행 계획을 되풀이한 작업 메모는 최신 문장만 남긴다", () => {
  const entries = dedupeRepeatedWorkMemos([
    {
      id: "release-plan-1",
      kind: "message",
      title: "작업 메모",
      detail: "작업은 완료된 상태입니다. 0.4.4로 버전업하고 검증 뒤 커밋·태그·푸시하겠습니다. GitHub Actions는 기다리지 않겠습니다.",
      status: "completed",
    },
    { id: "inspect-package", kind: "command", title: "package.json 확인", status: "completed" },
    {
      id: "release-plan-2",
      kind: "message",
      title: "작업 메모",
      detail: "완료 상태로 판단합니다. 기존 릴리스 규칙에 맞춰 0.4.4 검증 후 커밋하고 v0.4.4 태그와 main을 푸시하겠습니다. Actions 완료는 기다리지 않겠습니다.",
      status: "completed",
    },
    {
      id: "bridge-audit",
      kind: "message",
      title: "작업 메모",
      detail: "Bridge 요청 로그를 확인해 실제 재시도 횟수를 계산하겠습니다.",
      status: "completed",
    },
  ]);

  assert.deepEqual(entries.map((entry) => entry.id), ["inspect-package", "release-plan-2", "bridge-audit"]);
});

test("공통 단서가 하나뿐인 서로 다른 작업 단계는 모두 남긴다", () => {
  const entries = dedupeRepeatedWorkMemos([
    {
      id: "sse-fix",
      kind: "message",
      title: "작업 메모",
      detail: "Bridge SSE continuation을 확인하고 수정한 뒤 테스트하겠습니다.",
      status: "completed",
    },
    {
      id: "browser-fix",
      kind: "message",
      title: "작업 메모",
      detail: "Bridge 브라우저 탭 생성을 확인하고 수정한 뒤 테스트하겠습니다.",
      status: "completed",
    },
  ]);

  assert.deepEqual(entries.map((entry) => entry.id), ["sse-fix", "browser-fix"]);
});
