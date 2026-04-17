const STATUSES = ["up_next", "in_progress", "completed"];
const TASK_FIELDS = new Set(["name", "details", "creator", "assignee", "status", "dueDate", "createdAt", "completedAt", "deleted"]);
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export class FolioRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = this.initialize();
  }

  async initialize() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mutations (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.state.storage.sql.exec("CREATE INDEX IF NOT EXISTS mutations_timestamp_idx ON mutations(timestamp)");
  }

  async fetch(request) {
    await this.ready;
    const cors = corsHeaders(request, this.env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, this.env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);
    const route = parseGroupRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    try {
      if (!route.action && request.method === "POST") {
        return this.createGroup(request, route.code, cors);
      }

      if (!route.action && request.method === "GET") {
        const group = await this.requireGroup();
        return json(group, 200, cors);
      }

      if (route.action === "members" && request.method === "POST") {
        const body = await request.json();
        const group = addMemberToGroup(await this.requireGroup(), body.name);
        await this.saveGroup(group);
        this.broadcast(null, { type: "group", group });
        return json(group, 200, cors);
      }

      if (route.action === "members" && request.method === "DELETE") {
        const body = await request.json();
        const result = removeMemberFromGroup(await this.requireGroup(), body.name);

        if (result.deleted) {
          await this.deleteGroup();
          this.broadcast(null, { type: "groupDeleted", code: route.code });
          return json({ deleted: true, code: route.code }, 200, cors);
        }

        await this.saveGroup(result.group);
        this.broadcast(null, { type: "group", group: result.group });
        return json(result.group, 200, cors);
      }

      if (route.action === "sync" && request.method === "GET") {
        return this.handleWebSocket(request);
      }

      if (route.action === "sync" && request.method === "POST") {
        return this.handleHttpSync(request, cors);
      }

      if (route.action === "state" && request.method === "GET") {
        const group = await this.requireGroup();
        const mutations = await this.listSince("");
        const state = materializeMutations(mutations, group.members, group.removedMembers);
        return json({ ...state, group, highWatermark: await this.highWatermark() }, 200, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, error?.status || 400, cors);
    }
  }

  async createGroup(request, code, cors) {
    if (request.headers.get("X-Folio-Internal-Create") !== "1") {
      return json({ error: "Not found" }, 404, cors);
    }

    const existing = await this.getGroup();
    if (existing) return json({ error: "Invite code already exists" }, 409, cors);

    const body = await request.json();
    const group = normalizeGroup({ ...body, code });
    await this.saveGroup(group);
    return json(group, 200, cors);
  }

  async handleWebSocket(request) {
    await this.requireGroup();

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHttpSync(request, cors) {
    const group = await this.requireGroup();
    const body = await request.json();
    const accepted = await this.acceptMutations(Array.isArray(body.mutations) ? body.mutations : [], group);
    const mutations = await this.listSince(typeof body.since === "string" ? body.since : "");
    return json({
      group,
      mutations,
      confirmedIds: accepted.map(mutation => mutation.id),
      highWatermark: await this.highWatermark()
    }, 200, cors);
  }

  async webSocketMessage(socket, raw) {
    await this.ready;

    try {
      const group = await this.requireGroup();
      const message = parseSocketMessage(raw);

      if (message.type === "sync") {
        socket.send(JSON.stringify({ type: "group", group }));
        socket.send(JSON.stringify({
          type: "mutations",
          items: await this.listSince(typeof message.since === "string" ? message.since : ""),
          highWatermark: await this.highWatermark()
        }));
        return;
      }

      if (message.type === "push") {
        const accepted = await this.acceptMutations(Array.isArray(message.mutations) ? message.mutations : [], group);
        const highWatermark = await this.highWatermark();
        socket.send(JSON.stringify({
          type: "ack",
          confirmedIds: accepted.map(mutation => mutation.id),
          highWatermark
        }));

        if (accepted.length) {
          this.broadcast(socket, {
            type: "mutations",
            items: accepted,
            highWatermark
          });
        }
        return;
      }

      socket.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: messageFromError(error) }));
    }
  }

  webSocketClose() {}

  webSocketError() {}

  broadcast(sender, message) {
    const raw = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      if (socket !== sender) {
        try {
          socket.send(raw);
        } catch {
          // Ignore dead sockets; the runtime will close them.
        }
      }
    }
  }

  async acceptMutations(input, group) {
    const accepted = [];

    for (const candidate of input) {
      const mutation = validateMutation(candidate, group.members, group.removedMembers, { mode: "accept" });
      const exists = [...this.state.storage.sql.exec("SELECT id FROM mutations WHERE id = ?", mutation.id)];
      if (exists.length) continue;

      this.state.storage.sql.exec(
        "INSERT INTO mutations (id, timestamp, json, created_at) VALUES (?, ?, ?, ?)",
        mutation.id,
        mutation.timestamp,
        JSON.stringify(mutation),
        Date.now()
      );
      accepted.push(mutation);
    }

    return accepted;
  }

  async listSince(since) {
    const query = since
      ? this.state.storage.sql.exec("SELECT json FROM mutations WHERE timestamp > ? ORDER BY timestamp ASC, id ASC", since)
      : this.state.storage.sql.exec("SELECT json FROM mutations ORDER BY timestamp ASC, id ASC");
    return [...query].map(row => JSON.parse(row.json));
  }

  async highWatermark() {
    const rows = [...this.state.storage.sql.exec("SELECT timestamp FROM mutations ORDER BY timestamp DESC LIMIT 1")];
    return rows[0]?.timestamp || "";
  }

  async getGroup() {
    return await this.state.storage.get("group") || null;
  }

  async requireGroup() {
    const group = await this.getGroup();
    if (!group) throw statusError("Group not found", 404);
    return group;
  }

  async saveGroup(group) {
    await this.state.storage.put("group", group);
  }

  async deleteGroup() {
    await this.state.storage.delete("group");
    this.state.storage.sql.exec("DELETE FROM mutations");
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/groups") {
      return createGroupWithFreshCode(request, env, cors);
    }

    const route = parseGroupRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    const id = env.FOLIO_ROOM.idFromName(route.code);
    const room = env.FOLIO_ROOM.get(id);
    return room.fetch(request);
  }
};

async function createGroupWithFreshCode(request, env, cors) {
  const body = await request.text();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateInviteCode();
    const id = env.FOLIO_ROOM.idFromName(code);
    const room = env.FOLIO_ROOM.get(id);
    const url = new URL(request.url);
    url.pathname = `/api/groups/${code}`;

    const response = await room.fetch(new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") || "application/json",
        "Origin": request.headers.get("Origin") || "",
        "X-Folio-Internal-Create": "1"
      },
      body
    }));

    if (response.status !== 409) return response;
  }

  return json({ error: "Could not create invite code" }, 500, cors);
}

export function parseGroupRoute(pathname) {
  const match = /^\/api\/groups\/([A-Za-z0-9]+)(?:\/(sync|state|members))?\/?$/.exec(pathname);
  if (!match) return null;
  return {
    code: normalizeGroupCode(match[1]),
    action: match[2] || ""
  };
}

export function generateInviteCode(length = CODE_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export function normalizeGroup(input = {}) {
  const code = normalizeGroupCode(input.code);
  const name = String(input.name || "").replace(/\s+/g, " ").trim();
  const members = normalizeMembers(input.members);

  if (!code) throw new Error("Invite code is required");
  if (!name) throw new Error("Group name is required");
  if (!members.length) throw new Error("At least one member is required");

  return {
    code,
    name,
    members,
    removedMembers: normalizeMembers(input.removedMembers),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString()
  };
}

export function addMemberToGroup(group, name) {
  const normalized = normalizeMemberName(name);
  if (!normalized) throw new Error("Name is required");
  if (hasMember(group.members, normalized)) throw new Error("Name already exists in this group");
  return {
    ...group,
    members: [...group.members, normalized]
  };
}

export function removeMemberFromGroup(group, name) {
  const member = displayMemberName(group.members, name);
  if (!member) throw new Error("Name is not in this group");

  if (group.members.length === 1) {
    return { deleted: true, code: group.code };
  }

  const key = memberKey(member);
  return {
    deleted: false,
    group: {
      ...group,
      members: group.members.filter(candidate => memberKey(candidate) !== key),
      removedMembers: normalizeMembers([...(group.removedMembers || []), member])
    }
  };
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

export function normalizeMemberName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeGroupCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hasMember(members = [], name) {
  return Boolean(displayMemberName(members, name));
}

export function displayMemberName(members = [], name) {
  const key = memberKey(name);
  return key ? members.find(member => memberKey(member) === key) || "" : "";
}

export function validateMutation(input, members, removedMembers = [], options = {}) {
  if (!input || typeof input !== "object") throw new Error("Mutation must be an object");
  const knownMembers = normalizeMembers([...members, ...removedMembers]);
  const authorMembers = options.mode === "accept" ? members : knownMembers;
  const author = displayMemberName(authorMembers, input.author);
  if (!author) throw new Error("Invalid author");

  const mutation = {
    id: stringValue(input.id, "Mutation id"),
    entityType: stringValue(input.entityType, "Entity type"),
    entityId: stringValue(input.entityId, "Entity id"),
    field: stringValue(input.field, "Field"),
    value: input.value,
    timestamp: stringValue(input.timestamp, "Timestamp"),
    author,
    deviceId: stringValue(input.deviceId, "Device id")
  };

  if (!["task", "timelog"].includes(mutation.entityType)) throw new Error("Invalid entity type");
  if (!isHlc(mutation.timestamp)) throw new Error("Invalid timestamp");

  if (mutation.entityType === "task") return validateTaskMutation(mutation, members, knownMembers, options);
  return validateTimeLogMutation(mutation, members, knownMembers, options);
}

export function materializeMutations(mutations, members = [], removedMembers = []) {
  const state = { tasks: [], timeLogs: [], taskClocks: {} };
  for (const mutation of mutations.map(item => validateMutation(item, members, removedMembers, { mode: "materialize" })).sort(compareMutation)) {
    applyServerMutation(state, mutation, members, removedMembers);
  }

  const visibleTaskIds = new Set(state.tasks.filter(task => !task.deleted).map(task => task.id));
  return {
    tasks: state.tasks.filter(task => !task.deleted),
    timeLogs: state.timeLogs.filter(log => visibleTaskIds.has(log.taskId))
  };
}

export function applyServerMutation(state, mutation, members = [], removedMembers = []) {
  if (mutation.entityType === "task") {
    return applyTaskMutation(state, mutation, members, removedMembers);
  }

  if (mutation.entityType === "timelog") {
    if (mutation.field !== "_create") return false;
    if (state.timeLogs.some(log => log.id === mutation.entityId)) return false;
    state.timeLogs.push(normalizeTimeLog({ ...mutation.value, id: mutation.entityId }, members, normalizeMembers([...members, ...removedMembers])));
    return true;
  }

  return false;
}

function validateTaskMutation(mutation, members, knownMembers, options = {}) {
  const creatorMembers = options.mode === "accept" ? members : knownMembers;

  if (mutation.field === "_create") {
    if (!mutation.value || typeof mutation.value !== "object") throw new Error("Task create value is required");
    const task = normalizeTask({ ...mutation.value, id: mutation.entityId }, members, creatorMembers);
    if (!task.name) throw new Error("Task name is required");
    if (!task.creator) throw new Error("Invalid creator");
    return { ...mutation, value: task };
  }

  const field = normalizeTaskField(mutation.field);
  if (!TASK_FIELDS.has(field)) throw new Error("Invalid task field");

  return {
    ...mutation,
    field,
    value: normalizeTaskFieldValue(field, mutation.value, members, creatorMembers, options)
  };
}

function validateTimeLogMutation(mutation, members, knownMembers, options = {}) {
  if (mutation.field !== "_create") throw new Error("Time logs are append-only");
  if (!mutation.value || typeof mutation.value !== "object") throw new Error("Time log create value is required");

  const logMembers = options.mode === "accept" ? members : knownMembers;
  const log = normalizeTimeLog({ ...mutation.value, id: mutation.entityId }, members, logMembers);
  if (!log.taskId) throw new Error("Time log task id is required");
  if (!isIsoDate(log.date)) throw new Error("Invalid time log date");
  if (log.duration < 1) throw new Error("Time log duration is required");
  if (!log.createdBy) throw new Error("Invalid time log creator");

  return { ...mutation, value: log };
}

function applyTaskMutation(state, mutation, members, removedMembers = []) {
  const knownMembers = normalizeMembers([...members, ...removedMembers]);
  state.taskClocks[mutation.entityId] ||= {};
  const clocks = state.taskClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeTask({ ...mutation.value, id: mutation.entityId }, members, knownMembers);
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
    return true;
  }

  const field = normalizeTaskField(mutation.field);
  let task = state.tasks.find(candidate => candidate.id === mutation.entityId);
  if (!task) {
    task = normalizeTask({ id: mutation.entityId }, members, knownMembers);
    state.tasks.push(task);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  task[field] = mutation.value;
  clocks[field] = mutation.timestamp;
  return true;
}

function normalizeTask(input = {}, members = [], creatorMembers = members) {
  const name = String(input.name || input.description || "").trim().slice(0, 160);
  return {
    id: String(input.id || ""),
    name,
    details: String(input.details || "").trim().slice(0, 5000),
    creator: displayMemberName(creatorMembers, input.creator),
    assignee: input.assignee ? displayMemberName(members, input.assignee) : null,
    status: STATUSES.includes(input.status) ? input.status : "up_next",
    dueDate: input.dueDate && isIsoDate(input.dueDate) ? input.dueDate : null,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    completedAt: typeof input.completedAt === "string" && input.completedAt ? input.completedAt : null,
    deleted: Boolean(input.deleted)
  };
}

function normalizeTimeLog(input = {}, members = [], logMembers = members) {
  return {
    id: String(input.id || ""),
    taskId: String(input.taskId || ""),
    date: String(input.date || ""),
    duration: Math.max(0, Number.parseInt(input.duration, 10) || 0),
    notes: String(input.notes || "").trim().slice(0, 500),
    createdBy: displayMemberName(logMembers, input.createdBy),
    assigneeAtLog: input.assigneeAtLog ? displayMemberName(logMembers, input.assigneeAtLog) : null
  };
}

function normalizeTaskFieldValue(field, value, members, creatorMembers = members, options = {}) {
  if (field === "deleted") return Boolean(value);
  if (field === "assignee") {
    if (!value) return null;
    const member = displayMemberName(members, value);
    if (!member && options.mode === "materialize") return null;
    if (!member) throw new Error("Invalid assignee");
    return member;
  }
  if (field === "dueDate") {
    if (!value) return null;
    if (!isIsoDate(value)) throw new Error("Invalid due date");
    return value;
  }
  if (field === "completedAt") return value || null;
  if (field === "status") {
    if (!STATUSES.includes(value)) throw new Error("Invalid status");
    return value;
  }
  if (field === "creator") {
    const member = displayMemberName(creatorMembers, value);
    if (!member) throw new Error("Invalid creator");
    return member;
  }
  if (field === "name" && !String(value || "").trim()) throw new Error("Task name is required");
  return String(value || "").trim();
}

function normalizeTaskField(field) {
  if (field === "_delete") return "deleted";
  if (field === "description") return "name";
  return field;
}

function compareMutation(left, right) {
  return compareHlc(left.timestamp, right.timestamp) || left.id.localeCompare(right.id);
}

function compareHlc(left, right) {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.deviceId.localeCompare(b.deviceId);
}

function parseHlc(value) {
  const [wallTime, counter, ...deviceParts] = String(value || "").split(":");
  return {
    wallTime: Number.parseInt(wallTime, 10) || 0,
    counter: Number.parseInt(counter, 10) || 0,
    deviceId: deviceParts.join(":")
  };
}

function shouldApply(currentTimestamp, incomingTimestamp) {
  return !currentTimestamp || compareHlc(incomingTimestamp, currentTimestamp) >= 0;
}

function isHlc(value) {
  return /^\d{13}:\d{4}:.+/.test(value);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function memberKey(value) {
  return normalizeMemberName(value).toLowerCase();
}

function stringValue(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin)) ? origin : "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }

  return headers;
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = allowedOrigins(env);
  return allowed.includes("*") || allowed.includes(origin);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function parseSocketMessage(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  return JSON.parse(new TextDecoder().decode(raw));
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}
