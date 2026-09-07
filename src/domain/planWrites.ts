import type { DatabaseInstance } from "../db/connection.js";

/**
 * The plan writes that have to happen from inside tasks.ts and releases.ts,
 * kept in a module that imports NOTHING from the domain layer.
 *
 * That emptiness is the whole design. plans.ts imports projects, releases,
 * status and tasks, so tasks.ts or releases.ts importing plans.ts back closes
 * a cycle - and in this project's ESM setup that shape fails as `undefined`
 * at call time rather than at load, which is a much worse failure than a
 * build error. A leaf with no domain imports cannot participate in a cycle
 * with any of them, so all four files can import it freely.
 *
 * It exists because the alternative was three copies of the same UPDATE:
 * TTM-68 first landed `appendToPlanAndRevert` byte-for-byte identical in
 * tasks.ts and releases.ts, beside plans.ts's own revertPlanToDraft. The
 * column list in that UPDATE is the definition of "this approval no longer
 * stands", and the next field added to an approval would have been missed in
 * two places out of three, silently, leaving a plan that reads as approved by
 * someone who never saw the order it now describes.
 *
 * ONE OTHER STATEMENT still clears those columns and deliberately is not
 * folded in here: upsertPlan's rewrite path in plans.ts. It is not a copy of
 * this - it also sets `rationale`, and it clears unconditionally rather than
 * only `WHERE status = 'approved'`, because replacing a draft plan must
 * update its rationale too. So if an approval ever gains a field, it needs
 * adding in exactly two places: withdrawPlanApproval below, and that UPDATE.
 */

/**
 * Withdraws an approval, keeping the plan's items and rationale. Returns
 * whether one was actually withdrawn.
 *
 * `WHERE status = 'approved'` is what makes this safe to call unconditionally:
 * "there is no plan" and "the plan is already draft" are the normal cases at
 * every call site (most releases have no plan at all), so they are a no-op and
 * a `false`, never an error. That is also what makes a bulk create revert
 * *once* in effect - the first task's call withdraws the approval and every
 * later one matches no row.
 */
export function withdrawPlanApproval(db: DatabaseInstance, releaseId: string): boolean {
  const { changes } = db
    .prepare(
      `UPDATE release_plans
       SET status = 'draft', approved_by = NULL, approval_note = NULL, approved_at = NULL, updated_at = ?
       WHERE release_id = ? AND status = 'approved'`,
    )
    .run(new Date().toISOString(), releaseId);
  return changes > 0;
}

function planIdFor(db: DatabaseInstance, releaseId: string): string | undefined {
  return (
    db.prepare(`SELECT id FROM release_plans WHERE release_id = ?`).get(releaseId) as
      | { id: string }
      | undefined
  )?.id;
}

/**
 * A task has joined a batch that already has a plan: give it a place in that
 * plan and withdraw the approval.
 *
 * Appended as a new FINAL step rather than inserted anywhere clever, because
 * that is what makes re-approval cheap. "It goes last" is the common case, so
 * a person only has to say one word; any other order is available by
 * re-sending the whole plan, which is the normal path anyway now that a
 * membership change sends the plan back to draft.
 *
 * No-op when the release has no plan, which is most releases.
 */
export function appendTaskToPlan(db: DatabaseInstance, releaseId: string, taskId: string): void {
  const planId = planIdFor(db, releaseId);
  if (!planId) return;

  const { maxStep } = db
    .prepare(`SELECT COALESCE(MAX(step), 0) AS maxStep FROM release_plan_items WHERE plan_id = ?`)
    .get(planId) as { maxStep: number };

  db.prepare(
    `INSERT INTO release_plan_items (plan_id, task_id, step, position, note, added_at)
     VALUES (?, ?, ?, 0, '', ?)`,
  ).run(planId, taskId, maxStep + 1, new Date().toISOString());

  withdrawPlanApproval(db, releaseId);
}

/**
 * A task has left a batch: drop its place in the plan and withdraw the
 * approval. The item has to go rather than linger, or the plan would carry an
 * instruction to work something that is no longer in the batch - which
 * plans.ts would then report forever as orphaned drift.
 *
 * No-op when the release has no plan.
 */
export function removeTaskFromPlan(db: DatabaseInstance, releaseId: string, taskId: string): void {
  const planId = planIdFor(db, releaseId);
  if (!planId) return;

  db.prepare(`DELETE FROM release_plan_items WHERE plan_id = ? AND task_id = ?`).run(planId, taskId);
  withdrawPlanApproval(db, releaseId);
}
