import { v, type Validator } from "convex/values";

// What a payment command returns (build contract §2.1). A command returns a
// refusal, and writes nothing, when the state or the request rules it out; it
// throws `expectedError` for auth and `Error` for an invariant break.

export type PaymentCommandCode =
  | "stale_preview" // a pinned field changed since the preview
  | "kind_off" // the kind isn't at ask
  | "needs_review" // undo not allowed here: use the reviewed correction
  | "disposition_required"
  | "disposition_not_allowed"
  | "reallocated" // restore: the Whop payment now counts for another row
  | "closed_by_other_exclusion"
  | "adverse" // refund/dispute state or fence
  | "capacity_hold" // 40 stored rows on the deal, or 100 deals for the person
  | "amount_mismatch"
  | "no_closer"
  | "credit_conflict"
  | "task_closer_conflict"
  | "unlinked_manual_payment"
  | "side_deal"
  | "qualified_only"
  | "lost_by_person"
  | "not_paid"
  | "binding_invalid"
  | "program_required"
  | "not_owner"
  | "attendance_not_owed"
  | "meeting_not_started"
  | "enrollment_status_changed";

export const PAYMENT_COMMAND_CODES = [
  "stale_preview", "kind_off", "needs_review", "disposition_required", "disposition_not_allowed",
  "reallocated", "closed_by_other_exclusion", "adverse", "capacity_hold", "amount_mismatch",
  "no_closer", "credit_conflict", "task_closer_conflict", "unlinked_manual_payment", "side_deal",
  "qualified_only", "lost_by_person", "not_paid", "binding_invalid", "program_required", "not_owner",
  "attendance_not_owed", "meeting_not_started", "enrollment_status_changed",
] as const satisfies readonly PaymentCommandCode[];

export type PaymentCommandRefusal = { ok: false; code: PaymentCommandCode };

export type PaymentCommandResult<T extends object = object> =
  | ({ ok: true; alreadyApplied: boolean } & T)
  | PaymentCommandRefusal;

export const paymentCommandCodeValidator: Validator<PaymentCommandCode> = v.union(
  v.literal("stale_preview"),
  v.literal("kind_off"),
  v.literal("needs_review"),
  v.literal("disposition_required"),
  v.literal("disposition_not_allowed"),
  v.literal("reallocated"),
  v.literal("closed_by_other_exclusion"),
  v.literal("adverse"),
  v.literal("capacity_hold"),
  v.literal("amount_mismatch"),
  v.literal("no_closer"),
  v.literal("credit_conflict"),
  v.literal("task_closer_conflict"),
  v.literal("unlinked_manual_payment"),
  v.literal("side_deal"),
  v.literal("qualified_only"),
  v.literal("lost_by_person"),
  v.literal("not_paid"),
  v.literal("binding_invalid"),
  v.literal("program_required"),
  v.literal("not_owner"),
  v.literal("attendance_not_owed"),
  v.literal("meeting_not_started"),
  v.literal("enrollment_status_changed"),
);

export const paymentCommandRefusalValidator: Validator<PaymentCommandRefusal> = v.object({
  ok: v.literal(false),
  code: paymentCommandCodeValidator,
});

export function refuse(code: PaymentCommandCode): PaymentCommandRefusal {
  return { ok: false, code };
}
