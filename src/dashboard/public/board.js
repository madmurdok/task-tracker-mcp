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

function createLane(lane) {
  const section = document.createElement("section");
  section.className = "lane";

  const heading = document.createElement("h2");
  heading.className = "lane-title";
  heading.textContent = laneTitle(lane);
  section.appendChild(heading);

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

  for (const lane of board.lanes) {
    container.appendChild(createLane(lane));
  }
}

function showError(message) {
  const errorState = document.getElementById("error-state");
  errorState.textContent = message;
  errorState.hidden = false;
}

async function loadBoard() {
  const projectId = new URLSearchParams(window.location.search).get("project");
  if (!projectId) {
    showError("No project selected. Go back to the projects list and pick one.");
    return;
  }

  let res;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/board`);
  } catch {
    showError("Could not reach the dashboard server.");
    return;
  }

  // The API answers an unknown project with 404 + { error }; fall back to the
  // raw status when the body isn't the JSON we expect.
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    showError(body?.error ?? `Could not load the board (HTTP ${res.status}).`);
    return;
  }
  if (!body) {
    showError("The dashboard server returned an unreadable response.");
    return;
  }

  renderBoard(body);
}

loadBoard();
