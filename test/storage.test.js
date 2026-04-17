import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, normalizeStoredState } from "../app/storage.js";

test("initial state has no seed data or selected user", () => {
  const state = createInitialState();
  assert.equal(state.activeGroupCode, null);
  assert.deepEqual(state.groups, {});
  assert.equal(typeof state.deviceId, "string");
});

test("stored state normalization keeps multiple group states", () => {
  const state = normalizeStoredState({
    deviceId: "device-1",
    activeGroupCode: "home1",
    groups: {
      HOME1: {
        code: "home1",
        name: "Home",
        members: ["Evan", "Shantel"],
        currentUser: "evan",
        tasks: [
          {
            id: 7,
            name: "Legacy",
            details: "Longer notes",
            creator: "Evan",
            status: "in_progress",
            created: "2026-04-16T00:00:00.000Z",
            completedDate: null
          }
        ],
        timeLogs: [
          {
            id: 8,
            taskId: 7,
            date: "2026-04-16",
            duration: "30",
            notes: "Done",
            createdBy: "Evan",
            assigneeAtLog: "Evan"
          }
        ]
      },
      TRIP2: {
        code: "trip2",
        name: "Trip",
        members: ["Gaile"],
        currentUser: "Gaile"
      }
    }
  });

  assert.equal(state.activeGroupCode, "HOME1");
  assert.deepEqual(Object.keys(state.groups).sort(), ["HOME1", "TRIP2"]);
  assert.equal(state.groups.HOME1.currentUser, "Evan");
  assert.equal(state.groups.HOME1.tasks[0].id, "7");
  assert.equal(state.groups.HOME1.tasks[0].name, "Legacy");
  assert.equal(state.groups.HOME1.tasks[0].details, "Longer notes");
  assert.equal(state.groups.HOME1.tasks[0].createdAt, "2026-04-16T00:00:00.000Z");
  assert.equal(state.groups.HOME1.timeLogs[0].taskId, "7");
  assert.equal(state.groups.HOME1.timeLogs[0].duration, 30);
});
