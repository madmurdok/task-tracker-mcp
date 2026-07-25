import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeuristicBudgetEstimator, isOverBudget } from "../src/domain/budget.js";

describe("HeuristicBudgetEstimator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "budget-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("estimates tokens as chars-on-disk / 4 across the given files", () => {
    writeFileSync(path.join(tmpDir, "a.ts"), "x".repeat(400));
    writeFileSync(path.join(tmpDir, "b.ts"), "y".repeat(400));

    const estimator = new HeuristicBudgetEstimator();
    const tokens = estimator.estimateTokens(tmpDir, ["a.ts", "b.ts"]);

    expect(tokens).toBe(200);
  });

  it("ignores files that don't exist yet", () => {
    const estimator = new HeuristicBudgetEstimator();
    const tokens = estimator.estimateTokens(tmpDir, ["not-created-yet.ts"]);

    expect(tokens).toBe(0);
  });
});

describe("isOverBudget", () => {
  it("flags tokens above the default threshold", () => {
    expect(isOverBudget(15_001)).toBe(true);
    expect(isOverBudget(15_000)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(isOverBudget(50, 10)).toBe(true);
  });
});
