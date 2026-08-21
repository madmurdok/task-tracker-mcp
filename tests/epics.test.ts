import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createEpic, getEpic, listEpics, requireEpic } from "../src/domain/epics.js";
import { createProject } from "../src/domain/projects.js";
import { getEpicStatus, listEpicsWithStatus, listTasks } from "../src/domain/status.js";
import { createTask } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  return { db, project };
}

describe("createEpic", () => {
  it("inserts and returns an epic with a generated id", () => {
    const { db, project } = setup();

    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });

    expect(epic.id).toBeTruthy();
    expect(epic.project_id).toBe(project.id);
    expect(epic.name).toBe("Auth rework");
    expect(epic.description).toBe("");

    const row = db.prepare("SELECT * FROM epics WHERE id = ?").get(epic.id);
    expect(row).toMatchObject({ name: "Auth rework", project_id: project.id });
  });

  it("rejects a duplicate epic name within the same project", () => {
    const { db, project } = setup();
    createEpic(db, { project_id: project.id, name: "Auth rework" });

    expect(() => createEpic(db, { project_id: project.id, name: "Auth rework" })).toThrow(
      /Epic name already in use in this project: Auth rework/,
    );
  });

  it("allows the same epic name across different projects", () => {
    const { db, project } = setup();
    const otherProject = createProject(db, { name: "Other", root_path: "/tmp/other" });

    createEpic(db, { project_id: project.id, name: "Auth rework" });

    expect(() =>
      createEpic(db, { project_id: otherProject.id, name: "Auth rework" }),
    ).not.toThrow();
  });

  it("rejects an unknown project", () => {
    const { db } = setup();
    expect(() => createEpic(db, { project_id: "missing", name: "Auth rework" })).toThrow(
      /Unknown project: missing/,
    );
  });
});

describe("getEpic / requireEpic", () => {
  it("resolves an epic by id and by name, scoped to the project", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });

    expect(getEpic(db, project.id, epic.id)).toEqual(epic);
    expect(getEpic(db, project.id, "Auth rework")).toEqual(epic);
    expect(requireEpic(db, project.id, epic.id)).toEqual(epic);
  });

  it("does not resolve an epic name from a different project", () => {
    const { db, project } = setup();
    const otherProject = createProject(db, { name: "Other", root_path: "/tmp/other" });
    createEpic(db, { project_id: otherProject.id, name: "Auth rework" });

    expect(getEpic(db, project.id, "Auth rework")).toBeUndefined();
    expect(() => requireEpic(db, project.id, "Auth rework")).toThrow(/Unknown epic: Auth rework/);
  });

  it("getEpic returns undefined and requireEpic throws for an unknown ref", () => {
    const { db, project } = setup();
    expect(getEpic(db, project.id, "missing")).toBeUndefined();
    expect(() => requireEpic(db, project.id, "missing")).toThrow(/Unknown epic: missing/);
  });
});

describe("listEpics", () => {
  it("lists only the epics belonging to the given project", () => {
    const { db, project } = setup();
    const otherProject = createProject(db, { name: "Other", root_path: "/tmp/other" });
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });
    createEpic(db, { project_id: otherProject.id, name: "Unrelated" });

    expect(listEpics(db, project.id)).toEqual([epic]);
  });
});

describe("createTask with epic_id", () => {
  it("assigns the task to the epic", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });

    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: epic.id,
      title: "Add login form",
      complexity_hint: "normal",
    });

    expect(task.epic_id).toBe(epic.id);
  });

  it("resolves epic_id by name as well as by id", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });

    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: "Auth rework",
      title: "Add login form",
      complexity_hint: "normal",
    });

    expect(task.epic_id).toBe(epic.id);
  });

  it("rejects an unknown epic_id", () => {
    const { db, project } = setup();
    expect(() =>
      createTask(db, noopEstimator, {
        project_id: project.id,
        epic_id: "missing",
        title: "x",
        complexity_hint: "normal",
      }),
    ).toThrow(/Unknown epic: missing/);
  });

  it("rejects an epic that belongs to a different project", () => {
    const { db, project } = setup();
    const otherProject = createProject(db, { name: "Other", root_path: "/tmp/other" });
    const otherEpic = createEpic(db, { project_id: otherProject.id, name: "Unrelated" });

    expect(() =>
      createTask(db, noopEstimator, {
        project_id: project.id,
        epic_id: otherEpic.id,
        title: "x",
        complexity_hint: "normal",
      }),
    ).toThrow(/Unknown epic/);
  });

  it("defaults epic_id to null when not given", () => {
    const { db, project } = setup();
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "No epic",
      complexity_hint: "normal",
    });
    expect(task.epic_id).toBeNull();
  });
});

describe("getEpicStatus / listEpicsWithStatus", () => {
  it("aggregates task status counts scoped to the epic", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });
    const outsideEpic = createEpic(db, { project_id: project.id, name: "Unrelated" });

    const a = createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: epic.id,
      title: "A",
      complexity_hint: "normal",
    }).task;
    createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: epic.id,
      title: "B (blocked)",
      complexity_hint: "normal",
    });
    createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: outsideEpic.id,
      title: "Outside",
      complexity_hint: "normal",
    });

    const b = db.prepare("SELECT id FROM tasks WHERE title = ?").get("B (blocked)") as { id: string };
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)").run(
      b.id,
      a.id,
    );

    const status = getEpicStatus(db, project.id, epic.id);
    expect(status).toMatchObject({
      id: epic.id,
      name: "Auth rework",
      total: 2,
      pending: 1,
      blocked: 1,
      done: 0,
      in_progress: 0,
      percent: 0,
    });

    const all = listEpicsWithStatus(db, project.id);
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.id === epic.id)).toMatchObject({ total: 2 });
    expect(all.find((e) => e.id === outsideEpic.id)).toMatchObject({ total: 1 });
  });
});

describe("listTasks epic_id filter", () => {
  it("filters task summaries by epic and includes epic_id on every row", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });

    const inEpic = createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: epic.id,
      title: "In epic",
      complexity_hint: "normal",
    }).task;
    const outside = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Outside",
      complexity_hint: "normal",
    }).task;

    const filtered = listTasks(db, project.id, undefined, epic.id);
    expect(filtered).toEqual([
      {
        id: inEpic.id,
        code: `${project.code_prefix}-${inEpic.task_number}`,
        title: "In epic",
        status: "pending",
        estimated_tokens: 0,
        epic_id: epic.id,
        release_id: null,
        task_number: inEpic.task_number,
      },
    ]);

    const all = listTasks(db, project.id);
    expect(all.map((t) => t.id).sort()).toEqual([inEpic.id, outside.id].sort());
    expect(all.find((t) => t.id === outside.id)?.epic_id).toBeNull();
  });
});
