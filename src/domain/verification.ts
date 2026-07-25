import { execFileSync, execSync } from "node:child_process";

export interface VerificationResult {
  passed: boolean;
  reason: string;
}

export interface CompletionVerificationInput {
  rootPath: string;
  filePaths: string[];
  testCommand?: string;
}

export interface CompletionVerifier {
  verify(input: CompletionVerificationInput): VerificationResult;
}

/**
 * Checks that a task's declared files actually changed, and (if a test
 * command is supplied) that it exits zero, before complete_task accepts a
 * Claude-declared completion at face value (see the doc's Open Questions -
 * "gap #6", deferred past v1). Isolated behind CompletionVerifier the same
 * way BudgetEstimator isolates the token heuristic (see budget.ts), so the
 * check can be swapped or extended without touching complete_task's callers.
 */
export class GitDiffCompletionVerifier implements CompletionVerifier {
  verify({ rootPath, filePaths, testCommand }: CompletionVerificationInput): VerificationResult {
    if (filePaths.length > 0) {
      const fileCheck = this.checkFilesChanged(rootPath, filePaths);
      if (!fileCheck.passed) return fileCheck;
    }

    if (testCommand) {
      const testCheck = this.runTestCommand(rootPath, testCommand);
      if (!testCheck.passed) return testCheck;
    }

    return { passed: true, reason: "verification passed" };
  }

  private checkFilesChanged(rootPath: string, filePaths: string[]): VerificationResult {
    try {
      // --porcelain (unlike `git diff --stat`) also surfaces brand-new
      // untracked files, which is the common case for a task that adds a file.
      const output = execFileSync("git", ["status", "--porcelain", "--", ...filePaths], {
        cwd: rootPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (output.trim().length === 0) {
        return { passed: false, reason: "no changes detected in this task's declared files" };
      }
      return { passed: true, reason: "changes detected in declared files" };
    } catch (error) {
      return {
        passed: false,
        reason: `could not check git status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private runTestCommand(rootPath: string, testCommand: string): VerificationResult {
    try {
      execSync(testCommand, { cwd: rootPath, stdio: "pipe" });
      return { passed: true, reason: "test command passed" };
    } catch (error) {
      return {
        passed: false,
        reason: `test command failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
