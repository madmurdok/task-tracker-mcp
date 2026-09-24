// Read once - board.js is a fresh script load per page navigation, so the
// URL's query string can't change out from under a running instance of it.
const PROJECT_ID = new URLSearchParams(window.location.search).get("project");

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
  // Cancelled tasks are noise for "how much is left in this lane" at a
  // glance, so they're excluded from the count even though lane.tasks
  // (from getBoardData) still includes them for the Cancelled column.
  const count = lane.tasks.filter((task) => task.status !== "cancelled").length;
  const base = lane.release_id === null
    ? "Backlog"
    : lane.release_name
      ? `Release-${lane.release_version ?? ""} - ${lane.release_name}`
      : `Release-${lane.release_version ?? ""}`;
  return `${base} (${count})`;
}

// Which cards have their description expanded, keyed by task id. Same
// "outside the render functions" trick as collapsedLanes below - description
// is hidden by default (too much noise for a glance at the board), but an
// expanded card needs to stay expanded across the next 1.5s poll's full DOM
// teardown+rebuild instead of snapping shut again.
const expandedCards = new Set();

function createCard(task, statusLabel, codePrefix) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.status = task.status;
  // is_stale is independent of status (only ever true alongside
  // "in_progress") - about to be auto-reclaimed by the next get_next_task
  // call, so it gets its own highlight rather than reusing a status color.
  if (task.is_stale) card.classList.add("is-stale");

  const title = document.createElement("h4");
  title.className = "card-title";
  // PREFIX-N prefix (e.g. "TTM-52") so a card can be pointed to as a stable
  // human-facing handle, matching the code get_task/list_tasks surface.
  title.textContent = `${codePrefix}-${task.task_number} - ${task.title}`;
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

    // An explicit button, not just a click handler on the title text - a
    // bare cursor:pointer + CSS-content chevron on the title turned out too
    // subtle to notice as an interactive element at a glance.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "card-toggle";
    const applyExpanded = () => {
      const isExpanded = expandedCards.has(task.id);
      toggle.textContent = isExpanded ? "▾ Hide details" : "▸ Show details";
      toggle.setAttribute("aria-expanded", String(isExpanded));
      description.hidden = !isExpanded;
    };
    toggle.addEventListener("click", () => {
      if (expandedCards.has(task.id)) {
        expandedCards.delete(task.id);
      } else {
        expandedCards.add(task.id);
      }
      applyExpanded();
    });
    applyExpanded();

    card.appendChild(toggle);
    card.appendChild(description);
  }

  // No button at all for an unsliced task (TTM-84) - same "nothing to show,
  // nothing to click" rule the description toggle above already follows.
  // N counts only "done": a "failed" or "skipped" slice is finished but not
  // successfully so, and the button is meant to answer "how much of this is
  // actually done", not "how much is no longer open".
  if (task.slices && task.slices.length > 0) {
    const done = task.slices.filter((slice) => slice.status === "done").length;
    const slicesButton = document.createElement("button");
    slicesButton.type = "button";
    slicesButton.className = "card-slices-button";
    slicesButton.textContent = `Slices ${done}/${task.slices.length}`;
    slicesButton.addEventListener("click", () => showSliceDialog(task, codePrefix));
    card.appendChild(slicesButton);
  }

  return card;
}

function createColumn(column, tasks, codePrefix) {
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
    cards.appendChild(createCard(task, column.label, codePrefix));
  }
  section.appendChild(cards);

  return section;
}

// Which release swimlanes are collapsed, keyed by release_id ("__none__" for
// the no-release lane). Survives across re-renders (each poll tears down and
// rebuilds every lane from scratch) precisely because it lives outside
// renderBoard/createLane, not inside the DOM - same trick expandedCards uses.
const collapsedLanes = new Set();
// Tracks which lane keys have already had their one-time initial state
// (from localStorage, or the release_status default) applied this page
// load, so later polls don't re-run that logic and stomp a live toggle.
const initializedLaneKeys = new Set();

function laneKey(lane) {
  return lane.release_id ?? "__none__";
}

function collapseStorageKey(key) {
  return `ttmcp-dashboard:collapsed:${PROJECT_ID}:${key}`;
}

// localStorage can throw (private browsing, storage disabled, quota) - this
// is a nice-to-have persistence layer, not core functionality, so any
// failure here just falls back to in-memory-only behavior for the session.
function loadStoredCollapse(key) {
  try {
    const raw = localStorage.getItem(collapseStorageKey(key));
    return raw === null ? null : raw === "true";
  } catch {
    return null;
  }
}

function storeCollapse(key, isCollapsed) {
  try {
    localStorage.setItem(collapseStorageKey(key), String(isCollapsed));
  } catch {
    // Ignored - see loadStoredCollapse.
  }
}

// A release that's already shipped - or one that was cancelled, which is just
// as finished from "what's left to work on" - should default to collapsed
// (out of the way of active work) the first time it's ever seen; a stored
// preference (an explicit earlier click, from this session or a previous page
// load) always wins over that default once one exists.
function ensureLaneInitialized(lane, key) {
  if (initializedLaneKeys.has(key)) return;
  initializedLaneKeys.add(key);
  const stored = loadStoredCollapse(key);
  const shouldCollapse =
    stored !== null ? stored : lane.release_status === "released" || lane.release_status === "cancelled";
  if (shouldCollapse) collapsedLanes.add(key);
}

function createLane(lane, codePrefix) {
  const key = laneKey(lane);
  ensureLaneInitialized(lane, key);
  const section = document.createElement("section");
  section.className = "lane";
  // Only set when there actually is a status (the Backlog lane has none):
  // assigning null would stringify to the literal "null" in the DOM, which
  // reads as a real status to any future [data-release-status="..."] rule.
  if (lane.release_status) section.dataset.releaseStatus = lane.release_status;

  const columns = document.createElement("div");
  columns.className = "lane-columns";
  // Every lane renders all five columns, even empty ones, so the status
  // columns stay vertically aligned across lanes when scanning the board.
  for (const column of STATUS_COLUMNS) {
    columns.appendChild(
      createColumn(
        column,
        lane.tasks.filter((task) => task.status === column.status),
        codePrefix,
      ),
    );
  }

  const headerRow = document.createElement("div");
  headerRow.className = "lane-header";

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
    const isCollapsed = !collapsedLanes.has(key);
    if (isCollapsed) {
      collapsedLanes.add(key);
    } else {
      collapsedLanes.delete(key);
    }
    storeCollapse(key, isCollapsed);
    applyCollapsed();
  });
  applyCollapsed();
  headerRow.appendChild(heading);

  // A collapsed cancelled lane looks like any other collapsed lane, so the
  // badge (not just the red header) is what says *why* it's parked - it stays
  // legible whether the lane is open or shut.
  if (lane.release_status === "cancelled") {
    const badge = document.createElement("span");
    badge.className = "lane-badge lane-badge-cancelled";
    badge.textContent = "Cancelled";
    headerRow.appendChild(badge);
  }

  // Rendered exactly when there's something to show: a release only gets a
  // plan once someone writes one (upsert_plan), and the Backlog lane never
  // has a release to plan at all. Placed before Release notes, per the
  // owner's own phrasing of where the button belongs, and - like that button
  // and Cancellation reason - a separate click target from the heading so
  // opening it doesn't also toggle the lane's collapse state.
  if (lane.plan) {
    const planButton = document.createElement("button");
    planButton.type = "button";
    planButton.className = "lane-notes-button";
    planButton.textContent = "Plan";
    planButton.addEventListener("click", () => showPlanDialog(lane, codePrefix));
    headerRow.appendChild(planButton);
  }

  if (lane.release_notes) {
    const notesButton = document.createElement("button");
    notesButton.type = "button";
    notesButton.className = "lane-notes-button";
    notesButton.textContent = "Release notes";
    // A separate click target from the heading, so reading notes doesn't
    // also toggle the lane's collapse state.
    notesButton.addEventListener("click", () => showReleaseNotes(laneTitle(lane), lane.release_notes));
    headerRow.appendChild(notesButton);
  }

  // Reuses the release-notes button and dialog rather than inventing a second
  // read-more mechanism: it's the same "long text that doesn't belong in a
  // lane header" problem, and the two can't collide - a cancelled release
  // never reached release_it, so it has no release_notes to show.
  if (lane.release_cancellation_reason) {
    const reasonButton = document.createElement("button");
    reasonButton.type = "button";
    reasonButton.className = "lane-notes-button";
    reasonButton.textContent = "Cancellation reason";
    reasonButton.addEventListener("click", () =>
      showReleaseNotes(`${laneTitle(lane)} - cancellation reason`, lane.release_cancellation_reason),
    );
    headerRow.appendChild(reasonButton);
  }

  section.appendChild(headerRow);
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
    container.appendChild(createLane(lane, board.project_code_prefix));
  }

  // The slice dialog lives outside #board (see board.html), so tearing down
  // and rebuilding the board above never touches it - it stays open across
  // this poll on its own. What it does need is fresh content: re-render it
  // in place from this same payload rather than leaving it to go stale.
  refreshOpenSliceDialog(board);
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

function showReleaseNotes(title, notes) {
  document.getElementById("release-notes-title").textContent = title;
  document.getElementById("release-notes-body").textContent = notes;
  document.getElementById("release-notes-dialog").showModal();
}

function wireReleaseNotesDialog() {
  const dialog = document.getElementById("release-notes-dialog");
  document.getElementById("release-notes-close").addEventListener("click", () => dialog.close());
}

// task_id/step/note/new_since_approval only (see board.ts's BoardPlanItem) -
// title, code and live status come from joining against lane.tasks here,
// the one place that join needs to happen, rather than the payload carrying
// a second copy of either.
function showPlanDialog(lane, codePrefix) {
  const plan = lane.plan;
  const tasksById = new Map(lane.tasks.map((task) => [task.id, task]));

  document.getElementById("plan-title").textContent = `${laneTitle(lane)} - plan`;

  const approval = document.getElementById("plan-approval");
  approval.textContent =
    plan.status === "approved"
      ? `Approved by ${plan.approved_by}${plan.approval_note ? ` - "${plan.approval_note}"` : ""}`
      : "Draft - not yet approved";

  // The owner's cue to re-approve: named tasks the plan doesn't cover, not
  // just a bare "drifted" flag - codesFor's human-facing rendering (see
  // plans.ts's approvePlan refusal message) is what this mirrors, joined
  // against lane.tasks here instead of carrying task_number a second time.
  const driftWarning = document.getElementById("plan-drift-warning");
  if (plan.drifted) {
    const names = plan.unplanned_task_ids
      .map((id) => tasksById.get(id))
      .filter((task) => task !== undefined)
      .map((task) => `${codePrefix}-${task.task_number}`);
    driftWarning.textContent =
      names.length > 0
        ? `This plan is out of date: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} not in it. Re-approve in chat once the order covers them.`
        : "This plan is out of date - the batch has changed since it was written. Re-approve in chat.";
    driftWarning.hidden = false;
  } else {
    driftWarning.hidden = true;
  }

  const stepsList = document.getElementById("plan-steps");
  while (stepsList.firstChild) stepsList.removeChild(stepsList.firstChild);

  // Items already arrive step ASC, position ASC (see plans.ts's
  // listPlanItems) - group consecutive same-step items into one <li> rather
  // than re-sorting, since they can run in parallel.
  let currentGroup = null;
  for (const item of plan.items) {
    if (!currentGroup || currentGroup.step !== item.step) {
      currentGroup = { step: item.step, items: [] };
      const stepEl = document.createElement("li");
      stepEl.className = "plan-step";
      const stepLabel = document.createElement("span");
      stepLabel.className = "plan-step-label";
      stepLabel.textContent = `Step ${item.step}`;
      stepEl.appendChild(stepLabel);
      currentGroup.el = stepEl;
      stepsList.appendChild(stepEl);
    }

    const task = tasksById.get(item.task_id);
    const row = document.createElement("div");
    row.className = "plan-item";
    // Struck through for done/cancelled, the same statuses a card itself
    // fades and strikes (see .card[data-status="cancelled"] in style.css) -
    // "already-finished parts of the plan" is exactly what the owner asked
    // for. A task the plan still names but that left the release (orphaned -
    // see BoardPlan's comment on why board.ts doesn't surface that set) has
    // no entry in tasksById; render its bare id rather than dropping the row
    // silently, since the plan did still order it.
    row.dataset.status = task ? task.status : "unknown";
    const label = task ? `${codePrefix}-${task.task_number} - ${task.title}` : item.task_id;
    row.textContent = item.note ? `${label} (${item.note})` : label;

    if (item.new_since_approval) {
      const badge = document.createElement("span");
      badge.className = "plan-item-new";
      badge.textContent = "new";
      row.appendChild(badge);
    }

    currentGroup.el.appendChild(row);
  }

  document.getElementById("plan-dialog").showModal();
}

function wirePlanDialog() {
  const dialog = document.getElementById("plan-dialog");
  document.getElementById("plan-close").addEventListener("click", () => dialog.close());
}

// Same order as SLICE_PHASES in src/domain/slices.ts.
const SLICE_PHASES = ["design", "implement", "verify", "measure"];
const SLICE_PHASE_LABELS = { design: "Design", implement: "Implement", verify: "Verify", measure: "Measure" };
const SLICE_STATUS_LABELS = {
  pending: "Pending",
  in_progress: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

// Which slice detail rows are expanded, keyed by slice id - survives the
// dialog's own re-renders (on poll and on reopen) the same way expandedCards
// survives a full board re-render. Re-slicing a task (setTaskSlices) hands
// out fresh slice ids, so a stale entry here just never matches anything
// again - same as expandedCards for a deleted task.
const expandedSliceRows = new Set();

// The task id the slice dialog is currently showing, or null when it's
// closed - what refreshOpenSliceDialog checks on every poll to decide
// whether there's anything to re-render.
let openSliceTaskId = null;

// Slices arrive from the board API already ordered step ASC, position ASC
// per task (see board.ts's listSlicesForTasks) - so grouping walks that
// order directly rather than filtering by SLICE_PHASES, which would sort by
// phase instead of by step (TTM-88). A phase group starts whenever the phase
// differs from the previous group's phase, so a task sliced
// measure -> implement -> measure renders as three groups, not two merged
// under "measure" - a phase that recurs later gets its own section. Step
// sub-grouping within a phase group keeps the same consecutive-run trick
// showPlanDialog uses for plan items sharing a step.
function groupSlicesByPhase(slices) {
  const phases = [];
  let currentPhaseGroup = null;
  let currentStepGroup = null;
  for (const slice of slices) {
    if (!currentPhaseGroup || currentPhaseGroup.phase !== slice.phase) {
      currentPhaseGroup = { phase: slice.phase, steps: [] };
      currentStepGroup = null;
      phases.push(currentPhaseGroup);
    }
    if (!currentStepGroup || currentStepGroup.step !== slice.step) {
      currentStepGroup = { step: slice.step, slices: [] };
      currentPhaseGroup.steps.push(currentStepGroup);
    }
    currentStepGroup.slices.push(slice);
  }
  return phases;
}

function renderSliceRow(slice) {
  const row = document.createElement("div");
  row.className = "slice-row";
  // Five visibly distinct statuses (TTM-84): done struck through, in_progress
  // highlighted, pending plain, failed red, skipped muted - all via this one
  // data attribute in style.css, the same pattern .plan-item[data-status]
  // and .card[data-status] already use.
  row.dataset.status = slice.status;

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "slice-row-summary";

  const label = document.createElement("span");
  label.className = "slice-label";
  label.textContent = slice.label;
  summary.appendChild(label);

  const title = document.createElement("span");
  title.className = "slice-title";
  title.textContent = slice.title;
  summary.appendChild(title);

  if (slice.model) {
    const model = document.createElement("span");
    model.className = "slice-model";
    model.textContent = slice.model;
    summary.appendChild(model);
  }

  const status = document.createElement("span");
  status.className = "slice-status";
  status.textContent = SLICE_STATUS_LABELS[slice.status] ?? slice.status;
  summary.appendChild(status);

  const details = document.createElement("div");
  details.className = "slice-details";

  const applyExpanded = () => {
    const isExpanded = expandedSliceRows.has(slice.id);
    summary.setAttribute("aria-expanded", String(isExpanded));
    details.hidden = !isExpanded;
  };
  summary.addEventListener("click", () => {
    if (expandedSliceRows.has(slice.id)) {
      expandedSliceRows.delete(slice.id);
    } else {
      expandedSliceRows.add(slice.id);
    }
    applyExpanded();
  });
  applyExpanded();

  const result = document.createElement("p");
  result.className = "slice-result";
  result.textContent = slice.result ? slice.result : "No result recorded yet.";
  details.appendChild(result);

  if (slice.artifacts.length > 0) {
    const artifactsLabel = document.createElement("p");
    artifactsLabel.className = "slice-artifacts-label";
    artifactsLabel.textContent = "Artifacts";
    details.appendChild(artifactsLabel);

    const artifactsList = document.createElement("ul");
    artifactsList.className = "slice-artifacts";
    for (const artifact of slice.artifacts) {
      const item = document.createElement("li");
      item.textContent = artifact;
      artifactsList.appendChild(item);
    }
    details.appendChild(artifactsList);
  }

  if (slice.metrics) {
    const metrics = document.createElement("pre");
    metrics.className = "slice-metrics";
    metrics.textContent = JSON.stringify(slice.metrics, null, 2);
    details.appendChild(metrics);
  }

  row.appendChild(summary);
  row.appendChild(details);
  return row;
}

// Rebuilds the dialog's body from a task's current slices - called both when
// it's first opened and, while it stays open, on every later poll (see
// refreshOpenSliceDialog), so it must not depend on anything the dialog only
// has at open time.
function renderSliceDialogContent(task, codePrefix) {
  document.getElementById("slice-title").textContent = `${codePrefix}-${task.task_number} - ${task.title} - slices`;

  const container = document.getElementById("slice-phases");
  while (container.firstChild) container.removeChild(container.firstChild);

  for (const group of groupSlicesByPhase(task.slices)) {
    const phaseSection = document.createElement("section");
    phaseSection.className = "slice-phase";

    const phaseHeading = document.createElement("h3");
    phaseHeading.className = "slice-phase-title";
    phaseHeading.textContent = SLICE_PHASE_LABELS[group.phase] ?? group.phase;
    phaseSection.appendChild(phaseHeading);

    for (const stepGroup of group.steps) {
      // A shared step is the parallel group (TTM-84) - one row per slice
      // inside it, same shape as showPlanDialog's per-step <li>.
      const stepEl = document.createElement("div");
      stepEl.className = "slice-step";

      const stepLabel = document.createElement("span");
      stepLabel.className = "slice-step-label";
      stepLabel.textContent = `Step ${stepGroup.step}`;
      stepEl.appendChild(stepLabel);

      for (const slice of stepGroup.slices) {
        stepEl.appendChild(renderSliceRow(slice));
      }

      phaseSection.appendChild(stepEl);
    }

    container.appendChild(phaseSection);
  }
}

function showSliceDialog(task, codePrefix) {
  openSliceTaskId = task.id;
  renderSliceDialogContent(task, codePrefix);
  document.getElementById("slice-dialog").showModal();
}

// Called on every poll (from renderBoard). The slice dialog is never torn
// down by a poll (it lives outside #board), so "update it without closing it
// and without collapsing expanded rows" just means: re-render its content in
// place from the fresh payload, which leaves expandedSliceRows (outside this
// function) and the dialog's own open/closed state both untouched.
function refreshOpenSliceDialog(board) {
  if (openSliceTaskId === null) return;
  for (const lane of board.lanes) {
    const task = lane.tasks.find((t) => t.id === openSliceTaskId);
    if (task) {
      renderSliceDialogContent(task, board.project_code_prefix);
      return;
    }
  }
  // The task itself is gone from the board (deleted) - nothing left to
  // refresh, so close rather than keep showing a dialog for it.
  openSliceTaskId = null;
  document.getElementById("slice-dialog").close();
}

function wireSliceDialog() {
  const dialog = document.getElementById("slice-dialog");
  document.getElementById("slice-close").addEventListener("click", () => dialog.close());
  // Covers every way the dialog can close (this button, Escape, a future
  // form-method=dialog control) in one place, rather than resetting
  // openSliceTaskId at each individual close site.
  dialog.addEventListener("close", () => {
    openSliceTaskId = null;
  });
}

loadBoard();
wireShutdownButton();
wireReleaseNotesDialog();
wirePlanDialog();
wireSliceDialog();
