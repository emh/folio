import assert from "node:assert/strict";
import test from "node:test";
import {
  addMemberToGroup,
  materializeMutations,
  normalizeGroup,
  parseGroupRoute,
  removeMemberFromGroup,
  validateMutation
} from "../workers/sync/src/index.js";

const MEMBERS = ["Evan", "Shantel", "Gaile", "Genevieve"];

test("group metadata normalizes members and rejects duplicate additions", () => {
  const group = normalizeGroup({
    code: "ab-12",
    name: "  Home   crew ",
    members: [" Evan ", "evan", "Shantel"]
  });

  assert.equal(group.code, "AB12");
  assert.equal(group.name, "Home crew");
  assert.deepEqual(group.members, ["Evan", "Shantel"]);
  assert.deepEqual(addMemberToGroup(group, " Gaile  "), {
    ...group,
    members: ["Evan", "Shantel", "Gaile"]
  });
  assert.throws(() => addMemberToGroup(group, "EVAN"), /already exists/);
});

test("group metadata removes members and marks last leave as delete", () => {
  const group = normalizeGroup({
    code: "home1",
    name: "Home",
    members: ["Evan", "Shantel"]
  });
  const result = removeMemberFromGroup(group, "evan");

  assert.equal(result.deleted, false);
  assert.deepEqual(result.group.members, ["Shantel"]);
  assert.deepEqual(result.group.removedMembers, ["Evan"]);
  assert.deepEqual(removeMemberFromGroup(result.group, "Shantel"), { deleted: true, code: "HOME1" });
});

test("group routes extract invite code and action", () => {
  assert.deepEqual(parseGroupRoute("/api/groups/ab12/sync"), { code: "AB12", action: "sync" });
  assert.deepEqual(parseGroupRoute("/api/groups/AB12"), { code: "AB12", action: "" });
  assert.equal(parseGroupRoute("/api/groups"), null);
});

test("worker validation accepts known users and rejects unknown authors", () => {
  const valid = mutation({
    id: "m-1",
    entityType: "task",
    entityId: "task-1",
    field: "name",
    value: "Updated",
    author: "Genevieve"
  });

  assert.equal(validateMutation(valid, MEMBERS).author, "Genevieve");
  assert.throws(() => validateMutation({ ...valid, id: "m-2", author: "Not In Group" }, MEMBERS), /Invalid author/);
});

test("worker materialization applies LWW and filters deleted tasks", () => {
  const create = mutation({
    id: "m-create",
    entityType: "task",
    entityId: "task-1",
    field: "_create",
    timestamp: hlc(100),
    value: {
      id: "task-1",
      name: "Original",
      details: "Original details",
      location: "Kitchen",
      creator: "Evan",
      assignee: "Shantel",
      status: "up_next",
      scheduledDate: "2026-04-17",
      dueDate: null,
      createdAt: "2026-04-16T00:00:00.000Z",
      completedAt: null,
      deleted: false
    }
  });

  const oldName = mutation({
    id: "m-old",
    entityType: "task",
    entityId: "task-1",
    field: "name",
    value: "Old",
    timestamp: hlc(101),
    author: "Shantel"
  });

  const newName = mutation({
    id: "m-new",
    entityType: "task",
    entityId: "task-1",
    field: "name",
    value: "New",
    timestamp: hlc(102),
    author: "Gaile"
  });

  const timeLog = mutation({
    id: "log-1",
    entityType: "timelog",
    entityId: "log-1",
    field: "_create",
    timestamp: hlc(103),
    value: {
      id: "log-1",
      taskId: "task-1",
      date: "2026-04-16",
      duration: 25,
      notes: "",
      createdBy: "Evan",
      assigneeAtLog: "Shantel"
    }
  });

  const materialized = materializeMutations([newName, oldName, timeLog, create], MEMBERS);
  assert.equal(materialized.tasks[0].name, "New");
  assert.equal(materialized.tasks[0].details, "Original details");
  assert.equal(materialized.tasks[0].location, "Kitchen");
  assert.equal(materialized.tasks[0].scheduledDate, "2026-04-17");
  assert.equal(materialized.timeLogs[0].duration, 25);

  const deleted = materializeMutations([
    create,
    timeLog,
    mutation({
      id: "m-delete",
      entityType: "task",
      entityId: "task-1",
      field: "deleted",
      value: true,
      timestamp: hlc(104)
    })
  ], MEMBERS);
  assert.deepEqual(deleted.tasks, []);
  assert.deepEqual(deleted.timeLogs, []);
});

test("worker materialization preserves former creators and unassigns former assignees", () => {
  const members = ["Shantel"];
  const removedMembers = ["Evan"];
  const create = mutation({
    id: "m-create-former",
    entityType: "task",
    entityId: "task-former",
    field: "_create",
    timestamp: hlc(100),
    author: "Evan",
    value: {
      id: "task-former",
      name: "Former task",
      details: "",
      location: "",
      creator: "Evan",
      assignee: "Evan",
      status: "up_next",
      scheduledDate: null,
      dueDate: null,
      createdAt: "2026-04-16T00:00:00.000Z",
      completedAt: null,
      deleted: false
    }
  });

  const materialized = materializeMutations([create], members, removedMembers);
  assert.equal(materialized.tasks[0].creator, "Evan");
  assert.equal(materialized.tasks[0].assignee, null);
});

test("worker validation rejects invalid scheduled dates", () => {
  const invalid = mutation({
    id: "m-scheduled",
    entityType: "task",
    entityId: "task-1",
    field: "scheduledDate",
    value: "April 17",
    author: "Genevieve"
  });

  assert.throws(() => validateMutation(invalid, MEMBERS), /Invalid scheduled date/);
});

function mutation(overrides) {
  return {
    id: "mutation",
    entityType: "task",
    entityId: "task",
    field: "name",
    value: "value",
    timestamp: hlc(100),
    author: "Evan",
    deviceId: "device-a",
    ...overrides
  };
}

function hlc(wallTime, counter = 0, device = "device-a") {
  return `${String(wallTime).padStart(13, "0")}:${String(counter).padStart(4, "0")}:${device}`;
}
