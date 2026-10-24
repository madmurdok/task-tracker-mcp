# TTM-103 runner measurement: release 0.17.0 vs the 2026-09-24 single session

Spec: `docs/design/TTM-95-runner.md`, "Measurement plan". Measured 2026-10-24 (slice S1).

## Method
- Tool: `slice_metrics.py <jsonl> --json` (usd = API-price proxy, not `/usage`). Orchestrator = the runner session
  transcript; agents = all `<uuid>/subagents/*.jsonl` combined (usd summed, `max_context` = largest single agent).
- Tasks: TTM-105 (`88cf6747`, 5 subagents) then TTM-110 (`d04025be`, 4 subagents), run order from `runner.log`
  (TTM-105 spawned 2026-10-23 20:23Z, TTM-110 2026-10-24 09:41Z). Wall/blocked times from the run log
  `~/.task-tracker/runs/TTM-0.17.0-20261023T202313Z/` (`runner.log`, `summary.md`).
- `a72c4d6b` is NOT a runner task session: it is the owner's interactive session ("запускай следующий батч",
  no subagents) that launched the runner and mentions the TTM-105 prompt. Its $1.58 / 82k is excluded (launcher overhead).
- Baseline: session `93372688` (g-mesh 3.12.0 + TTM 0.11.0 batches, 2026-09-24), found by re-running the script. Window
  12:36-16:50Z gives orchestrator $9.13 / peak 312,138 / 26.3M reread, matching the documented ~$9 / 312k. Agents: $23.66
  for the whole session ($23.30 for 12:36-19:30Z); the session kept growing to 391k and was reset ~19:44Z. The 12:36-16:50
  window holds 6 task completions (TTM-91, GM-403, TTM-93, GM-397, GM-404, TTM-94).

## Per task vs baseline
| | TTM-105 (1st) | TTM-110 (2nd) | Baseline (12:36-16:50, 6 tasks) |
|---|---|---|---|
| Orchestrator usd | 2.17 | 1.42 | 9.13 total, ~1.52/task |
| Orchestrator reread tokens | 4.00M | 2.60M | 26.3M total, ~4.4M/task |
| Orchestrator max_context | 110.6k | 106.5k | 312.1k (peak) |
| Agents usd (all subagents) | 3.10 | 1.55 | ~23.3 (10 tasks, ~2.3/task) |
| Agents reread tokens | 4.13M | 1.51M | not computed |
| Max single-agent context | 82.5k | 64.5k | not computed |
| Orchestrator share of usd | 41% | 48% | 28% |
| Wall time (total / working) | 798.5 / 17.8 min | 23.9 / 23.8 min | n/a |
| Blocked on owner | 780.5 min | 0 | n/a |

Blocked time for TTM-105: one question form waited 727 min (overnight) and one permission prompt 53 min. Excluded, the
working time is comparable to TTM-110. Agent models: TTM-105 all opus-5-5; TTM-110 2 sonnet + 2 opus.

## Control verdict
Orchestrator `max_context` per task is 111k and 107k against a 312k peak: far below, and flat (-4% from first to second
task), so it does not grow with position within n=2. The baseline grew with position: window peaks 184k, 238k, 300k,
312k across its four windows (approximate: windows split by claim/complete times, context carries over). PASS on the
control, but two points cannot show "no trend", only "no sign of the baseline's growth".

## Caveats
- n=2 tasks, different sizes and agent mixes (TTM-110 used cheaper sonnet slices); a per-task comparison is noisy.
- usd is `slice_metrics.py` price arithmetic, not `/usage`; the owner's `/usage` before/after is not taken.
- Baseline per-task figures are my division of a mixed g-mesh/TTM window by task count; its agents' $23.3 covers 10
  tasks, its orchestrator $9.13 covers 6 (different spans). Treat the ~/task numbers as rough.
- TTM-105 orchestrator usd includes one cache re-prime after the 12 h wait (1h-TTL cache expired), so it overstates the
  steady cost; every runner session also pays a fixed start-up cache write (134k and 76k tokens written at 1h price).
- `wall_seconds` for the orchestrator is 0.0 in the script output (single-timestamp rows); wall times come from the run log.

## Candidate conclusions for the token-economy rule
- The runner delivers its stated mechanism: orchestrator context stays near 110k per task instead of growing to 312k+.
- It did not cut orchestrator spend per task: $1.4-2.2 per task vs ~$1.5 in the baseline, and the orchestrator share
  rose (41-48% vs 28%), because each session re-primes about 76-134k of context. The gain is bounded context and
  unattended operation, not lower usd; a "runner per task" rule should be justified on those, not on cost.
- "One session per batch" is still cheaper per task for short batches of small tasks; runner-per-task pays off when a
  batch is long enough that the single session would exceed ~300k (the baseline paid more reread per turn there). More
  tasks (>=5) from a runner batch are needed before deciding a threshold.
