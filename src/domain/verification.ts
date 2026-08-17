import { execFileSync, execSync } from "node:child_process";

export interface VerificationResult {
  passed: boolean;
  reason: string;
}

export interface CompletionVerificationInput {
  rootPath: string;
  filePaths: string[];
  testCommand?: string;
  /**
   * ISO timestamp bounding *which commits count* as this task's work - in
   * practice the task's `created_at` (see checkFilesChanged for why that one
   * and not the claim timestamp). Optional only so callers that don't run the
   * file check at all (release_it passes `filePaths: []`) don't have to invent
   * a value; when it's absent the file check degrades to working-tree-only,
   * i.e. the pre-fix behaviour, so complete_task must always supply it.
   */
  changesSinceIso?: string;
}

export interface CompletionVerifier {
  verify(input: CompletionVerificationInput): VerificationResult;
}

/**
 * The commit-time lower bound, in ms, floored to a whole second - or null for
 * "no bound given / unparseable", which switches the file check back to
 * working-tree-only rather than throwing on a bad timestamp.
 *
 * The flooring is not cosmetic: git records commit times at second precision
 * while created_at carries milliseconds, so a task created at 12:00:00.800 and
 * committed 100ms later reads as a 12:00:00 commit "before" its own task -
 * a false negative on the tightest, most common timing (create task, work,
 * commit, complete). Flooring the bound cancels git's truncation exactly,
 * without an arbitrary slop window.
 */
function parseSinceMs(changesSinceIso: string | undefined): number | null {
  if (!changesSinceIso) return null;
  const parsed = Date.parse(changesSinceIso);
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000) * 1000;
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
  verify({
    rootPath,
    filePaths,
    testCommand,
    changesSinceIso,
  }: CompletionVerificationInput): VerificationResult {
    if (filePaths.length > 0) {
      const fileCheck = this.checkFilesChanged(rootPath, filePaths, changesSinceIso);
      if (!fileCheck.passed) return fileCheck;
    }

    if (testCommand) {
      const testCheck = this.runTestCommand(rootPath, testCommand);
      if (!testCheck.passed) return testCheck;
    }

    return { passed: true, reason: "verification passed" };
  }

  /**
   * Scoping rule: a declared file counts as changed if EITHER it is dirty in
   * the working tree/index, OR the newest HEAD-reachable commit touching any
   * declared file was committed at or after `changesSinceIso` (the task's
   * created_at).
   *
   * The commit half exists because the working-tree half alone fires exactly
   * backwards: it passes on work-in-progress and fails on finished work, since
   * committing (which this project's branch workflow requires) leaves the tree
   * clean. Every completion then had to be forced, which made the check verify
   * nothing at all - and leaked "(Verification forced: ...)" apologies into
   * generated release notes via completion_summary.
   *
   * FALSE POSITIVE ACCEPTED: any commit made after the task was created that
   * touches a declared file counts, whoever's work it was. Two tasks declaring
   * the same file, or unrelated commits landing on a shared release branch,
   * will satisfy each other's check. Commits are not attributed to tasks and
   * git carries nothing to attribute them with; the check answers "has this
   * file plausibly moved during this task's lifetime", not "did *this* task
   * move it". That is the deliberate trade for never failing on real work -
   * but the check can still fail, and does: a file nothing has touched since
   * the task was created has no matching commit and no dirty status.
   *
   * Why created_at and not the claim timestamp (the tighter bound): claim_task
   * renews the lease on every re-claim/hand-off, so the derived claim time
   * moves *forward* over a task's life and can easily land after the very
   * commits it is meant to find (parent session commits, subagent re-claims,
   * then completes) - reintroducing this exact false negative. created_at is
   * monotone and is a true lower bound whenever the task was created before
   * the work, which the workflow requires. A task created retroactively, after
   * its work was already committed, still fails - correctly, by this rule.
   *
   * Why no base-branch diff: the base is ambiguous here (a task branches off a
   * release branch, not always main), and guessing main would count every
   * unrelated commit on that release branch since the branch point - a *wider*
   * false positive than the time bound, for no extra detection, plus new
   * failure modes on detached HEAD and while sitting on the base branch
   * itself. `git log` from HEAD already excludes other branches' commits.
   */
  private checkFilesChanged(
    rootPath: string,
    filePaths: string[],
    changesSinceIso: string | undefined,
  ): VerificationResult {
    let status: string;
    try {
      // --porcelain (unlike `git diff --stat`) also surfaces brand-new
      // untracked files, which is the common case for a task that adds a file.
      status = execFileSync("git", ["status", "--porcelain", "--", ...filePaths], {
        cwd: rootPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // Not a git repo, git missing, unreadable path: a verdict, never a throw.
      return {
        passed: false,
        reason: `could not check git status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (status.trim().length > 0) {
      return { passed: true, reason: "changes detected in declared files (uncommitted)" };
    }

    const since = parseSinceMs(changesSinceIso);
    if (since !== null) {
      const committedAtMs = this.lastCommitTouching(rootPath, filePaths);
      if (committedAtMs !== null && committedAtMs >= since) {
        return {
          passed: true,
          reason: "changes detected in declared files (committed since the task was created)",
        };
      }
    }

    return { passed: false, reason: "no changes detected in this task's declared files" };
  }

  /**
   * Commit time (ms) of the newest HEAD-reachable commit touching any declared
   * file, or null when there is none to report - which includes every "this
   * isn't a normal repo with history" case: no commits yet, an unborn or
   * broken HEAD, a path git has never tracked. All of those are a null, not a
   * throw, so the caller falls through to a plain no-changes verdict instead
   * of surfacing a git error. Deleted files are found too: the commit that
   * removes a path is not TREESAME for it, so path-limited log still lists it.
   * Detached HEAD and linked worktrees need no special handling - both resolve
   * HEAD to a real commit, and `git log` walks from it exactly as usual.
   */
  private lastCommitTouching(rootPath: string, filePaths: string[]): number | null {
    try {
      const output = execFileSync(
        "git",
        // %cI - committer date, strict ISO 8601. Committer date (not author
        // date) is what a rebase/cherry-pick refreshes, so replayed work keeps
        // counting as recent.
        ["log", "-1", "--format=%cI", "--", ...filePaths],
        { cwd: rootPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const parsed = Date.parse(output.trim());
      return Number.isNaN(parsed) ? null : parsed;
    } catch {
      return null;
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
