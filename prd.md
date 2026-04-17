# Folio — Product Requirements Document (v1)

## Overview

Folio is a lightweight task management app for groups of friends collaborating on projects together. It follows a local-first architecture: once a user has joined or created a group, the app works offline using the browser's local storage, and syncs state across devices through a minimal Cloudflare Workers backend. There are no user accounts or passwords — users identify themselves by name inside each group.

## Goals

- Simple, fast, works offline
- Real-time sync across 4 users with no conflicts that matter
- Zero infrastructure complexity — single Cloudflare Worker, no database to manage
- Feels like a personal tool, not enterprise software

## Non-Goals

- User authentication or access control
- More than ~10 concurrent users
- File attachments, comments, or rich text
- Mobile native apps (responsive web only)
- Notifications (push, email, etc.)

---

## Users

Any friend group. On first visit, the user either creates a group or joins one with an invite code. Names are unique within a group, but the same browser can use a different name in each group. No passwords, no sessions.

---

## Data Model

### Task

| Field         | Type             | Notes                                      |
|---------------|------------------|---------------------------------------------|
| id            | string (UUID)    | Client-generated                            |
| name          | string           | Required. Short task name shown in lists.   |
| details       | string           | Optional longer task details.               |
| creator       | string           | Name of the person who created the task     |
| assignee      | string \| null   | Name of the assigned person, or unassigned  |
| status        | enum             | `up_next`, `in_progress`, `completed`       |
| dueDate       | string \| null   | ISO date (YYYY-MM-DD), optional             |
| createdAt     | string           | ISO datetime, set on creation               |
| completedAt   | string \| null   | ISO datetime, set when marked done          |
| deleted       | boolean          | Tombstone flag for sync                     |

### TimeLog

| Field         | Type             | Notes                                      |
|---------------|------------------|---------------------------------------------|
| id            | string (UUID)    | Client-generated                            |
| taskId        | string           | References the parent task                  |
| date          | string           | ISO date (YYYY-MM-DD)                       |
| duration      | number           | Minutes                                     |
| notes         | string           | Optional freeform text                      |
| createdBy     | string           | Name of the person who logged the time      |

### Mutation

The unit of sync. Every change the client makes is recorded as a mutation before being applied locally.

| Field         | Type             | Notes                                      |
|---------------|------------------|---------------------------------------------|
| id            | string (UUID)    | Unique mutation ID                          |
| entityType    | enum             | `task` or `timelog`                         |
| entityId      | string           | The task or timelog ID                      |
| field         | string           | The field that changed (or `_create` / `_delete`) |
| value         | any              | The new value                               |
| timestamp     | string           | Hybrid logical clock (HLC) value            |
| author        | string           | Name of the user who made the change        |
| deviceId      | string           | Client-generated device UUID                |

---

## Sync Architecture

### Principles

- **Local-first**: all reads and writes happen against localStorage immediately. The app never waits for the network.
- **Last-write-wins per field**: conflicts are resolved by comparing HLC timestamps. The highest timestamp wins. This is sufficient because the data is flat and conflicts are rare among 4 users.
- **Append-only mutation log**: clients and server maintain an ordered log of mutations. Sync is the exchange of mutations the other side hasn't seen.
- **Time logs are append-only sets**: they are created but never edited, so merging is a simple union with dedup by ID.
- **Deletes are tombstones**: a deleted task gets `deleted: true` and is filtered out of the UI. Tombstones are garbage-collected by the server after 30 days.

### Hybrid Logical Clock (HLC)

Each client maintains an HLC consisting of:
- `wallTime`: `Date.now()`, monotonically increasing
- `counter`: incremented when wall time hasn't advanced
- `deviceId`: the client's unique device UUID

Serialized as: `{wallTime}:{counter:04d}:{deviceId}`

This ensures a total ordering of mutations even when clocks are slightly skewed.

### Sync Protocol

**Transport**: WebSocket via Cloudflare Durable Object, with HTTP POST fallback for initial load.

**On connect**:
1. Client sends `{ type: 'sync', since: '<last confirmed HLC timestamp>' }`
2. Server responds with `{ type: 'mutations', items: [...] }` — all mutations since that timestamp
3. Client applies incoming mutations (LWW merge), then sends its own unconfirmed mutations
4. Server merges, broadcasts to other connected clients

**Live updates**:
- When a client writes a mutation, it applies locally and sends `{ type: 'push', mutations: [...] }` to the server
- Server merges, stores, and broadcasts to all other connected clients
- If the WebSocket is disconnected, mutations queue locally and flush on reconnect

**Consistency**: eventual. All clients converge to the same state once they've exchanged all mutations. There is no coordination or locking.

### Group

| Field     | Type             | Notes                                      |
|-----------|------------------|---------------------------------------------|
| code      | string           | Server-generated invite code                |
| name      | string           | Display name, not globally unique           |
| members   | string[]         | Unique member names within the group        |
| createdAt | string           | ISO datetime                                |

### Server (Cloudflare Worker + Durable Object)

One Worker, one Durable Object class (`FolioRoom`), one instance per invite code.

**Durable Object responsibilities**:
- Stores the canonical mutation log (Durable Object storage, key-value)
- Accepts WebSocket connections from clients
- Merges incoming mutations
- Broadcasts new mutations to connected clients
- Materializes current state on demand for initial sync

**Endpoints**:

| Method | Path           | Purpose                            |
|--------|----------------|------------------------------------|
| POST   | /api/groups    | Create a group                     |
| GET    | /api/groups/:code | Fetch group metadata             |
| POST   | /api/groups/:code/members | Add a unique member name |
| DELETE | /api/groups/:code/members | Remove a member name; deletes group if last member leaves |
| GET    | /api/groups/:code/sync | Upgrade to WebSocket         |
| POST   | /api/groups/:code/sync | HTTP fallback: send/receive mutations |
| GET    | /api/groups/:code/state | Full materialized group state |

The Worker is stateless — it just routes to the Durable Object.

---

## Features

### First Visit

- Ask whether the user is joining a group or creating a new group
- Join flow: enter invite code, choose an existing member name or add a new unique name
- Create flow: enter group name, choose your name, optionally add other member names
- After creating a group, show a share screen with an invite link and share/copy actions

### Dashboard

The main view. Shows all tasks organized by status in this order:

1. **In Progress** — tasks currently being worked on
2. **Up Next** — tasks ready to start
3. **Completed** — finished tasks, shown with reduced opacity

Each task item shows:
- Name (primary text)
- Assignee (or "unassigned")
- Creator name
- Total time logged (if any)
- Due date indicator: "overdue" in red if past due, "due soon" if within 2 days

**Filters** (above the task list):
- All Tasks (default)
- Assigned to Me
- Created by Me

**Add Task**: a `+ new task` button appears in the Up Next section header.

### Task Detail

Tapping a task opens a slide-in overlay with:

- Name (editable inline, required)
- Details (editable inline — textarea that saves on blur)
- Assignee (dropdown of group members + unassigned, saves on change)
- Due date (date picker, saves on change)
- Status label
- Creator and creation date
- Total time logged

**Status-dependent actions**:

| Status      | Actions                                    |
|-------------|--------------------------------------------|
| Up Next     | **Start task** — sets status to `in_progress`, assigns to current user |
| In Progress | **Log time** — opens the time logging form  |
|             | **Mark done** — sets status to `completed`, records completedAt |
|             | **Move to up next** — sets status back to `up_next` |
| Completed   | **Reopen** — sets status to `up_next`, clears completedAt |

All statuses show a **Delete** action (muted style, with confirmation).

**Time log history**: if the task has logged time, display entries below the actions sorted newest first. Each entry shows date, duration, and optional notes.

### Create Task

Slide-in form with:
- Name (text input, required)
- Details (textarea, optional)
- Assignee (dropdown, optional — defaults to unassigned)
- Due date (date picker, optional)

Creator is set automatically to the current user. Status is always `up_next`. Saves on submit.

### Log Time

Slide-in form with:
- Date (date picker, defaults to today)
- Duration in minutes (number input, required)
- Notes (text input, optional)

Saves on submit. The entry is appended to the task's time log.

### Reports

A separate view (tab in the nav) showing time logged per week as a horizontal bar chart.

**Filters**: by person (show all, or filter to a specific name). Filters apply to the assignee on the task at the time the log was created.

Each bar shows:
- Week label (date of the Monday)
- Horizontal bar proportional to the max week
- Duration label

A total is shown below the chart.

---

## Client Architecture

### Storage

All state lives in localStorage under a single key as JSON:
- `deviceId`: global device UUID
- `activeGroupCode`: invite code for the active local group
- `groups`: map keyed by invite code, each containing group metadata, tasks, time logs, mutation queue, and last sync timestamp

### Offline Behavior

- All interactions write to localStorage immediately and update the UI
- Mutations are queued for sync
- When the WebSocket connects (or reconnects), the queue is flushed
- No loading states — the app is always usable

### Device ID

A random UUID generated on first visit, stored in localStorage. Used in the HLC and mutation tracking. Separate from the user name (a single user could use multiple devices).

---

## Tech Stack

| Layer    | Technology                          |
|----------|-------------------------------------|
| Frontend | Single HTML file, vanilla JS, CSS   |
| Backend  | Cloudflare Worker + Durable Object  |
| Storage  | localStorage (client), DO storage (server) |
| Sync     | WebSocket (primary), HTTP (fallback)|
| Hosting  | Cloudflare Pages (static HTML) or inline in Worker |

No build step. No framework. No dependencies.

---

## Design

Matches the existing Locus/Marginalia design system:

- **Font**: Crimson Pro (serif) for body, system monospace for meta text
- **Colors**: `#FFFFF8` paper background, `#111` ink, `#8B0000` dark red accents, `#e0dcd6` rules
- **Layout**: single column, max-width 640px, generous padding
- **Interactions**: slide-in overlays from the right, subtle fade animations, no modals
- **Tone**: quiet, editorial, tool-like

---

## Implementation Plan

### Phase 1 — Offline Client (done)

The current `tasks.html` prototype. All features work with localStorage only, no sync.

### Phase 2 — Sync Infrastructure

1. Implement HLC on the client
2. Refactor writes to produce mutations (mutation log pattern)
3. Build the Cloudflare Worker + Durable Object
4. Implement WebSocket sync protocol
5. Add mutation queue with flush-on-reconnect
6. Add connection status indicator in the UI (subtle, monospace, in the header stats line)

### Phase 3 — Polish

1. Name selection from a list instead of freeform input
2. Confirmation on delete
3. "Not you?" name switcher
4. Sync conflict indicator (if a field was overwritten by another user since you opened the detail view, show a subtle note — not a blocker, just informational)
5. Garbage collection of tombstones

---

## Open Questions

1. **Should time logs be editable or deletable?** Current design is append-only. Editing adds sync complexity. Recommendation: allow delete only (tombstone), no editing.
2. **Task ordering within a status group?** Currently unordered (newest first by creation date). Manual drag-to-reorder would require a fractional index CRDT. Recommendation: skip for v1, sort by creation date.
3. **Member management beyond adding names?** Current design only supports adding stable names to a group. Rename/delete would need task and time-log attribution rules.
