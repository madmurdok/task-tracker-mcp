// Fixed left-to-right column order inside every swimlane. Lanes themselves are
// rendered in the order the API returns them (already sequence-ordered, with
// the "no release" lane first), so nothing here re-sorts them.
const STATUS_COLUMNS = [
  { status: "pending", label: "Pending" },
  { status: "blocked", label: "Blocked" },
  { status: "in_progress", label: "In progress" },
  { status: "done", label: "Done" },
  { status: "cancelled", label: "Cancelled" },
];

function laneTitle(lane) {
  if (lane.release_id === null) return "No release";
  const version = lane.release_version ?? "";
  return lane.release_name ? `${version} - ${lane.release_name}` : version;
}

// Which cards have their description expanded, keyed by task id. Same
// "outside the render functions" trick as collapsedLanes below - description
// is hidden by default (too much noise for a glance at the board), but an
// expanded card needs to stay expanded across the next 1.5s poll's full DOM
// teardown+rebuild instead of snapping shut again.
const expandedCards = new Set();

function createCard(task, statusLabel) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.status = task.status;
  // is_stale is independent of status (only ever true alongside
  // "in_progress") - about to be auto-reclaimed by the next get_next_task
  // call, so it gets its own highlight rather than reusing a status color.
  if (task.is_stale) card.classList.add("is-stale");

  const title = document.createElement("h4");
  title.className = "card-title";
  title.textContent = task.title;
  card.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "card-meta";

  const status = document.createElement("span");
  status.className = "card-status";
  status.dataset.status = task.status;
  status.textContent = statusLabel;
  meta.appendChild(status);

  const priority = document.createElement("span");
  priority.className = "card-priority";
  priority.textContent = `priority ${task.priority}`;
  meta.appendChild(priority);

  if (task.epic_name) {
    const epic = document.createElement("span");
    epic.className = "card-epic";
    epic.textContent = task.epic_name;
    meta.appendChild(epic);
  }

  const owner = document.createElement("span");
  owner.className = "card-owner";
  // Kept visible (not omitted) even when unclaimed, so "nobody's working
  // this" is as scannable at a glance as "session X is".
  owner.textContent = task.owner_session_id ?? "unclaimed";
  if (!task.owner_session_id) owner.classList.add("card-owner-unclaimed");
  meta.appendChild(owner);

  if (task.is_stale) {
    const stale = document.createElement("span");
    stale.className = "card-stale-flag";
    stale.textContent = "stale lock";
    meta.appendChild(stale);
  }

  card.appendChild(meta);

  if (task.description) {
    const description = document.createElement("p");
    description.className = "card-description";
    description.textContent = task.description;

    title.classList.add("has-details");
    const applyExpanded = () => {
      const isExpanded = expandedCards.has(task.id);
      title.classList.toggle("expanded", isExpanded);
      description.hidden = !isExpanded;
    };
    title.addEventListener("click", () => {
      if (expandedCards.has(task.id)) {
        expandedCards.delete(task.id);
      } else {
        expandedCards.add(task.id);
      }
      applyExpanded();
    });
    applyExpanded();

    card.appendChild(description);
  }

  return card;
}

function createColumn(column, tasks) {
  const section = document.createElement("section");
  section.className = "column";
  section.dataset.status = column.status;

  const heading = document.createElement("h3");
  heading.className = "column-title";
  heading.textContent = column.label;

  const count = document.createElement("span");
  count.className = "column-count";
  count.textContent = String(tasks.length);
  heading.appendChild(count);

  section.appendChild(heading);

  const cards = document.createElement("div");
  cards.className = "column-cards";
  for (const task of tasks) {
    cards.appendChild(createCard(task, column.label));
  }
  section.appendChild(cards);

  return section;
}

// Which release swimlanes are collapsed, keyed by release_id ("__none__" for
// the no-release lane). Deliberately a plain in-memory Set, not persisted
// anywhere - purely local UI state that resets on reload, per Item 8's "no
// interaction with the tracker itself" constraint. Survives across re-renders
// (each poll tears down and rebuilds every lane from scratch) precisely
// because it lives outside renderBoard/createLane, not inside the DOM.
const collapsedLanes = new Set();

function laneKey(lane) {
  return lane.release_id ?? "__none__";
}

function createLane(lane) {
  const key = laneKey(lane);
  const section = document.createElement("section");
  section.className = "lane";

  const columns = document.createElement("div");
  columns.className = "lane-columns";
  // Every lane renders all five columns, even empty ones, so the status
  // columns stay vertically aligned across lanes when scanning the board.
  for (const column of STATUS_COLUMNS) {
    columns.appendChild(
      createColumn(
        column,
        lane.tasks.filter((task) => task.status === column.status),
      ),
    );
  }

  const heading = document.createElement("h2");
  heading.className = "lane-title";
  heading.textContent = laneTitle(lane);
  // A collapsed lane's columns are still rebuilt above with this poll's
  // fresh data - only their visibility is hidden - so re-expanding later
  // shows current state, not a stale snapshot from before the collapse.
  const applyCollapsed = () => {
    const isCollapsed = collapsedLanes.has(key);
    section.classList.toggle("collapsed", isCollapsed);
    columns.hidden = isCollapsed;
  };
  heading.addEventListener("click", () => {
    if (collapsedLanes.has(key)) {
      collapsedLanes.delete(key);
    } else {
      collapsedLanes.add(key);
    }
    applyCollapsed();
  });
  applyCollapsed();

  section.appendChild(heading);
  section.appendChild(columns);

  return section;
}

function renderBoard(board) {
  const title = document.getElementById("board-title");
  const container = document.getElementById("board");
  const driftBanner = document.getElementById("doc-drift-banner");

  title.textContent = board.project_name;
  document.title = `${board.project_name} - task-tracker-mcp dashboard`;
  driftBanner.hidden = !board.doc_drift;

  // Called on every poll now, not just once - rebuild the lanes from scratch
  // each time rather than trying to patch the existing DOM in place.
  while (container.firstChild) container.removeChild(container.firstChild);
  for (const lane of board.lanes) {
    container.appendChild(createLane(lane));
  }
}

function showError(message) {
  const errorState = document.getElementById("error-state");
  errorState.textContent = message;
  errorState.hidden = false;
}

const POLL_INTERVAL_MS = 1500;
const CLOCK_TICK_MS = 1000;

let lastUpdatedAt = null;
let connected = true;
let pollTimer = null;
let clockTimer = null;

function setConnectionStatus(state, message) {
  const status = document.getElementById("connection-status");
  status.hidden = false;
  status.dataset.state = state;
  status.textContent = message;
}

// Runs once a second independently of the poll interval, purely to keep the
// "Xs ago" label ticking between polls. Must defer to whatever the most
// recent poll actually found - otherwise this would blindly recompute
// "connected" from a stale lastUpdatedAt every second and stomp on a
// "Disconnected" message pollOnce just set, since the two timers run on
// unrelated schedules.
function tickConnectionLabel() {
  if (!connected || lastUpdatedAt === null) return;
  const seconds = Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000));
  setConnectionStatus("connected", seconds <= 1 ? "Last updated just now" : `Last updated ${seconds}s ago`);
}

function stopPolling() {
  if (pollTimer !== null) clearInterval(pollTimer);
  if (clockTimer !== null) clearInterval(clockTimer);
  pollTimer = null;
  clockTimer = null;
}

async function pollOnce(projectId) {
  let res;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/board`);
  } catch {
    // The server is unreachable (killed, network hiccup) - this is transient,
    // so keep the last-rendered board on screen and keep retrying on the next
    // tick rather than blanking the page or giving up.
    connected = false;
    setConnectionStatus("disconnected", "Disconnected - retrying...");
    return;
  }

  // The API answers an unknown project with 404 + { error }; fall back to the
  // raw status when the body isn't the JSON we expect.
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Unlike a network failure, a reachable server saying "unknown project"
    // won't fix itself on retry - stop polling and show it as fatal instead
    // of retrying the same failing request forever.
    showError(body?.error ?? `Could not load the board (HTTP ${res.status}).`);
    stopPolling();
    return;
  }
  if (!body) {
    connected = false;
    setConnectionStatus("disconnected", "Disconnected - retrying...");
    return;
  }

  renderBoard(body);
  connected = true;
  lastUpdatedAt = Date.now();
  tickConnectionLabel();
}

function loadBoard() {
  const projectId = new URLSearchParams(window.location.search).get("project");
  if (!projectId) {
    showError("No project selected. Go back to the projects list and pick one.");
    return;
  }

  pollOnce(projectId);
  pollTimer = setInterval(() => pollOnce(projectId), POLL_INTERVAL_MS);
  clockTimer = setInterval(tickConnectionLabel, CLOCK_TICK_MS);
}

function wireShutdownButton() {
  const button = document.getElementById("shutdown-button");
  button.addEventListener("click", async () => {
    if (!window.confirm("Stop the dashboard server?")) return;
    button.disabled = true;
    button.textContent = "Stopping...";
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch {
      // Expected once the process actually exits mid-response - the
      // button's final state below covers this either way.
    }
    button.textContent = "Dashboard stopped";
    stopPolling();
  });
}

loadBoard();
wireShutdownButton();
