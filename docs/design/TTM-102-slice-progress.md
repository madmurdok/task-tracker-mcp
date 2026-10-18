# TTM-102: slice progress counts failed and skipped slices as missing work

Status: draft for the owner's review, 2026-10-18.
Problem: the card's `Slices N/M` button counts every slice in M but only
`done` slices in N, so a task whose failed slices were replaced through
`revise_task_slices` can never reach M/M.

## 1. Where done/total lives today

| Place | What it shows | Computed by |
| :- | :- | :- |
| Board card, `Slices N/M` button | `done / all slices` | `createCard`, `src/dashboard/public/board.js` 229-242 (client only) |
| Slice popup (`renderSliceDialogContent`, board.js 806-841) | one row per slice with its status label (`SLICE_STATUS_LABELS`, 668-674); failed rows styled red (`style.css` 487-494) | no count at all |
| Board payload (`getBoardData`, `src/domain/board.ts` 227-319) | raw `slices: BoardSlice[]` per task (258-270) | no count; `BoardSlice` comment (board.ts 11) names the button |
| MCP `get_task` (`src/domain/status.ts` 161-162) | raw `slices` + `slice_revisions` | no count |
| MCP slice tools (`src/mcp/tools/slices.ts`) | per-slice `{ref,label,phase,title,status}` acks | no count |
| CLI (`src/cli/status.ts`, `session-end.ts`) | nothing about slices | - |

So the count exists in exactly one place, client-side, and only the card shows
it. The server sends every slice with its status; no server change is needed.

Cross-file answers and the call behind each:
- Who computes the counts: `search_code("count done slices of a task / slice
  progress summary")` returned no server counter (only types, `listTaskSlices`,
  `epicTaskCounts`/`releaseTaskCounts` which count tasks, not slices); the one
  counter is in `createCard`, found by grep in board.js (`slice.status === "done"`).
- Who consumes the slice list: `find_references(BoardSlice)` -> only
  `BoardTask` (board.ts); `find_callers(createCard)` -> only `createColumn`
  (board.js 247). Both complete (`hasMore:false`); semantic tier was absent, so
  receiver calls could be missing, but both anchors are plain functions/types.
- HTML/CSS (not indexed): grep `card-slices` -> `style.css` 664-679 only;
  `board.html` has no count markup.

## 2. Today's behaviour on GM-352

21 slices: 17 done, 3 failed (verifies that sent work back, one interrupted),
1 in progress (the last). Card: `Slices 17/21`. When the last slice finishes:
`Slices 18/21`, forever - the task looks 3 slices short although nothing is
left to do. The popup is right (it lists rows, never sums). `complete_task`
only refuses pending/in_progress slices (`lifecycle.ts` 267), so a done task
legitimately carries failed slices and still reads `18/21`.

## 3. Options

Both drop failed and skipped from M: they are finished, so they are not
remaining work. Done in N stays as is.

| | A: exclude silently | B: exclude and annotate (recommended) |
| :- | :- | :- |
| GM-352 now / after last slice | `Slices 17/18` / `18/18` | `Slices 17/18 · 3 failed` / `18/18 · 3 failed` |
| Benefit | Shortest label; one rule | N/M answers "how far along"; the suffix keeps "this task had rework" visible on the card without opening the popup |
| Risk | A failed slice that was **not** replaced (nobody revised yet) disappears from the card: `18/18` reads as finished while a failure is unaddressed. Hides rework history | Longer button on narrow cards (one more short token); two numbers to read |

**Recommendation: B.** A alone turns an unaddressed failure into a complete-
looking bar, which is worse than today's under-count; B fixes the denominator
and keeps the failure visible. The suffix appears only when the count is
non-zero, so the common card is unchanged (`Slices 3/5`).

Skipped slices: also excluded from M (a skip means "no longer needed" or
"not doing it", never "still to do"). They differ from failed in meaning, so
they get their own suffix, `· 1 skipped`, and never merge into `failed`.
Order: `Slices 17/18 · 3 failed · 1 skipped`. Owner may prefer to drop the
skipped suffix (a skip is a deliberate decision, less alarming) - see
section 6.

Edge: every slice failed/skipped -> M = 0: show `Slices 0/0 · 2 failed`
(button still present, popup still reachable).

## 4. Edit map

Change:
- `src/dashboard/public/board.js` - add a pure helper next to `createCard`
  (e.g. `sliceProgressLabel(slices)` -> `"Slices 17/18 · 3 failed"`), and use
  it in `createCard` 229-242 instead of the inline count; rewrite the comment at
  231-233 (it states today's rule).
- `src/domain/board.ts` 11 - the `BoardSlice` doc comment mentions
  `Slices N/M`; adjust wording only if it describes the rule.
- `tests/board.test.ts` - new `describe("board.js slice progress (TTM-102, via
  DOM shim)")` after the Blocked-by block (990-1095), reusing `loadBoardScript`
  (88) and a task stub like `blockedTask` (991-1009).

Read for context (no change):
- `SLICE_STATUS_LABELS` board.js 668-674; `SliceStatus` `src/domain/slices.ts` 17.
- `reviseTaskSlices` doc, slices.ts 384 (kept slices keep their status).
- `style.css` 664-679 (`.card-slices-button`; no change expected).

## 5. Tests to pin (one line each)

1. GM-352 shape (17 done, 3 failed in earlier steps, 1 in progress in a later
   revised step) -> `Slices 17/18 · 3 failed`.
2. Same task with the last slice done -> `Slices 18/18 · 3 failed` (complete).
3. Skipped slices leave M and show as `· N skipped`, separate from failed.
4. No failed/skipped -> plain `Slices 3/5`, no suffix.
5. All slices failed -> `Slices 0/0 · 2 failed`, button still rendered.
6. Unsliced task -> no button (TTM-84 rule kept).

Candidate controls (revert code, the test must fail):
- C1: denominator back to `task.slices.length` -> tests 1, 2, 3 fail.
- C2: drop the failed suffix -> tests 1, 2, 5 fail.
- C3: count skipped as failed (one merged suffix) -> test 3 fails.
- C4: exclude only failed, keep skipped in M -> test 3 fails.

## 6. Decisions for the owner

1. Option A or B (recommended B).
2. Skipped: own suffix (recommended) or excluded silently.
