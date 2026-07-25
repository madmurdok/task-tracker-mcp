import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";

describe("createProject", () => {
  it("inserts and returns a project with a generated id", () => {
    const db = openDatabase(":memory:");

    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    expect(project.id).toBeTruthy();
    expect(project.name).toBe("Demo");

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id);
    expect(row).toMatchObject({ name: "Demo", root_path: "/tmp/demo" });
  });
});
