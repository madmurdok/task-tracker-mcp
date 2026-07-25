import fs from "node:fs";
import path from "node:path";

const CHARS_PER_TOKEN = 4;
export const DEFAULT_OVER_BUDGET_THRESHOLD = 15_000;

export interface BudgetEstimator {
  estimateTokens(rootPath: string, filePaths: string[]): number;
}

/**
 * chars-on-disk / 4 heuristic (doc's Open Questions flags this as a first cut).
 * Isolated behind this interface so it can be swapped without touching callers.
 */
export class HeuristicBudgetEstimator implements BudgetEstimator {
  estimateTokens(rootPath: string, filePaths: string[]): number {
    let totalChars = 0;
    for (const filePath of filePaths) {
      try {
        totalChars += fs.statSync(path.resolve(rootPath, filePath)).size;
      } catch {
        // File doesn't exist yet (e.g. to-be-created) - contributes 0.
      }
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }
}

export function isOverBudget(
  estimatedTokens: number,
  threshold: number = DEFAULT_OVER_BUDGET_THRESHOLD,
): boolean {
  return estimatedTokens > threshold;
}
