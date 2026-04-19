import {
  STATUSES,
  STATUS_LABELS,
  applyMutation,
  createId,
  createMutation,
  groupTimeByWeek,
  hasMember,
  normalizeGroupCode,
  normalizeMemberName,
  normalizeMembers,
  todayIsoDate,
  totalMinutesForTask,
  visibleTasks
} from "./model.js";
import { createGroupState, loadAppState, saveAppState } from "./storage.js";
import { FolioSync, addRemoteGroupMember, createRemoteGroup, fetchRemoteGroup, removeRemoteGroupMember } from "./sync.js";

const appState = loadAppState();
const ui = {
  screen: null,
  view: "dashboard",
  filter: "all",
  reportCreator: "",
  reportAssignee: "",
  currentTaskId: null,
  detailMode: "read",
  pendingDeleteId: null,
  pendingLeave: false,
  addingUser: false,
  pendingGroup: null,
  joinCode: "",
  taskCalendarWeekStart: "",
  taskCalendarSelectedDate: "",
  syncStatus: "idle",
  syncGroupCode: null
};

const $ = id => document.getElementById(id);

let sync = null;
let toastTimer;

function save() {
  saveAppState(appState);
}

function activeGroup() {
  return appState.groups[appState.activeGroupCode] || null;
}

function hasActiveSession() {
  const group = activeGroup();
  return Boolean(group?.code && group.currentUser);
}

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = `${months[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function isoDateFromLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateFromIsoDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function startOfWeek(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function daysUntilDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!match) return null;

  const [, year, month, day] = match;
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

function dueLabel(dateStr) {
  const days = daysUntilDate(dateStr);
  if (days === null) return "";
  if (days < 0) return "overdue";
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days <= 3) return `due in ${days} days`;
  return `due ${formatDate(`${dateStr}T00:00:00`)}`;
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2000);
}

function defaultScreen() {
  if (!Object.keys(appState.groups).length) return "intro";
  const group = activeGroup();
  if (!group) return "group-select";
  if (!group.currentUser) return "user-list";
  return null;
}

function renderAll(options = {}) {
  const group = activeGroup();
  if (group) sanitizeGroupAssignments(group);
  if (!ui.screen) ui.screen = defaultScreen();

  const showSetup = Boolean(ui.screen);
  $("setup-screen").classList.toggle("active", showSetup);
  $("app").hidden = !hasActiveSession();

  if (showSetup) {
    document.body.classList.add("no-scroll");
  } else if (![...document.querySelectorAll(".overlay")].some(overlay => overlay.classList.contains("active"))) {
    document.body.classList.remove("no-scroll");
  }

  if (showSetup) {
    renderSetupScreen();
    return;
  }

  renderHeader();
  renderNav();
  renderFilters();

  if (ui.view === "dashboard") {
    renderDashboard();
  } else {
    renderReports();
  }

  if (options.preserveOverlay) {
    renderActiveOverlay();
  }
}

function renderSetupScreen() {
  const group = activeGroup();
  const content = $("setup-content");
  const back = setupBackAction();

  if (ui.screen === "join-code") {
    content.innerHTML = `
      ${renderSetupBack(back)}
      <h1>folio</h1>
      <p>join a group</p>
      <label class="field-label" for="join-code">Invite code</label>
      <input type="text" class="field-input setup-input" id="join-code" value="${esc(ui.joinCode)}" autocomplete="off" spellcheck="false">
      <div class="detail-actions setup-actions">
        <button class="action-link primary" type="button" data-action="lookup-join">Continue</button>
      </div>
    `;
    setTimeout(() => $("join-code")?.focus(), 0);
    return;
  }

  if (ui.screen === "join-user" && ui.pendingGroup) {
    content.innerHTML = `
      ${renderSetupBack("back-join-code")}
      <h1>${esc(ui.pendingGroup.name)}</h1>
      <p>choose your name</p>
      <div class="name-options">
        ${ui.pendingGroup.members.map(member =>
          `<button class="name-option" type="button" data-action="join-member" data-member="${esc(member)}">${esc(member)}</button>`
        ).join("")}
      </div>
      <hr class="detail-rule">
      <label class="field-label" for="join-new-name">New name</label>
      <input type="text" class="field-input setup-input" id="join-new-name" placeholder="Your name" autocomplete="off" spellcheck="false">
      <div class="detail-actions setup-actions">
        <button class="action-link primary" type="button" data-action="join-new-member">Join</button>
      </div>
    `;
    return;
  }

  if (ui.screen === "create-group") {
    content.innerHTML = `
      ${renderSetupBack(back)}
      <h1>folio</h1>
      <p>create a group</p>
      <label class="field-label" for="new-group-name">Group name</label>
      <input type="text" class="field-input setup-input" id="new-group-name" placeholder="Group name" autocomplete="off" spellcheck="false">
      <label class="field-label" for="new-group-user">Your name</label>
      <input type="text" class="field-input setup-input" id="new-group-user" placeholder="Your name" autocomplete="off" spellcheck="false">
      <label class="field-label" for="new-group-members">Other names (optional)</label>
      <textarea class="field-textarea setup-input" id="new-group-members" placeholder="One per line, or separated by commas"></textarea>
      <div class="detail-actions setup-actions">
        <button class="action-link primary" type="button" data-action="create-group">Create group</button>
      </div>
    `;
    setTimeout(() => $("new-group-name")?.focus(), 0);
    return;
  }

  if (ui.screen === "share" && group) {
    const link = inviteLink(group.code);
    content.innerHTML = `
      ${renderSetupBack(hasActiveSession() ? "finish-share" : "")}
      <h1>${esc(group.name)}</h1>
      <p>share this invite</p>
      <input type="text" class="field-input setup-input" id="invite-link" value="${esc(link)}" readonly>
      <div class="name-hint">${esc(group.code)}</div>
      <div class="detail-actions setup-actions">
        <button class="action-link primary" type="button" data-action="share-native">Share</button>
        <button class="action-link" type="button" data-action="copy-invite">Copy link</button>
        <button class="action-link muted" type="button" data-action="finish-share">OK</button>
      </div>
    `;
    return;
  }

  if (ui.screen === "group-select") {
    const groups = Object.values(appState.groups).sort((left, right) => left.name.localeCompare(right.name));
    content.innerHTML = `
      ${renderSetupBack(hasActiveSession() ? "close-setup" : "")}
      <h1>folio</h1>
      <p>choose a group</p>
      <div class="name-options">
        ${groups.length ? groups.map(candidate =>
          `<button class="name-option" type="button" data-action="select-group" data-code="${esc(candidate.code)}">${esc(candidate.name)}</button>`
        ).join("") : '<div class="empty-state">No groups on this device.</div>'}
        <button class="name-option name-option-muted" type="button" data-action="show-create">new</button>
      </div>
    `;
    return;
  }

  if (ui.screen === "user-list" && group) {
    const isLastUser = group.members.length === 1;
    const leaveLabel = ui.pendingLeave
      ? (isLastUser ? "Leave and delete group?" : `Leave as ${group.currentUser}?`)
      : "Leave";
    content.innerHTML = `
      ${renderSetupBack(hasActiveSession() ? "close-setup" : "back-setup")}
      <h1>${esc(group.name)}</h1>
      <p>choose your name</p>
      <div class="name-options">
        ${group.members.map(member =>
          `<button class="name-option" type="button" data-action="select-user" data-member="${esc(member)}">${esc(member)}</button>`
        ).join("")}
        ${ui.addingUser
          ? '<div class="name-option name-option-input-row"><input type="text" class="name-option-input" id="group-new-name" aria-label="New name" autocomplete="off" spellcheck="false"></div>'
          : '<button class="name-option name-option-muted" type="button" data-action="start-add-user">new</button>'}
      </div>
      <div class="detail-actions setup-actions">
        <button class="action-link" type="button" data-action="show-share">Invite</button>
        ${group.currentUser && !ui.pendingLeave ? `<button class="action-link muted" type="button" data-action="leave-user">${esc(leaveLabel)}</button>` : ""}
        ${group.currentUser && ui.pendingLeave ? '<button class="action-link" type="button" data-action="confirm-leave-user">ok</button><button class="action-link muted" type="button" data-action="cancel-leave-user">cancel</button>' : ""}
      </div>
      ${ui.pendingLeave && isLastUser ? '<p class="warning-text">You are the last user. Leaving will delete this group.</p>' : ""}
    `;
    if (ui.addingUser) setTimeout(() => $("group-new-name")?.focus(), 0);
    return;
  }

  content.innerHTML = `
    <h1>folio</h1>
    <p>start here</p>
    <div class="detail-actions setup-actions">
      <button class="action-link primary" type="button" data-action="show-create">Create group</button>
      <button class="action-link" type="button" data-action="show-join">Join group</button>
    </div>
  `;
}

function renderSetupBack(action) {
  return action ? `<button class="setup-back" type="button" data-action="${action}">back</button>` : "";
}

function setupBackAction() {
  if (ui.screen === "intro") return "";
  if (ui.screen === "join-user") return "back-join-code";
  if (hasActiveSession()) return "close-setup";
  return "back-setup";
}

function renderHeader() {
  const group = activeGroup();
  const groupButton = $("switch-group-btn");
  const userButton = $("switch-user-btn");
  const syncDot = $("sync-dot");

  groupButton.textContent = group?.name || "";
  userButton.textContent = group?.currentUser || "";
  groupButton.hidden = !group;
  userButton.hidden = !group?.currentUser;

  const isSynced = Boolean(group && group.mutationQueue.length === 0 && ui.syncStatus === "synced");
  syncDot.classList.toggle("synced", isSynced);
  syncDot.classList.toggle("unsynced", !isSynced);
  syncDot.setAttribute("aria-label", isSynced ? "synced" : "not synced");
  syncDot.title = isSynced ? "synced" : "not synced";

  const tasks = visibleTasks(group.tasks);
  const total = tasks.length;
  const inProgress = tasks.filter(task => task.status === STATUSES.IN_PROGRESS).length;
  const done = tasks.filter(task => task.status === STATUSES.COMPLETED).length;
  const allMinutes = group.timeLogs.reduce((sum, log) => sum + log.duration, 0);

  $("stats").textContent = [
    `${total} tasks`,
    `${inProgress} active`,
    `${done} done`,
    `${formatDuration(allMinutes)} logged`
  ].join(" - ");
}

function renderNav() {
  $("nav-tabs").innerHTML = [
    { key: "dashboard", label: "Dashboard" },
    { key: "reports", label: "Reports" }
  ].map(item =>
    `<button class="nav-item${ui.view === item.key ? " active" : ""}" type="button" data-view="${item.key}">${item.label}</button>`
  ).join("");
}

function renderFilters() {
  if (ui.view !== "dashboard") {
    $("filters").innerHTML = "";
    return;
  }

  $("filters").innerHTML = [
    { key: "all", label: "All Tasks" },
    { key: "mine", label: "Assigned to Me" },
    { key: "created", label: "Created by Me" }
  ].map(filter =>
    `<button class="filter-item${ui.filter === filter.key ? " active" : ""}" type="button" data-filter="${filter.key}">${filter.label}</button>`
  ).join("");
}

function renderDashboard() {
  const tasks = filteredTasks();
  const groups = [
    { status: STATUSES.IN_PROGRESS, label: "In Progress", empty: "Nothing in progress." },
    { status: STATUSES.UP_NEXT, label: "Up Next", empty: "No upcoming tasks.", add: true },
    { status: STATUSES.COMPLETED, label: "Completed", empty: "Nothing completed yet." }
  ];

  $("task-sections").innerHTML = groups.map(group => {
    const items = tasks.filter(task => task.status === group.status);
    const add = group.add
      ? '<button class="add-btn" type="button" id="add-task-btn">+ new task</button>'
      : "";
    const body = items.length
      ? items.map(renderTaskItem).join("")
      : `<div class="empty-state">${group.empty}</div>`;

    return `
      <section>
        <div class="section-header">
          <span class="section-label">${group.label} - ${items.length}</span>
          ${add}
        </div>
        ${body}
      </section>
    `;
  }).join("");
}

function filteredTasks() {
  const group = activeGroup();
  let tasks = visibleTasks(group.tasks);
  if (ui.filter === "mine") {
    tasks = tasks.filter(task => task.assignee === group.currentUser);
  } else if (ui.filter === "created") {
    tasks = tasks.filter(task => task.creator === group.currentUser);
  }
  return tasks;
}

function renderTaskItem(task) {
  const group = activeGroup();
  const minutes = totalMinutesForTask(task.id, group.timeLogs);
  const dueDays = daysUntilDate(task.dueDate);
  let dueLine = "";
  if (task.dueDate && task.status !== STATUSES.COMPLETED) {
    const label = dueLabel(task.dueDate);
    if (label) dueLine = ` - <span class="task-due${dueDays !== null && dueDays <= 0 ? " past" : ""}">${label}</span>`;
  }
  const sub = [
    `created by ${task.creator}`,
    task.location,
    task.scheduledDate ? `scheduled ${formatDate(`${task.scheduledDate}T00:00:00`)}` : ""
  ].filter(Boolean).join(" - ");

  return `
    <article class="task-item${task.status === STATUSES.COMPLETED ? " completed" : ""}" data-id="${esc(task.id)}">
      <div class="task-meta">
        <span>${esc(task.assignee || "unassigned")}${dueLine}</span>
        <span>${minutes ? formatDuration(minutes) : ""}</span>
      </div>
      <h2 class="task-description">${esc(task.name)}</h2>
      <div class="task-sub">${esc(sub)}</div>
    </article>
  `;
}

function renderReports() {
  const group = activeGroup();
  const tasks = visibleTasks(group.tasks);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const logs = group.timeLogs.filter(log => taskById.has(log.taskId));
  const weeks = groupTimeByWeek(logs, {
    taskById,
    createdBy: ui.reportCreator,
    assignedTo: ui.reportAssignee
  });

  let html = '<div class="section-header"><span class="section-label">Time per Week</span></div>';
  html += '<div class="report-filter-group"><div class="section-label">Created by</div><nav class="filter-row" aria-label="Created by">';
  html += `<button class="filter-item${ui.reportCreator ? "" : " active"}" type="button" data-report-creator="">All</button>`;
  html += group.members.map(name =>
    `<button class="filter-item${ui.reportCreator === name ? " active" : ""}" type="button" data-report-creator="${esc(name)}">${esc(name)}</button>`
  ).join("");
  html += '</nav></div>';
  html += '<div class="report-filter-group"><div class="section-label">Assigned to</div><nav class="filter-row" aria-label="Assigned to">';
  html += `<button class="filter-item${ui.reportAssignee ? "" : " active"}" type="button" data-report-assignee="">All</button>`;
  html += group.members.map(name =>
    `<button class="filter-item${ui.reportAssignee === name ? " active" : ""}" type="button" data-report-assignee="${esc(name)}">${esc(name)}</button>`
  ).join("");
  html += "</nav></div>";

  if (!weeks.length) {
    html += '<div class="empty-state">No time logged yet.</div>';
  } else {
    html += weeks.map(week => `
      <div class="report-week-row">
        <span>${formatDate(`${week.key}T00:00:00`)}</span>
        <span>${formatDuration(week.total)}</span>
      </div>
    `).join("");

    const total = weeks.reduce((sum, week) => sum + week.total, 0);
    html += `<div class="report-total">${formatDuration(total)} total across ${weeks.length} week${weeks.length === 1 ? "" : "s"}</div>`;
  }

  $("task-sections").innerHTML = html;
}

function getTask(id = ui.currentTaskId) {
  const group = activeGroup();
  return group?.tasks.find(task => task.id === id && !task.deleted) || null;
}

function taskLogs(taskId) {
  return activeGroup().timeLogs.filter(log => log.taskId === taskId);
}

function commitChanges(changes, message) {
  const group = activeGroup();
  const mutations = changes.map(change =>
    createMutation(group, appState.deviceId, change.entityType, change.entityId, change.field, change.value)
  );

  for (const mutation of mutations) {
    applyMutation(group, mutation);
    group.mutationQueue.push(mutation);
  }

  save();
  sync?.flush();
  renderAll({ preserveOverlay: true });
  if (message) toast(message);
}

function showDetail(id) {
  ui.currentTaskId = id;
  ui.detailMode = "read";
  ui.pendingDeleteId = null;
  renderDetail();
  openOverlay("detail-overlay");
}

function renderDetail() {
  const group = activeGroup();
  const task = getTask();
  if (!task) {
    closeOverlay("detail-overlay");
    return;
  }

  const logs = taskLogs(task.id);
  const minutes = totalMinutesForTask(task.id, logs);
  const metadata = [
    task.assignee || "unassigned",
    task.location,
    task.scheduledDate ? `scheduled ${formatDate(`${task.scheduledDate}T00:00:00`)}` : "",
    task.dueDate ? dueLabel(task.dueDate) : "",
    minutes ? `${formatDuration(minutes)} logged` : ""
  ].filter(Boolean).join(" - ");
  const confirmingDelete = ui.pendingDeleteId === task.id;
  const canEdit = task.status !== STATUSES.COMPLETED;
  const isEditing = ui.detailMode === "edit" && canEdit;

  let html = `
    <button class="back-btn" type="button" data-action="back">back</button>
    <h1 class="detail-description">${esc(task.name)}</h1>
    <p class="detail-meta">created by ${esc(task.creator)} - ${formatDate(task.createdAt)}</p>
    <p class="detail-meta">${esc(metadata)}</p>
    <p class="detail-meta">${STATUS_LABELS[task.status].toUpperCase()}</p>
  `;

  if (isEditing) {
    html += `
      <hr class="detail-rule">

      <label class="field-label" for="edit-name">Name</label>
      <input type="text" class="field-input" id="edit-name" placeholder="Short task name" value="${esc(task.name)}">

      <label class="field-label" for="edit-details">Details</label>
      <textarea class="field-textarea details-textarea" id="edit-details" placeholder="Add details...">${esc(task.details)}</textarea>

      <label class="field-label" for="edit-location">Location</label>
      <input type="text" class="field-input" id="edit-location" placeholder="Optional location" value="${esc(task.location)}">

      <label class="field-label" for="edit-assignee">Assignee</label>
      <select class="field-select" id="edit-assignee">
        <option value="">Unassigned</option>
        ${group.members.map(name => `<option value="${esc(name)}"${task.assignee === name ? " selected" : ""}>${esc(name)}</option>`).join("")}
      </select>

      <div class="create-calendar" id="edit-task-calendar"></div>

      <label class="field-label" for="edit-scheduled">Scheduled Date</label>
      <div class="date-field">
        <input type="date" class="field-input" id="edit-scheduled" value="${task.scheduledDate || ""}">
        <button class="date-clear" type="button" data-action="clear-edit-scheduled" aria-label="Clear scheduled date">x</button>
      </div>

      <label class="field-label" for="edit-due">Due Date</label>
      <div class="date-field">
        <input type="date" class="field-input" id="edit-due" value="${task.dueDate || ""}">
        <button class="date-clear" type="button" data-action="clear-edit-due" aria-label="Clear due date">x</button>
      </div>
    `;
  } else if (task.details) {
    html += `
      <hr class="detail-rule">
      <div class="section-label">Details</div>
      <p class="detail-copy">${esc(task.details)}</p>
    `;
  }

  html += `
    <div class="detail-actions">
      ${renderStatusActions(task)}
      ${canEdit && !isEditing ? '<button class="action-link" type="button" data-action="edit-task">Edit</button>' : ""}
      ${!isEditing ? '<button class="action-link muted" type="button" data-action="duplicate-task">Duplicate</button>' : ""}
      <button class="action-link muted" type="button" data-action="${confirmingDelete ? "confirm-delete" : "delete"}">${confirmingDelete ? "Delete task?" : "Delete"}</button>
    </div>
  `;

  if (logs.length) {
    html += '<hr class="detail-rule"><div class="section-label">Time Log</div>';
    html += [...logs]
      .sort((left, right) => right.date.localeCompare(left.date))
      .map(log => `
        <div class="log-entry">
          <div class="log-date">${formatDate(`${log.date}T00:00:00`)}</div>
          <div class="log-duration">${formatDuration(log.duration)}</div>
          ${log.notes ? `<div class="log-notes">${esc(log.notes)}</div>` : ""}
        </div>
      `).join("");
  }

  $("detail-content").innerHTML = html;
  if (isEditing) {
    bindDetailFields(task);
    renderTaskCalendar("edit");
  }
}

function renderStatusActions(task) {
  if (task.status === STATUSES.UP_NEXT) {
    return '<button class="action-link primary" type="button" data-action="start">Start</button>';
  }

  if (task.status === STATUSES.IN_PROGRESS) {
    return [
      '<button class="action-link" type="button" data-action="log-time">Log</button>',
      '<button class="action-link primary" type="button" data-action="complete">Finish</button>',
      '<button class="action-link muted" type="button" data-action="move-back">Pause</button>'
    ].join("");
  }

  return '<button class="action-link muted" type="button" data-action="reopen">Reopen</button>';
}

function bindDetailFields(task) {
  $("edit-name").addEventListener("blur", () => {
    const value = $("edit-name").value.trim();
    if (!value) {
      $("edit-name").value = task.name;
      toast("Add a name");
      return;
    }
    if (value !== task.name) {
      commitChanges([{ entityType: "task", entityId: task.id, field: "name", value }], "Updated");
    }
  });

  $("edit-details").addEventListener("blur", () => {
    const value = $("edit-details").value.trim();
    if (value !== task.details) {
      commitChanges([{ entityType: "task", entityId: task.id, field: "details", value }], "Updated");
    }
  });

  $("edit-location").addEventListener("blur", () => {
    const value = $("edit-location").value.trim();
    if (value !== task.location) {
      commitChanges([{ entityType: "task", entityId: task.id, field: "location", value }], "Updated");
    }
  });

  $("edit-assignee").addEventListener("change", () => {
    const value = $("edit-assignee").value || null;
    if (value !== task.assignee) {
      commitChanges([{ entityType: "task", entityId: task.id, field: "assignee", value }], value ? `Assigned to ${value}` : "Unassigned");
    }
  });

  $("edit-scheduled").addEventListener("change", () => {
    const value = $("edit-scheduled").value || null;
    if (value !== task.scheduledDate) {
      commitChanges([{ entityType: "task", entityId: task.id, field: "scheduledDate", value }], value ? "Scheduled date set" : "Scheduled date removed");
    }
  });

  $("edit-due").addEventListener("change", () => {
    const value = $("edit-due").value || null;
    if (value !== task.dueDate) {
      commitChanges([{ entityType: "task", entityId: task.id, field: "dueDate", value }], value ? "Due date set" : "Due date removed");
    }
  });
}

function resetTaskCalendar() {
  ui.taskCalendarWeekStart = isoDateFromLocalDate(startOfWeek());
  ui.taskCalendarSelectedDate = "";
}

function taskCalendarDates() {
  const weekStart = localDateFromIsoDate(ui.taskCalendarWeekStart) || startOfWeek();
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    return {
      date,
      iso: isoDateFromLocalDate(date)
    };
  });
}

function createCalendarTasksForDate(assignee, dateStr) {
  if (!assignee) return [];
  return visibleTasks(activeGroup().tasks)
    .filter(task =>
      task.status !== STATUSES.COMPLETED &&
      task.assignee === assignee &&
      (task.scheduledDate === dateStr || task.dueDate === dateStr)
    )
    .sort((left, right) => {
      const leftDue = left.dueDate === dateStr ? 0 : 1;
      const rightDue = right.dueDate === dateStr ? 0 : 1;
      return leftDue - rightDue || left.name.localeCompare(right.name);
    });
}

function taskCalendarLabels(task, dateStr) {
  const labels = [];
  if (task.scheduledDate === dateStr) labels.push("scheduled");
  if (task.dueDate === dateStr) labels.push("due");
  return labels.join(" + ");
}

function renderTaskCalendar(prefix) {
  const calendar = $(`${prefix}-task-calendar`);
  if (!calendar) return;

  const assignee = $(`${prefix}-assignee`)?.value || "";
  if (!assignee) {
    ui.taskCalendarSelectedDate = "";
    calendar.hidden = true;
    calendar.innerHTML = "";
    return;
  }

  calendar.hidden = false;
  const dates = taskCalendarDates();
  const today = isoDateFromLocalDate(new Date());
  const selectedDate = ui.taskCalendarSelectedDate;
  const selectedTasks = selectedDate ? createCalendarTasksForDate(assignee, selectedDate) : [];

  calendar.innerHTML = `
    <div class="calendar-grid">
      <button class="calendar-nav" type="button" data-action="calendar-prev-week" aria-label="Previous week">&lt;</button>
      ${dates.map(({ date, iso }) => {
        const tasks = createCalendarTasksForDate(assignee, iso);
        const load = Math.min(tasks.length, 4);
        const selected = selectedDate === iso;
        return `
          <button class="calendar-day load-${load}${selected ? " selected" : ""}${iso === today ? " today" : ""}" type="button" data-action="calendar-select-day" data-date="${iso}" aria-pressed="${selected}">
            <span class="calendar-dow">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]}</span>
            <span class="calendar-date">${date.getDate()}</span>
            <span class="calendar-count">${tasks.length || ""}</span>
          </button>
        `;
      }).join("")}
      <button class="calendar-nav" type="button" data-action="calendar-next-week" aria-label="Next week">&gt;</button>
    </div>
    <div class="calendar-task-list">
      ${renderTaskCalendarTaskList(assignee, selectedDate, selectedTasks)}
    </div>
  `;
}

function renderTaskCalendarTaskList(assignee, selectedDate, tasks) {
  if (!selectedDate) return "";
  if (!tasks.length) return "";

  return tasks.map(task => `
    <div class="calendar-task-line" title="${esc(task.name)}">
      <span>${esc(task.name)}</span>
      <span>${esc(taskCalendarLabels(task, selectedDate))}</span>
    </div>
  `).join("");
}

function shiftTaskCalendarWeek(days, prefix) {
  const weekStart = localDateFromIsoDate(ui.taskCalendarWeekStart) || startOfWeek();
  ui.taskCalendarWeekStart = isoDateFromLocalDate(addDays(weekStart, days));
  ui.taskCalendarSelectedDate = "";
  renderTaskCalendar(prefix);
}

function showCreateForm(sourceTask = null) {
  const group = activeGroup();
  const source = sourceTask || {};
  resetTaskCalendar();
  $("create-content").innerHTML = `
    <button class="back-btn" type="button" data-action="back">back</button>
    <h1 class="detail-description">${sourceTask ? "Duplicate task" : "New task"}</h1>

    <label class="field-label" for="new-name">Name</label>
    <input type="text" class="field-input" id="new-name" placeholder="Short task name" value="${esc(source.name)}">

    <label class="field-label" for="new-details">Details</label>
    <textarea class="field-textarea details-textarea" id="new-details" placeholder="Add details...">${esc(source.details)}</textarea>

    <label class="field-label" for="new-location">Location</label>
    <input type="text" class="field-input" id="new-location" placeholder="Optional location" value="${esc(source.location)}">

    <label class="field-label" for="new-assignee">Assignee</label>
    <select class="field-select" id="new-assignee">
      <option value="">Unassigned</option>
      ${group.members.map(name => `<option value="${esc(name)}"${source.assignee === name ? " selected" : ""}>${esc(name)}</option>`).join("")}
    </select>

    <div class="create-calendar" id="new-task-calendar"></div>

    <label class="field-label" for="new-scheduled">Scheduled Date</label>
    <div class="date-field">
      <input type="date" class="field-input" id="new-scheduled" value="${source.scheduledDate || ""}">
      <button class="date-clear" type="button" data-action="clear-new-scheduled" aria-label="Clear scheduled date">x</button>
    </div>

    <label class="field-label" for="new-due">Due Date</label>
    <div class="date-field">
      <input type="date" class="field-input" id="new-due" value="${source.dueDate || ""}">
      <button class="date-clear" type="button" data-action="clear-new-due" aria-label="Clear due date">x</button>
    </div>

    <div class="detail-actions">
      <button class="action-link primary" type="button" data-action="save-new">Create task</button>
    </div>
  `;

  renderTaskCalendar("new");
  openOverlay("create-overlay");
  setTimeout(() => $("new-name")?.focus(), 380);
}

function saveNewTask() {
  const group = activeGroup();
  const name = $("new-name").value.trim();
  if (!name) {
    toast("Add a name");
    return;
  }

  const task = {
    id: createId(),
    name,
    details: $("new-details").value.trim(),
    location: $("new-location").value.trim(),
    creator: group.currentUser,
    assignee: $("new-assignee").value || null,
    status: STATUSES.UP_NEXT,
    scheduledDate: $("new-scheduled").value || null,
    dueDate: $("new-due").value || null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    deleted: false
  };

  ui.currentTaskId = task.id;
  ui.detailMode = "read";
  ui.pendingDeleteId = null;
  commitChanges([{ entityType: "task", entityId: task.id, field: "_create", value: task }], "Task created");
  closeOverlay("create-overlay");
  showDetail(task.id);
}

function showLogForm() {
  const task = getTask();
  if (!task) return;

  $("log-content").innerHTML = `
    <button class="back-btn" type="button" data-action="back">back</button>
    <h1 class="detail-description">Log time</h1>
    <p class="detail-meta">${esc(task.name)}</p>

    <hr class="detail-rule">

    <label class="field-label" for="log-date">Date</label>
    <input type="date" class="field-input" id="log-date" value="${todayIsoDate()}">

    <label class="field-label" for="log-duration">Duration (minutes)</label>
    <input type="number" class="field-input" id="log-duration" placeholder="30" min="1" inputmode="numeric">

    <label class="field-label" for="log-notes">Notes (optional)</label>
    <input type="text" class="field-input" id="log-notes" placeholder="What did you work on...">

    <div class="detail-actions">
      <button class="action-link primary" type="button" data-action="save-log">Save</button>
    </div>
  `;

  openOverlay("log-overlay");
  setTimeout(() => $("log-duration")?.focus(), 380);
}

function saveLogEntry() {
  const group = activeGroup();
  const task = getTask();
  const duration = Number.parseInt($("log-duration").value, 10);
  if (!task) return;
  if (!duration || duration < 1) {
    toast("Enter a duration");
    return;
  }

  const log = {
    id: createId(),
    taskId: task.id,
    date: $("log-date").value || todayIsoDate(),
    duration,
    notes: $("log-notes").value.trim(),
    createdBy: group.currentUser,
    assigneeAtLog: task.assignee || null
  };

  commitChanges([{ entityType: "timelog", entityId: log.id, field: "_create", value: log }], `${formatDuration(duration)} logged`);
  closeOverlay("log-overlay");
}

async function lookupJoinCode() {
  const code = normalizeGroupCode($("join-code").value);
  if (!code) {
    toast("Enter an invite code");
    return;
  }

  ui.joinCode = code;
  const group = await fetchRemoteGroup(code);
  ui.pendingGroup = normalizeRemoteGroup(group);
  ui.screen = "join-user";
  renderAll();
}

async function createGroupFromForm() {
  const groupName = $("new-group-name").value.trim();
  const userName = normalizeMemberName($("new-group-user").value);
  const others = splitNames($("new-group-members").value);
  const members = normalizeMembers([userName, ...others]);

  if (!groupName) {
    toast("Add a group name");
    return;
  }
  if (!userName) {
    toast("Add your name");
    return;
  }
  if (members[0] !== userName) {
    toast("Names must be unique");
    return;
  }

  const remote = await createRemoteGroup({ name: groupName, members });
  const group = upsertGroup(remote, userName);
  appState.activeGroupCode = group.code;
  save();
  configureSync();
  ui.screen = "share";
  renderAll();
}

async function joinNewMember(groupCode, inputId) {
  const name = normalizeMemberName($(inputId).value);
  if (!name) {
    toast("Add your name");
    return;
  }

  const remote = await addRemoteGroupMember(groupCode, name);
  const group = upsertGroup(remote, name);
  appState.activeGroupCode = group.code;
  ui.addingUser = false;
  save();
  configureSync();
  closeSetup();
}

function joinExistingMember(member) {
  const remote = ui.pendingGroup;
  const group = upsertGroup(remote, member);
  appState.activeGroupCode = group.code;
  save();
  configureSync();
  closeSetup();
}

function selectGroup(code) {
  appState.activeGroupCode = code;
  ui.reportCreator = "";
  ui.reportAssignee = "";
  ui.currentTaskId = null;
  ui.pendingLeave = false;
  ui.addingUser = false;
  const group = activeGroup();
  ui.screen = group.currentUser ? null : "user-list";
  save();
  configureSync();
  renderAll();
}

function selectUser(member) {
  const group = activeGroup();
  if (!group || !hasMember(group.members, member)) return;
  group.currentUser = group.members.find(candidate => candidate.toLowerCase() === member.toLowerCase()) || member;
  ui.pendingLeave = false;
  ui.addingUser = false;
  save();
  configureSync();
  closeSetup();
}

function upsertGroup(remote, currentUser) {
  const normalized = normalizeRemoteGroup(remote);
  const existing = appState.groups[normalized.code] || createGroupState(normalized);
  existing.name = normalized.name;
  existing.members = normalized.members;
  if (normalized.createdAt) existing.createdAt = normalized.createdAt;
  if (currentUser) {
    existing.currentUser = normalized.members.find(member => member.toLowerCase() === currentUser.toLowerCase()) || currentUser;
  } else if (existing.currentUser && !hasMember(normalized.members, existing.currentUser)) {
    existing.currentUser = null;
  }
  existing.removedMembers = normalized.removedMembers;
  sanitizeGroupAssignments(existing);
  appState.groups[normalized.code] = existing;
  return existing;
}

function normalizeRemoteGroup(group) {
  return {
    code: normalizeGroupCode(group?.code),
    name: String(group?.name || "Untitled group").trim() || "Untitled group",
    members: normalizeMembers(group?.members || []),
    removedMembers: normalizeMembers(group?.removedMembers || []),
    createdAt: group?.createdAt
  };
}

function sanitizeGroupAssignments(group) {
  for (const task of group.tasks || []) {
    if (task.assignee && !hasMember(group.members, task.assignee)) {
      task.assignee = null;
    }
  }

  if (ui.reportAssignee && !hasMember(group.members, ui.reportAssignee)) {
    ui.reportAssignee = "";
  }
}

async function leaveCurrentUser() {
  const group = activeGroup();
  const name = group?.currentUser;
  if (!group || !name) return;

  const result = await removeRemoteGroupMember(group.code, name);

  if (result.deleted) {
    removeLocalGroup(group.code);
    toast("Group deleted");
    return;
  }

  const updated = upsertGroup(result);
  updated.currentUser = null;
  sanitizeGroupAssignments(updated);
  save();
  ui.pendingLeave = false;
  ui.screen = "user-list";
  configureSync();
  renderAll();
}

function removeLocalGroup(code) {
  const normalized = normalizeGroupCode(code);
  delete appState.groups[normalized];

  if (appState.activeGroupCode === normalized) {
    appState.activeGroupCode = null;
    const next = Object.values(appState.groups)[0];
    if (next) appState.activeGroupCode = next.code;
  }

  ui.pendingLeave = false;
  ui.addingUser = false;
  ui.reportCreator = "";
  ui.reportAssignee = "";
  ui.currentTaskId = null;
  closeOverlay("detail-overlay");
  closeOverlay("create-overlay");
  closeOverlay("log-overlay");
  save();
  configureSync();
  ui.screen = defaultScreen();
  renderAll();
}

function splitNames(value) {
  return String(value || "").split(/[\n,]/).map(normalizeMemberName).filter(Boolean);
}

function closeSetup() {
  ui.screen = null;
  ui.pendingGroup = null;
  ui.pendingLeave = false;
  ui.addingUser = false;
  stripInviteQuery();
  renderAll();
}

function showJoinScreen(code = "") {
  ui.joinCode = normalizeGroupCode(code);
  ui.pendingGroup = null;
  ui.addingUser = false;
  ui.screen = "join-code";
  renderAll();
}

function configureSync() {
  const group = activeGroup();
  if (!group) {
    sync?.stop();
    sync = null;
    ui.syncGroupCode = null;
    ui.syncStatus = "idle";
    return;
  }

  if (sync && ui.syncGroupCode === group.code) {
    return;
  }

  sync?.stop();
  ui.syncStatus = "idle";
  ui.syncGroupCode = group.code;
  sync = new FolioSync({
    groupCode: group.code,
    state: group,
    save,
    onStatus(status) {
      ui.syncStatus = status;
      if (!ui.screen && hasActiveSession()) renderHeader();
    },
    onChange() {
      sanitizeGroupAssignments(group);
      save();
      renderAll({ preserveOverlay: true });
    },
    onGroup(remote) {
      upsertGroup(remote);
      save();
      renderAll({ preserveOverlay: true });
    },
    onGroupDeleted(code) {
      removeLocalGroup(code);
    }
  });
  sync.start();
}

function inviteLink(code) {
  const url = new URL(globalThis.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("join", code);
  return url.toString();
}

function stripInviteQuery() {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has("join")) return;
  url.searchParams.delete("join");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function copyInvite() {
  const link = $("invite-link")?.value || inviteLink(activeGroup().code);
  await navigator.clipboard?.writeText(link);
  toast("Invite copied");
}

async function shareInvite() {
  const group = activeGroup();
  const link = inviteLink(group.code);
  if (navigator.share) {
    await navigator.share({ title: `Join ${group.name} on Folio`, text: `Join ${group.name} on Folio`, url: link });
  } else {
    await navigator.clipboard?.writeText(link);
    toast("Invite copied");
  }
}

function openOverlay(id) {
  $(id).classList.add("active");
  $(id).scrollTop = 0;
  document.body.classList.add("no-scroll");
}

function closeOverlay(id) {
  $(id).classList.remove("active");
  if (![...document.querySelectorAll(".overlay")].some(overlay => overlay.classList.contains("active"))) {
    document.body.classList.remove("no-scroll");
  }
}

function renderActiveOverlay() {
  if ($("detail-overlay").classList.contains("active")) {
    renderDetail();
  }
}

function bindEvents() {
  $("setup-content").addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    runAction(async () => {
      if (action === "show-create") {
        ui.screen = "create-group";
        renderAll();
      } else if (action === "show-join") {
        showJoinScreen();
      } else if (action === "lookup-join") {
        await lookupJoinCode();
      } else if (action === "join-member") {
        joinExistingMember(button.dataset.member);
      } else if (action === "join-new-member") {
        await joinNewMember(ui.pendingGroup.code, "join-new-name");
      } else if (action === "create-group") {
        await createGroupFromForm();
      } else if (action === "finish-share" || action === "close-setup") {
        closeSetup();
      } else if (action === "copy-invite") {
        await copyInvite();
      } else if (action === "share-native") {
        await shareInvite();
      } else if (action === "show-share") {
        ui.screen = "share";
        renderAll();
      } else if (action === "select-group") {
        selectGroup(button.dataset.code);
      } else if (action === "select-user") {
        selectUser(button.dataset.member);
      } else if (action === "start-add-user") {
        ui.addingUser = true;
        ui.pendingLeave = false;
        renderAll();
      } else if (action === "leave-user") {
        ui.addingUser = false;
        ui.pendingLeave = true;
        renderAll();
      } else if (action === "confirm-leave-user") {
        await leaveCurrentUser();
      } else if (action === "cancel-leave-user") {
        ui.pendingLeave = false;
        renderAll();
      } else if (action === "back-join-code") {
        showJoinScreen(ui.joinCode);
      } else if (action === "back-setup") {
        ui.screen = defaultScreen() === "intro" ? "intro" : "group-select";
        renderAll();
      }
    });
  });

  $("setup-content").addEventListener("keydown", event => {
    if (event.target?.id !== "group-new-name") return;
    if (event.key === "Enter") {
      event.preventDefault();
      runAction(() => joinNewMember(activeGroup().code, "group-new-name"));
    } else if (event.key === "Escape") {
      ui.addingUser = false;
      renderAll();
    }
  });

  $("switch-group-btn").addEventListener("click", () => {
    ui.addingUser = false;
    ui.screen = "group-select";
    renderAll();
  });

  $("switch-user-btn").addEventListener("click", () => {
    ui.pendingLeave = false;
    ui.addingUser = false;
    ui.screen = "user-list";
    renderAll();
  });

  $("nav-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    ui.view = button.dataset.view;
    ui.reportCreator = "";
    ui.reportAssignee = "";
    renderAll();
  });

  $("filters").addEventListener("click", event => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    ui.filter = button.dataset.filter;
    renderAll();
  });

  $("task-sections").addEventListener("click", event => {
    const add = event.target.closest("#add-task-btn");
    if (add) {
      showCreateForm();
      return;
    }

    const reportFilter = event.target.closest("[data-report-assignee]");
    if (reportFilter) {
      ui.reportAssignee = reportFilter.dataset.reportAssignee;
      renderAll();
      return;
    }

    const reportCreator = event.target.closest("[data-report-creator]");
    if (reportCreator) {
      ui.reportCreator = reportCreator.dataset.reportCreator;
      renderAll();
      return;
    }

    const item = event.target.closest(".task-item");
    if (item) {
      showDetail(item.dataset.id);
    }
  });

  $("detail-content").addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const task = getTask();
    const group = activeGroup();
    if (!task && action !== "back") return;

    if (action === "back") {
      if (ui.detailMode === "edit") {
        ui.detailMode = "read";
        renderDetail();
      } else {
        closeOverlay("detail-overlay");
        renderAll();
      }
    } else if (action === "edit-task") {
      resetTaskCalendar();
      ui.detailMode = "edit";
      renderDetail();
    } else if (action === "calendar-prev-week") {
      shiftTaskCalendarWeek(-7, "edit");
    } else if (action === "calendar-next-week") {
      shiftTaskCalendarWeek(7, "edit");
    } else if (action === "calendar-select-day") {
      ui.taskCalendarSelectedDate = button.dataset.date || "";
      renderTaskCalendar("edit");
    } else if (action === "clear-edit-scheduled") {
      $("edit-scheduled").value = "";
      if (task.scheduledDate) {
        commitChanges([{ entityType: "task", entityId: task.id, field: "scheduledDate", value: null }], "Scheduled date removed");
      }
    } else if (action === "clear-edit-due") {
      $("edit-due").value = "";
      if (task.dueDate) {
        commitChanges([{ entityType: "task", entityId: task.id, field: "dueDate", value: null }], "Due date removed");
      }
    } else if (action === "start") {
      commitChanges([
        { entityType: "task", entityId: task.id, field: "status", value: STATUSES.IN_PROGRESS },
        { entityType: "task", entityId: task.id, field: "assignee", value: group.currentUser }
      ], "Started and assigned to you");
    } else if (action === "complete") {
      commitChanges([
        { entityType: "task", entityId: task.id, field: "status", value: STATUSES.COMPLETED },
        { entityType: "task", entityId: task.id, field: "completedAt", value: new Date().toISOString() }
      ], "Done");
      closeOverlay("detail-overlay");
    } else if (action === "move-back") {
      commitChanges([
        { entityType: "task", entityId: task.id, field: "status", value: STATUSES.UP_NEXT },
        { entityType: "task", entityId: task.id, field: "completedAt", value: null }
      ], "Moved to up next");
    } else if (action === "reopen") {
      commitChanges([
        { entityType: "task", entityId: task.id, field: "status", value: STATUSES.UP_NEXT },
        { entityType: "task", entityId: task.id, field: "completedAt", value: null }
      ], "Reopened");
    } else if (action === "log-time") {
      showLogForm();
    } else if (action === "duplicate-task") {
      showCreateForm(task);
    } else if (action === "delete") {
      ui.pendingDeleteId = task.id;
      renderDetail();
      toast("Tap delete again to confirm");
    } else if (action === "confirm-delete") {
      commitChanges([{ entityType: "task", entityId: task.id, field: "deleted", value: true }], "Task deleted");
      closeOverlay("detail-overlay");
    }
  });

  $("create-content").addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "back") {
      closeOverlay("create-overlay");
    } else if (action === "save-new") {
      saveNewTask();
    } else if (action === "calendar-prev-week") {
      shiftTaskCalendarWeek(-7, "new");
    } else if (action === "calendar-next-week") {
      shiftTaskCalendarWeek(7, "new");
    } else if (action === "calendar-select-day") {
      ui.taskCalendarSelectedDate = button.dataset.date || "";
      renderTaskCalendar("new");
    } else if (action === "clear-new-scheduled") {
      $("new-scheduled").value = "";
    } else if (action === "clear-new-due") {
      $("new-due").value = "";
    }
  });

  $("create-content").addEventListener("change", event => {
    if (event.target?.id === "new-assignee") {
      renderTaskCalendar("new");
    }
  });

  $("log-content").addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "back") closeOverlay("log-overlay");
    if (button.dataset.action === "save-log") saveLogEntry();
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("log-overlay").classList.contains("active")) closeOverlay("log-overlay");
    else if ($("create-overlay").classList.contains("active")) closeOverlay("create-overlay");
    else if ($("detail-overlay").classList.contains("active")) closeOverlay("detail-overlay");
  });
}

function runAction(fn) {
  fn().catch(error => {
    toast(error instanceof Error ? error.message : String(error));
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // Offline caching is an enhancement.
  });
}

function init() {
  bindEvents();
  const inviteCode = normalizeGroupCode(new URLSearchParams(location.search).get("join"));
  if (inviteCode) {
    showJoinScreen(inviteCode);
    runAction(lookupJoinCode);
  } else {
    configureSync();
    renderAll();
  }
  registerServiceWorker();
}

init();
