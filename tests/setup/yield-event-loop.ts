import { afterEach } from "vitest";

// Let the worker's event loop turn between tests (TTM-114).
//
// The runner sends an `onTaskUpdate` RPC to the main process when a file's
// first test starts. A file whose tests are all synchronous (verification's
// run git through execSync) never returns to the event loop until the file
// ends, so the worker cannot read the reply even though it has arrived. When
// the loop finally turns, the timers phase runs before the poll phase: if the
// file took longer than 60 s, birpc's timer for that call fires first and
// vitest reports `[vitest-worker]: Timeout calling "onTaskUpdate"` as an
// unhandled error, failing a run in which every test passed. vitest 3.2.7
// hard-codes that 60 s and exposes no option for it.
//
// Load only lengthens the file, which is why this looked like a load problem
// and why it failed release_it's gate on 0.17.0. A setImmediate after each
// test reaches the poll phase, so replies are read while their timers are
// still young. Global rather than per-file, so a future synchronous file is
// covered too.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
