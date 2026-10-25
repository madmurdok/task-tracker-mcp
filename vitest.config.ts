import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The agent harness creates git worktrees at .claude/worktrees/agent-<id>/,
    // INSIDE this repository, and each is a full checkout with its own copy of
    // tests/. Vitest's default `include` globs the whole tree, so without this
    // the suite runs once per live worktree and reports the SUM as if it were
    // one run: measured at 790 tests across 61 files with two agents live,
    // against 266 across 21 for this checkout alone.
    //
    // That is worse than a wrong number. Every completion in this project is
    // verified against "the suite is green and the count is N", and N would
    // drift with however many agents happen to be running - while a test file
    // DELETED from this checkout would still pass, run from a worktree's stale
    // copy.
    //
    // It has to live here rather than as an --exclude flag on the npm script:
    // a bare `npx vitest`, a single-file run and an IDE runner all read this
    // config and none of them read the script. .gitignore does not help
    // either - vitest never consults it.
    //
    // Spread onto defaultExclude rather than replacing it: an explicit list
    // would silently drop node_modules, dist, and the config-file patterns
    // vitest ships, and their absence would only show up as something
    // stranger later.
    exclude: [...defaultExclude, "**/.claude/**"],
    // A file of synchronous tests longer than 60 s fails the whole run on a
    // vitest RPC timeout unless the worker yields between tests; see the file.
    setupFiles: ["tests/setup/yield-event-loop.ts"],
  },
});
