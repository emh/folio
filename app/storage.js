import { createDeviceId, displayMemberName, normalizeGroupCode, normalizeMembers, normalizeTask, normalizeTimeLog } from "./model.js";

export const STATE_STORAGE_KEY = "folio_v2";
export const SCHEMA_VERSION = 2;

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (raw) {
      return normalizeStoredState(JSON.parse(raw));
    }
  } catch {
    // Fall through to first-run state.
  }

  return createInitialState();
}

export function saveAppState(state) {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      deviceId: state.deviceId,
      activeGroupCode: state.activeGroupCode || null,
      groups: state.groups || {}
    }));
  } catch {
    // Local storage can fail in private windows or quota pressure.
  }
}

export function normalizeStoredState(data = {}) {
  const deviceId = typeof data.deviceId === "string" && data.deviceId
    ? data.deviceId
    : createDeviceId();
  const groups = {};

  if (data.groups && typeof data.groups === "object") {
    for (const group of Object.values(data.groups)) {
      const normalized = normalizeGroupState(group);
      if (normalized.code) groups[normalized.code] = normalized;
    }
  }

  const activeGroupCode = normalizeGroupCode(data.activeGroupCode);

  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId,
    activeGroupCode: groups[activeGroupCode] ? activeGroupCode : null,
    groups
  };
}

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: createDeviceId(),
    activeGroupCode: null,
    groups: {}
  };
}

export function createGroupState(input = {}) {
  return normalizeGroupState({
    code: input.code,
    name: input.name,
    members: input.members,
    currentUser: input.currentUser,
    createdAt: input.createdAt
  });
}

export function normalizeGroupState(input = {}) {
  const code = normalizeGroupCode(input.code);
  const members = normalizeMembers(input.members);
  const currentUser = displayMemberName(members, input.currentUser) || null;

  return {
    code,
    name: String(input.name || "Untitled group").trim() || "Untitled group",
    members,
    removedMembers: normalizeMembers(input.removedMembers),
    currentUser,
    tasks: Array.isArray(input.tasks) ? input.tasks.map(normalizeTask) : [],
    timeLogs: Array.isArray(input.timeLogs) ? input.timeLogs.map(normalizeTimeLog) : [],
    taskClocks: input.taskClocks && typeof input.taskClocks === "object" ? input.taskClocks : {},
    mutationQueue: Array.isArray(input.mutationQueue) ? input.mutationQueue.filter(isQueuedMutation) : [],
    lastSyncTimestamp: typeof input.lastSyncTimestamp === "string" ? input.lastSyncTimestamp : "",
    hlc: normalizeClock(input.hlc),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString()
  };
}

export function loadSettings() {
  return {
    apiBaseUrl: getConfiguredApiBaseUrl() || getDefaultApiBaseUrl()
  };
}

function getDefaultApiBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost" || host === "127.0.0.1") {
    return "http://localhost:8798";
  }

  return "";
}

function getConfiguredApiBaseUrl() {
  const value = globalThis.FOLIO_CONFIG?.apiBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? clock.wallTime : 0,
    counter: Number.isFinite(clock?.counter) ? clock.counter : 0
  };
}

function isQueuedMutation(mutation) {
  return Boolean(
    mutation &&
    typeof mutation.id === "string" &&
    typeof mutation.entityType === "string" &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}
