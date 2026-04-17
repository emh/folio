export const STATUSES = {
  IN_PROGRESS: "in_progress",
  UP_NEXT: "up_next",
  COMPLETED: "completed"
};

export const STATUS_LABELS = {
  [STATUSES.IN_PROGRESS]: "In Progress",
  [STATUSES.UP_NEXT]: "Up Next",
  [STATUSES.COMPLETED]: "Completed"
};

export const TASK_FIELDS = [
  "name",
  "details",
  "creator",
  "assignee",
  "status",
  "dueDate",
  "createdAt",
  "completedAt",
  "deleted"
];

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createDeviceId() {
  return createId();
}

export function normalizeGroupCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeMemberName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function memberKey(value) {
  return normalizeMemberName(value).toLowerCase();
}

export function normalizeMembers(values = []) {
  const members = [];
  const seen = new Set();

  for (const value of values) {
    const name = normalizeMemberName(value);
    const key = memberKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    members.push(name);
  }

  return members;
}

export function hasMember(members = [], name) {
  const key = memberKey(name);
  return Boolean(key && members.some(member => memberKey(member) === key));
}

export function displayMemberName(members = [], name) {
  const key = memberKey(name);
  return members.find(member => memberKey(member) === key) || "";
}

export function serializeHlc(wallTime, counter, deviceId) {
  return `${String(Math.max(0, Number(wallTime) || 0)).padStart(13, "0")}:${String(Math.max(0, Number(counter) || 0)).padStart(4, "0")}:${deviceId || ""}`;
}

export function parseHlc(value) {
  if (typeof value !== "string" || !value) {
    return { wallTime: 0, counter: 0, deviceId: "" };
  }

  const [wallTime, counter, ...deviceParts] = value.split(":");
  return {
    wallTime: Number.parseInt(wallTime, 10) || 0,
    counter: Number.parseInt(counter, 10) || 0,
    deviceId: deviceParts.join(":")
  };
}

export function compareHlc(left, right) {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.deviceId.localeCompare(b.deviceId);
}

export function tickHlc(state, now = Date.now(), deviceId = state.deviceId) {
  const clock = normalizeClock(state.hlc);
  const wallTime = Math.max(clock.wallTime, now);
  const counter = wallTime === clock.wallTime ? clock.counter + 1 : 0;
  state.hlc = { wallTime, counter };
  return serializeHlc(wallTime, counter, deviceId);
}

export function observeHlc(state, timestamp, now = Date.now(), deviceId = state.deviceId) {
  const local = normalizeClock(state.hlc);
  const remote = parseHlc(timestamp);
  const wallTime = Math.max(local.wallTime, remote.wallTime, now);
  let counter = 0;

  if (wallTime === local.wallTime && wallTime === remote.wallTime) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (wallTime === local.wallTime) {
    counter = local.counter + 1;
  } else if (wallTime === remote.wallTime) {
    counter = remote.counter + 1;
  }

  state.hlc = { wallTime, counter };
  return serializeHlc(wallTime, counter, deviceId);
}

export function createMutation(group, deviceId, entityType, entityId, field, value) {
  return {
    id: createId(),
    entityType,
    entityId,
    field,
    value,
    timestamp: tickHlc(group, Date.now(), deviceId),
    author: group.currentUser,
    deviceId
  };
}

export function normalizeTask(input = {}) {
  const name = String(input.name || input.description || "").trim();
  return {
    id: String(input.id || createId()),
    name,
    details: String(input.details || "").trim(),
    creator: input.creator || "",
    assignee: input.assignee || null,
    status: Object.values(STATUSES).includes(input.status) ? input.status : STATUSES.UP_NEXT,
    dueDate: input.dueDate || null,
    createdAt: input.createdAt || input.created || new Date().toISOString(),
    completedAt: input.completedAt || input.completedDate || null,
    deleted: Boolean(input.deleted)
  };
}

export function normalizeTimeLog(input = {}) {
  return {
    id: String(input.id || createId()),
    taskId: String(input.taskId || ""),
    date: input.date || todayIsoDate(),
    duration: Math.max(0, Number.parseInt(input.duration, 10) || 0),
    notes: String(input.notes || "").trim(),
    createdBy: input.createdBy || "",
    assigneeAtLog: input.assigneeAtLog || null
  };
}

export function applyMutation(state, mutation) {
  if (!isMutationLike(mutation)) return false;
  observeHlc(state, mutation.timestamp);

  if (mutation.entityType === "task") {
    return applyTaskMutation(state, mutation);
  }

  if (mutation.entityType === "timelog") {
    return applyTimeLogMutation(state, mutation);
  }

  return false;
}

export function applyMutations(state, mutations = []) {
  let changed = false;
  for (const mutation of mutations) {
    changed = applyMutation(state, mutation) || changed;
    if (mutation?.timestamp && compareHlc(mutation.timestamp, state.lastSyncTimestamp) > 0) {
      state.lastSyncTimestamp = mutation.timestamp;
    }
  }
  return changed;
}

export function visibleTasks(tasks) {
  return tasks
    .filter(task => !task.deleted)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function totalMinutesForTask(taskId, timeLogs) {
  return timeLogs
    .filter(log => log.taskId === taskId)
    .reduce((sum, log) => sum + log.duration, 0);
}

export function todayIsoDate() {
  return new Date().toISOString().split("T")[0];
}

export function getWeekKey(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  const day = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((day + 6) % 7));
  return monday.toISOString().split("T")[0];
}

export function groupTimeByWeek(timeLogs, filters = {}) {
  const weeks = new Map();
  const taskById = filters.taskById || new Map();
  const createdBy = filters.createdBy || "";
  const assignedTo = filters.assignedTo || "";
  const filtered = timeLogs.filter(log => {
    const task = taskById.get(log.taskId);
    if (createdBy && task?.creator !== createdBy) return false;
    if (assignedTo && log.assigneeAtLog !== assignedTo) return false;
    return true;
  });

  for (const log of filtered) {
    const key = getWeekKey(log.date);
    const existing = weeks.get(key) || { key, total: 0 };
    existing.total += log.duration;
    weeks.set(key, existing);
  }

  return Array.from(weeks.values()).sort((left, right) => right.key.localeCompare(left.key));
}

function applyTaskMutation(state, mutation) {
  state.taskClocks ||= {};
  state.taskClocks[mutation.entityId] ||= {};
  const clocks = state.taskClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeTask({ ...mutation.value, id: mutation.entityId });
    let task = state.tasks.find(candidate => candidate.id === mutation.entityId);
    if (!task) {
      state.tasks.push(incoming);
      task = state.tasks[state.tasks.length - 1];
    }

    for (const field of TASK_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        task[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = normalizeTaskField(mutation.field);
  if (!TASK_FIELDS.includes(field)) return false;

  let task = state.tasks.find(candidate => candidate.id === mutation.entityId);
  if (!task) {
    task = normalizeTask({ id: mutation.entityId });
    state.tasks.push(task);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  task[field] = coerceTaskField(field, mutation.value);
  clocks[field] = mutation.timestamp;
  return true;
}

function applyTimeLogMutation(state, mutation) {
  if (mutation.field !== "_create") return false;
  if (state.timeLogs.some(log => log.id === mutation.entityId)) return false;

  const log = normalizeTimeLog({ ...mutation.value, id: mutation.entityId });
  if (!log.taskId || log.duration < 1) return false;
  state.timeLogs.push(log);
  return true;
}

function coerceTaskField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "assignee" || field === "dueDate" || field === "completedAt") return value || null;
  if (field === "status") return Object.values(STATUSES).includes(value) ? value : STATUSES.UP_NEXT;
  return String(value || "").trim();
}

function normalizeTaskField(field) {
  if (field === "_delete") return "deleted";
  if (field === "description") return "name";
  return field;
}

function shouldApply(currentTimestamp, incomingTimestamp) {
  return !currentTimestamp || compareHlc(incomingTimestamp, currentTimestamp) >= 0;
}

function maxHlc(left, right) {
  return compareHlc(left, right) >= 0 ? left : right;
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? clock.wallTime : 0,
    counter: Number.isFinite(clock?.counter) ? clock.counter : 0
  };
}

function isMutationLike(mutation) {
  return Boolean(
    mutation &&
    typeof mutation.id === "string" &&
    ["task", "timelog"].includes(mutation.entityType) &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}
