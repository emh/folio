import assert from "node:assert/strict";
import test from "node:test";
import {
  STATUSES,
  applyMutation,
  compareHlc,
  groupTimeByWeek,
  parseHlc,
  serializeHlc,
  tickHlc
} from "../app/model.js";

test("hybrid logical clock is stable and totally ordered", () => {
  const state = { deviceId: "device-b", hlc: { wallTime: 0, counter: 0 } };
  const first = tickHlc(state, 100);
  const second = tickHlc(state, 100);
  const third = tickHlc(state, 99);

  assert.equal(first, "0000000000100:0000:device-b");
  assert.equal(second, "0000000000100:0001:device-b");
  assert.equal(third, "0000000000100:0002:device-b");
  assert.equal(compareHlc(first, second), -1);
  assert.equal(compareHlc(second, third), -1);
  assert.deepEqual(parseHlc(third), { wallTime: 100, counter: 2, deviceId: "device-b" });
  assert.equal(compareHlc(serializeHlc(100, 2, "device-a"), third), -1);
});

test("task fields use last-write-wins per field", () => {
  const state = {
    deviceId: "local",
    hlc: { wallTime: 0, counter: 0 },
    tasks: [],
    timeLogs: [],
    taskClocks: {},
    lastSyncTimestamp: ""
  };

  applyMutation(state, {
    id: "m-create",
    entityType: "task",
    entityId: "task-1",
    field: "_create",
    value: {
      id: "task-1",
      name: "Original",
      details: "Original details",
      location: "Kitchen",
      creator: "Evan",
      assignee: null,
      status: STATUSES.UP_NEXT,
      scheduledDate: "2026-04-17",
      dueDate: null,
      createdAt: "2026-04-16T10:00:00.000Z",
      completedAt: null,
      deleted: false
    },
    timestamp: "0000000000100:0000:device-a",
    author: "Evan",
    deviceId: "device-a"
  });

  applyMutation(state, {
    id: "m-new",
    entityType: "task",
    entityId: "task-1",
    field: "name",
    value: "Newer",
    timestamp: "0000000000102:0000:device-a",
    author: "Evan",
    deviceId: "device-a"
  });

  applyMutation(state, {
    id: "m-old",
    entityType: "task",
    entityId: "task-1",
    field: "name",
    value: "Older",
    timestamp: "0000000000101:0000:device-b",
    author: "Shantel",
    deviceId: "device-b"
  });

  assert.equal(state.tasks[0].name, "Newer");
  assert.equal(state.tasks[0].details, "Original details");
  assert.equal(state.tasks[0].location, "Kitchen");
  assert.equal(state.tasks[0].scheduledDate, "2026-04-17");
});

test("time report grouping filters by task creator and assignee snapshot", () => {
  const taskById = new Map([
    ["task-1", { id: "task-1", creator: "Evan" }],
    ["task-2", { id: "task-2", creator: "Shantel" }]
  ]);
  const weeks = groupTimeByWeek([
    { taskId: "task-1", date: "2026-04-13", duration: 30, assigneeAtLog: "Evan" },
    { taskId: "task-1", date: "2026-04-14", duration: 45, assigneeAtLog: "Evan" },
    { taskId: "task-1", date: "2026-04-19", duration: 60, assigneeAtLog: "Shantel" },
    { taskId: "task-2", date: "2026-04-20", duration: 90, assigneeAtLog: "Evan" }
  ], { taskById, createdBy: "Evan", assignedTo: "Evan" });

  assert.deepEqual(weeks, [
    { key: "2026-04-13", total: 75 }
  ]);
});
