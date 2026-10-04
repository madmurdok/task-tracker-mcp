import { execFileSync, execSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface VerificationResult {
  passed: boolean;
  reason: string;
  /**
   * Declared paths the check could not look at (outside the project's git
   * repository). Set only when non-empty, so a caller that reports only
   * failures can still tell a pass apart from "all verified".
   */
  uncheckedPaths?: string[];
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
    // Declared paths outside the repository pass through unchecked; the
    // passing verdict still names them so nobody reads it as "all verified".
    let uncheckedPaths: string[] = [];
    if (filePaths.length > 0) {
      const fileCheck = this.checkFilesChanged(
        rootPath,
        filePaths,
        changesSinceIso,
      );
      if (!fileCheck.passed) {
        return {
          passed: false,
          reason: fileCheck.reason,
          ...withUnchecked(fileCheck.external),
        };
      }
      uncheckedPaths = fileCheck.external;
    }

    if (testCommand) {
      const testCheck = this.runTestCommand(rootPath, testCommand);
      if (!testCheck.passed) {
        return { ...testCheck, ...withUnchecked(uncheckedPaths) };
      }
    }

    return {
      passed: true,
      reason: `verification passed${externalNote(uncheckedPaths)}`,
      ...withUnchecked(uncheckedPaths),
    };
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
  ): VerificationResult & { external: string[] } {
    const root = gitRepoOf(rootPath);
    if (!root.ok) {
      // Not a git repo, git missing: a verdict, never a throw.
      return {
        passed: false,
        reason: `could not check git status: ${root.error}`,
        external: [],
      };
    }

    const { groups, external } = partitionDeclaredPaths(
      rootPath,
      root.repo,
      filePaths,
    );
    const note = externalNote(external);

    if (groups.size === 0) {
      return {
        passed: false,
        reason:
          `none of this task's declared files are inside the project's git repository ` +
          `(${rootPath}), so none could be checked: ${external.join(", ")}`,
        external,
      };
    }

    const since = parseSinceMs(changesSinceIso);
    let committedMatch = false;
    for (const [cwd, paths] of groups) {
      let status: string;
      try {
        // --porcelain (unlike `git diff --stat`) also surfaces brand-new
        // untracked files, which is the common case for a task that adds a file.
        status = execFileSync(
          "git",
          ["status", "--porcelain", "--", ...paths],
          {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        // Unreadable path, broken worktree: a verdict, never a throw.
        return {
          passed: false,
          reason: `could not check git status: ${error instanceof Error ? error.message : String(error)}`,
          external,
        };
      }

      if (status.trim().length > 0) {
        return {
          passed: true,
          reason: `changes detected in declared files (uncommitted)${note}`,
          external,
        };
      }

      if (since !== null && !committedMatch) {
        // Each worktree's own HEAD: a linked worktree's commits live on its
        // branch, not on the project root's.
        const committedAtMs = this.lastCommitTouching(cwd, paths);
        committedMatch = committedAtMs !== null && committedAtMs >= since;
      }
    }

    if (committedMatch) {
      return {
        passed: true,
        reason: `changes detected in declared files (committed since the task was created)${note}`,
        external,
      };
    }

    return {
      passed: false,
      reason: `no changes detected in this task's declared files${note}`,
      external,
    };
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
  private lastCommitTouching(
    rootPath: string,
    filePaths: string[],
  ): number | null {
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

  private runTestCommand(
    rootPath: string,
    testCommand: string,
  ): VerificationResult {
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

interface GitRepo {
  /** Worktree top level, realpath'd. */
  toplevel: string;
  /** The repository's shared git dir - identical across all its worktrees. */
  commonDir: string;
}

type GitRepoLookup = { ok: true; repo: GitRepo } | { ok: false; error: string };

/** The repository and worktree `dir` belongs to, or why there is none. */
/** The reason-text suffix naming declared paths the check could not look at. */
function externalNote(external: string[]): string {
  return external.length > 0
    ? `; not checked, outside the project's git repository: ${external.join(", ")}`
    : "";
}

/** `uncheckedPaths` only when there are any, so the result stays compact. */
function withUnchecked(external: string[]): Pick<VerificationResult, "uncheckedPaths"> {
  return external.length > 0 ? { uncheckedPaths: external } : {};
}

function gitRepoOf(dir: string): GitRepoLookup {
  try {
    const [toplevel, commonDir] = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .trim()
      .split("\n");
    return {
      ok: true,
      repo: {
        toplevel: realpathSync(toplevel),
        commonDir: realpathSync(commonDir),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A declared path made absolute with symlinks resolved as far as the path
 * exists (a declared file may be deleted, or not yet exist), so it can be
 * compared with git's realpath'd top levels - on macOS /tmp is /private/tmp.
 * A leading `~` is the user's home: declared paths like `~/.claude/CLAUDE.md`
 * are written that way, and resolving one against rootPath would silently
 * turn it into a never-changing in-repo path.
 */
function resolveDeclaredPath(rootPath: string, declared: string): string {
  const expanded =
    declared === "~" || declared.startsWith("~/")
      ? path.join(os.homedir(), declared.slice(1))
      : declared;
  let existing = path.resolve(rootPath, expanded);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(realpathSync(existing), ...missing);
  } catch {
    return path.join(existing, ...missing);
  }
}

/**
 * Splits declared paths into per-worktree pathspec groups (keyed by the cwd
 * to run git in) and the paths outside the project's repository.
 *
 * Why this exists: one `git status -- <paths>` fatals on ANY pathspec outside
 * the repository ("is outside repository"), so a single external declared
 * path (e.g. ~/.claude/CLAUDE.md) used to sink the check for every in-repo
 * path too, with a "could not check git status" that read like a broken repo.
 *
 * In-repo is decided by asking git, not by comparing against rootPath: each
 * path's nearest existing directory is resolved with `git rev-parse
 * --git-common-dir`, and the path is in-repo when that matches rootPath's
 * common dir. A lexical "is it under rootPath" test gets linked worktrees
 * wrong both ways (TTM-74 is where worktrees already bit): a worktree of the
 * same repo elsewhere on disk would read as external, and one nested inside
 * the checkout (e.g. .claude/worktrees/x) as rootPath's own files, where git
 * status from rootPath would silently see only an untracked directory.
 * Paths in rootPath's own worktree keep their declared spelling and run from
 * rootPath (unchanged behaviour); paths in another worktree of the same repo
 * run from that worktree's top level, against its own HEAD.
 *
 * External paths are reported as unverifiable rather than checked by mtime
 * against created_at. The check already answers only "has a declared file
 * plausibly moved during this task's lifetime" (see checkFilesChanged's
 * accepted false positive), so the in-repo paths carry the verdict on their
 * own; an mtime test would add a second, weaker evidence source (mtime moves
 * on checkout, copy, touch, editor saves) for files that are, by definition,
 * outside the task's branch. Naming them in the reason keeps it honest.
 */
function partitionDeclaredPaths(
  rootPath: string,
  root: GitRepo,
  filePaths: string[],
): { groups: Map<string, string[]>; external: string[] } {
  const groups = new Map<string, string[]>();
  const external: string[] = [];
  const repoByDir = new Map<string, GitRepoLookup>();

  for (const declared of filePaths) {
    const absolute = resolveDeclaredPath(rootPath, declared);
    let dir = absolute;
    while (!existsSync(dir) || !isDirectory(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    let lookup = repoByDir.get(dir);
    if (!lookup) {
      lookup = gitRepoOf(dir);
      repoByDir.set(dir, lookup);
    }

    if (!lookup.ok || lookup.repo.commonDir !== root.commonDir) {
      external.push(declared);
      continue;
    }
    const isRootWorktree = lookup.repo.toplevel === root.toplevel;
    const cwd = isRootWorktree ? rootPath : lookup.repo.toplevel;
    const pathspec = isRootWorktree ? declared : absolute;
    const group = groups.get(cwd);
    if (group) group.push(pathspec);
    else groups.set(cwd, [pathspec]);
  }

  return { groups, external };
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
