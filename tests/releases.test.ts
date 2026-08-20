import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { createEpic } from "../src/domain/epics.js";
import { cancelRelease } from "../src/domain/lifecycle.js";
import { createProject } from "../src/domain/projects.js";
import {
  createRelease,
  getRelease,
  listReleases,
  requireRelease,
  setReleaseSequence,
  setTaskRelease,
} from "../src/domain/releases.js";
import { getReleaseStatus, listReleasesWithStatus, listTasks } from "../src/domain/status.js";
import { createTask, requireTask, splitTask, taskCode } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  return { db, project };
}

function markReleased(db: DatabaseInstance, releaseId: string): void {
  db.prepare(`UPDATE releases SET status = 'released' WHERE id = ?`).run(releaseId);
}

// Sets the status directly rather than going through cancelRelease, matching
// markReleased above: these helpers exist to put a release into a given state
// for the *assignment rules* under test, so they shouldn't also depend on the
// lifecycle function's own guards passing.
function markCancelled(db: DatabaseInstance, releaseId: string): void {
  db.prepare(`UPDATE releases SET status = 'cancelled', cancellation_reason = 'bench gate said no' WHERE id = ?`).run(
    releaseId,
  );
}

describe("createRelease", () => {
  it("inserts and returns a release with a generated id, planned status, and sequence 10", () => {
    const { db, project } = setup();

    const release = createRelease(db, { project_id: project.id, version: "0.1" });

    expect(release.id).toBeTruthy();
    expect(release.project_id).toBe(project.id);
    expect(release.version).toBe("0.1");
    expect(release.name).toBe("");
    expect(release.description).toBe("");
    expect(release.status).toBe("planned");
    expect(release.sequence).toBe(10);
    expect(release.release_notes).toBeNull();
    expect(release.released_at).toBeNull();
    expect(release.cancellation_reason).toBeNull();

    const row = db.prepare("SELECT * FROM releases WHERE id = ?").get(release.id);
    expect(row).toMatchObject({ version: "0.1", project_id: project.id, status: "planned" });
  });

  it("assigns sequences in gaps of 10 as releases are added", () => {
    const { db, project } = setup();

    const first = createRelease(db, { project_id: project.id, version: "0.1" });
    const second = createRelease(db, { project_id: project.id, version: "0.2" });
    const third = createRelease(db, { project_id: project.id, version: "0.3" });

    expect([first.sequence, second.sequence, third.sequence]).toEqual([10, 20, 30]);
  });

  it("rejects a duplicate version within the same project", () => {
    const { db, project } = setup();
    createRelease(db, { project_id: project.id, version: "0.1" });

    expect(() => createRelease(db, { project_id: project.id, version: "0.1" })).toThrow(
      /Release version already in use in this project: 0.1/,
    );
  });

  it("allows the same version across different projects", () => {
    const { db, project } = setup();
    const otherProject = createProject(db, { name: "Other", root_path: "/tmp/other" });

    createRelease(db, { project_id: project.id, version: "0.1" });

    expect(() => createRelease(db, { project_id: otherProject.id, version: "0.1" })).not.toThrow();
  });

  it("rejects an unknown project", () => {
    const { db } = setup();
    expect(() => createRelease(db, { project_id: "missing", version: "0.1" })).toThrow(
      /Unknown project: missing/,
    );
  });
});

describe("getRelease / requireRelease", () => {
  it("resolves a release by id and by version, scoped to the project", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });

    expect(getRelease(db, project.id, release.id)).toEqual(release);
    expect(getRelease(db, project.id, "0.1")).toEqual(release);
    expect(requireRelease(db, project.id, release.id)).toEqual(release);
  });

  it("does not resolve a version from a different project", () => {
    const { db, project } = setup();
    const otherProject = createProject(db, { name: "Other", root_path: "/tmp/other" });
    createRelease(db, { project_id: otherProject.id, version: "0.1" });

    expect(getRelease(db, project.id, "0.1")).toBeUndefined();
    expect(() => requireRelease(db, project.id, "0.1")).toThrow(/Unknown release: 0.1/);
  });

  it("getRelease returns undefined and requireRelease throws for an unknown ref", () => {
    const { db, project } = setup();
    expect(getRelease(db, project.id, "missing")).toBeUndefined();
    expect(() => requireRelease(db, project.id, "missing")).toThrow(/Unknown release: missing/);
  });
});

describe("listReleases", () => {
  it("lists only the releases belonging to the given project, ordered by sequence", () => {
    const { db, project } = setup();
    const otherProject = createProject(db, { name: "Other", root_path: "/tmp/other" });
    const v2 = createRelease(db, { project_id: project.id, version: "0.2" });
    const v1 = createRelease(db, { project_id: project.id, version: "0.1" });
    createRelease(db, { project_id: otherProject.id, version: "0.1" });

    // v2 was created first (sequence 10), v1 second (sequence 20) - listReleases
    // reflects creation/sequence order, not a re-sort by version string.
    expect(listReleases(db, project.id)).toEqual([v2, v1]);
  });
});

describe("createTask with release_id", () => {
  it("assigns the task to the release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });

    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "Add login form",
      complexity_hint: "normal",
    });

    expect(task.release_id).toBe(release.id);
  });

  it("resolves release_id by version as well as by id", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });

    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: "0.1",
      title: "Add login form",
      complexity_hint: "normal",
    });

    expect(task.release_id).toBe(release.id);
  });

  it("rejects an unknown release_id", () => {
    const { db, project } = setup();
    expect(() =>
      createTask(db, noopEstimator, {
        project_id: project.id,
        release_id: "missing",
        title: "x",
        complexity_hint: "normal",
      }),
    ).toThrow(/Unknown release: missing/);
  });

  it("rejects a release that belongs to a different project", () => {
    const { db, project } = setup();
    const otherProject = createProject(db, { name: "Other", root_path: "/tmp/other" });
    const otherRelease = createRelease(db, { project_id: otherProject.id, version: "0.1" });

    expect(() =>
      createTask(db, noopEstimator, {
        project_id: project.id,
        release_id: otherRelease.id,
        title: "x",
        complexity_hint: "normal",
      }),
    ).toThrow(/Unknown release/);
  });

  it("rejects assigning a task to an already-released release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    markReleased(db, release.id);

    expect(() =>
      createTask(db, noopEstimator, {
        project_id: project.id,
        release_id: release.id,
        title: "x",
        complexity_hint: "normal",
      }),
    ).toThrow(/is already released; cannot assign new tasks to it/);
  });

  it("rejects assigning a task to a cancelled release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    markCancelled(db, release.id);

    expect(() =>
      createTask(db, noopEstimator, {
        project_id: project.id,
        release_id: release.id,
        title: "x",
        complexity_hint: "normal",
      }),
    ).toThrow(/is cancelled; cannot assign new tasks to it/);
  });

  it("defaults release_id to null when not given", () => {
    const { db, project } = setup();
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "No release",
      complexity_hint: "normal",
    });
    expect(task.release_id).toBeNull();
  });
});

describe("splitTask inherits release_id", () => {
  it("keeps subtasks under the original task's release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    const original = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "Too big",
      complexity_hint: "normal",
    }).task;

    const { new_task_ids } = splitTask(db, noopEstimator, original.id, [
      { title: "Part 1" },
      { title: "Part 2" },
    ]);

    for (const subtaskId of new_task_ids) {
      const row = db.prepare("SELECT release_id FROM tasks WHERE id = ?").get(subtaskId);
      expect(row).toMatchObject({ release_id: release.id });
    }
  });
});

describe("getReleaseStatus / listReleasesWithStatus", () => {
  it("aggregates task status counts scoped to the release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    const outsideRelease = createRelease(db, { project_id: project.id, version: "0.2" });

    const a = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "A",
      complexity_hint: "normal",
    }).task;
    createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "B (blocked)",
      complexity_hint: "normal",
    });
    createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: outsideRelease.id,
      title: "Outside",
      complexity_hint: "normal",
    });

    const b = db.prepare("SELECT id FROM tasks WHERE title = ?").get("B (blocked)") as { id: string };
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)").run(
      b.id,
      a.id,
    );

    const status = getReleaseStatus(db, project.id, release.id);
    expect(status).toMatchObject({
      id: release.id,
      version: "0.1",
      total: 2,
      pending: 1,
      blocked: 1,
      done: 0,
      in_progress: 0,
      cancelled: 0,
      percent: 0,
    });

    const all = listReleasesWithStatus(db, project.id);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === release.id)).toMatchObject({ total: 2 });
    expect(all.find((r) => r.id === outsideRelease.id)).toMatchObject({ total: 1 });
  });
});

describe("listTasks release_id filter", () => {
  it("filters task summaries by release and includes release_id on every row", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });

    const inRelease = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "In release",
      complexity_hint: "normal",
    }).task;
    const outside = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Outside",
      complexity_hint: "normal",
    }).task;

    const filtered = listTasks(db, project.id, undefined, undefined, release.id);
    expect(filtered).toEqual([
      {
        id: inRelease.id,
        code: `${project.code_prefix}-${inRelease.task_number}`,
        title: "In release",
        status: "pending",
        estimated_tokens: 0,
        epic_id: null,
        release_id: release.id,
        task_number: inRelease.task_number,
      },
    ]);

    const all = listTasks(db, project.id);
    expect(all.map((t) => t.id).sort()).toEqual([inRelease.id, outside.id].sort());
    expect(all.find((t) => t.id === outside.id)?.release_id).toBeNull();
  });

  it("combines epic and release filters - only a task matching both survives", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });
    const release = createRelease(db, { project_id: project.id, version: "0.1" });

    const both = createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: epic.id,
      release_id: release.id,
      title: "Both",
      complexity_hint: "normal",
    }).task;
    createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "Release only",
      complexity_hint: "normal",
    });
    createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: epic.id,
      title: "Epic only",
      complexity_hint: "normal",
    });

    const filtered = listTasks(db, project.id, undefined, epic.id, release.id);
    expect(filtered.map((t) => t.id)).toEqual([both.id]);
  });
});

describe("setTaskRelease", () => {
  it("moves a task to a different release", () => {
    const { db, project } = setup();
    const releaseA = createRelease(db, { project_id: project.id, version: "0.1" });
    const releaseB = createRelease(db, { project_id: project.id, version: "0.2" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: releaseA.id,
      title: "x",
      complexity_hint: "normal",
    });

    setTaskRelease(db, task.id, releaseB.id);

    const row = db.prepare("SELECT release_id FROM tasks WHERE id = ?").get(task.id);
    expect(row).toMatchObject({ release_id: releaseB.id });
  });

  it("clears release_id when given null", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "x",
      complexity_hint: "normal",
    });

    setTaskRelease(db, task.id, null);

    const row = db.prepare("SELECT release_id FROM tasks WHERE id = ?").get(task.id);
    expect(row).toMatchObject({ release_id: null });
  });

  it("rejects moving a task into an already-released release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    markReleased(db, release.id);
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "x",
      complexity_hint: "normal",
    });

    expect(() => setTaskRelease(db, task.id, release.id)).toThrow(/already released/);
  });

  it("rejects moving a task out of an already-released release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "x",
      complexity_hint: "normal",
    });
    markReleased(db, release.id);

    expect(() => setTaskRelease(db, task.id, null)).toThrow(/already released/);
  });

  it("rejects moving a task into a cancelled release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    markCancelled(db, release.id);
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "x",
      complexity_hint: "normal",
    });

    expect(() => setTaskRelease(db, task.id, release.id)).toThrow(/is cancelled/);
  });

  it("allows moving a task *out of* a cancelled release, unlike a released one", () => {
    // The deliberate asymmetry: rescuing salvageable work out of an abandoned
    // batch into a later release is a real workflow, and a cancelled release
    // has no generated release_notes for the membership to drift away from -
    // which is the only reason the outbound direction is frozen for shipped
    // releases at all. If someone ever "fixes" the inconsistency by adding
    // cancelled to setTaskRelease's outbound check, this test is what says no.
    const { db, project } = setup();
    const cancelled = createRelease(db, { project_id: project.id, version: "0.1" });
    const next = createRelease(db, { project_id: project.id, version: "0.2" });
    const { task: rescued } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: cancelled.id,
      title: "salvageable",
      complexity_hint: "normal",
    });
    const { task: dropped } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: cancelled.id,
      title: "back to backlog",
      complexity_hint: "normal",
    });
    markCancelled(db, cancelled.id);

    expect(() => setTaskRelease(db, rescued.id, next.id)).not.toThrow();
    expect(() => setTaskRelease(db, dropped.id, null)).not.toThrow();

    expect(db.prepare("SELECT release_id FROM tasks WHERE id = ?").get(rescued.id)).toMatchObject({
      release_id: next.id,
    });
    expect(db.prepare("SELECT release_id FROM tasks WHERE id = ?").get(dropped.id)).toMatchObject({
      release_id: null,
    });
  });

  it("rejects an unknown task_id", () => {
    const { db } = setup();
    expect(() => setTaskRelease(db, "missing", null)).toThrow(/Unknown task_id: missing/);
  });
});

describe("cancelRelease", () => {
  it("marks a planned release cancelled and persists the reason", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "2.2.0" });

    cancelRelease(db, {
      project_id: project.id,
      release_id: release.id,
      reason: "bench gate said the feature isn't worth shipping",
    });

    expect(requireRelease(db, project.id, release.id)).toMatchObject({
      status: "cancelled",
      cancellation_reason: "bench gate said the feature isn't worth shipping",
      released_at: null,
      release_notes: null,
    });
  });

  it("resolves the release by version and the project by name, like its sibling tools", () => {
    const { db, project } = setup();
    createRelease(db, { project_id: project.id, version: "2.2.0" });

    expect(() =>
      cancelRelease(db, { project_id: "Demo", release_id: "2.2.0", reason: "never merged" }),
    ).not.toThrow();
    expect(getRelease(db, project.id, "2.2.0")).toMatchObject({ status: "cancelled" });
  });

  it("leaves the release's tasks exactly as they were, including still-open ones", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "half-finished",
      complexity_hint: "normal",
    });

    cancelRelease(db, { project_id: project.id, release_id: release.id, reason: "descoped" });

    expect(db.prepare("SELECT status, release_id FROM tasks WHERE id = ?").get(task.id)).toMatchObject({
      status: "pending",
      release_id: release.id,
    });
  });

  it("rejects a release that is already released", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    markReleased(db, release.id);

    expect(() =>
      cancelRelease(db, { project_id: project.id, release_id: release.id, reason: "too late" }),
    ).toThrow(/is already released, nothing to cancel/);
  });

  it("rejects a release that is already cancelled - one-shot, no un-cancel", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    cancelRelease(db, { project_id: project.id, release_id: release.id, reason: "first" });

    expect(() =>
      cancelRelease(db, { project_id: project.id, release_id: release.id, reason: "second" }),
    ).toThrow(/is already cancelled, nothing to cancel/);
    expect(requireRelease(db, project.id, release.id).cancellation_reason).toBe("first");
  });

  it("rejects unknown project and release refs", () => {
    const { db, project } = setup();
    expect(() => cancelRelease(db, { project_id: "missing", release_id: "0.1", reason: "x" })).toThrow(
      /Unknown project: missing/,
    );
    expect(() =>
      cancelRelease(db, { project_id: project.id, release_id: "missing", reason: "x" }),
    ).toThrow(/Unknown release: missing/);
  });
});

describe("setReleaseSequence", () => {
  it("reorders list_releases output", () => {
    const { db, project } = setup();
    const first = createRelease(db, { project_id: project.id, version: "0.1" }); // sequence 10
    const second = createRelease(db, { project_id: project.id, version: "0.2" }); // sequence 20

    setReleaseSequence(db, project.id, first.id, 25); // now sorts after second

    const ordered = listReleases(db, project.id);
    expect(ordered.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("is not blocked by an already-released release", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    markReleased(db, release.id);

    expect(() => setReleaseSequence(db, project.id, release.id, 5)).not.toThrow();
  });
});

describe("set_task_release given a task code", () => {
  it("actually moves the task, asserted on the row rather than on the absence of a throw", () => {
    // The regression this exists for: the code was resolved for the lookup and
    // the UPDATE still bound the caller's raw reference, so SQLite matched no
    // row, raised nothing, and the tool answered ok. Eleven calls in a row
    // reported success and moved nothing.
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "g-mesh", root_path: "/tmp/gm" });
    const release = createRelease(db, { project_id: project.id, version: "2.10.0" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Anything",
      complexity_hint: "normal",
    });

    setTaskRelease(db, taskCode(project.code_prefix, task.task_number), release.id);

    expect(requireTask(db, task.id).release_id).toBe(release.id);
  });

  it("refuses a reference that matches nothing instead of reporting success", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "g-mesh", root_path: "/tmp/gm" });
    createRelease(db, { project_id: project.id, version: "2.10.0" });

    expect(() => setTaskRelease(db, "GM-9999", "2.10.0")).toThrow(/Unknown task_id/);
  });
});
