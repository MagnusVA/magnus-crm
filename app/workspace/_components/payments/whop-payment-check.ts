"use client";

import { useMemo, useState } from "react";
import { useQueries } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";

// The data side of "Whop payment found" (convex/payments/reconcileCheck.ts):
// the pre-check a payment dialog runs while it is open, the two refusals a
// save can come back with, and the state a dialog keeps between its form, the
// step and its confirm step. The step itself is whop-payment-found-step.tsx.

type Reconciliation = FunctionReturnType<typeof api.payments.reconcileCheck.getPaymentReconciliation>;
export type WhopConflict = Reconciliation["conflicts"][number];
export type WhopPrefill = Reconciliation["prefill"][number];
export type WhopCheckTarget = FunctionArgs<typeof api.payments.reconcileCheck.getPaymentReconciliation>["target"];
/** The `provider` argument every manual payment writer takes. */
export type ProviderIntent = NonNullable<FunctionArgs<typeof api.closer.payments.logPayment>["provider"]>;

export const WHOP_PAYMENT_FOUND = "payment.whop_payment_found";
export const CAPACITY_HOLD = "payment.capacity_hold";

export type WhopCheck =
  | { status: "checking" }
  /** Nothing found, or the check failed: the dialog is today's. The save still checks. */
  | { status: "none" }
  | { status: "found"; conflicts: WhopConflict[]; prefill: WhopPrefill[] };

/**
 * The pre-check, live while `target` is set (pass null while the dialog is
 * closed). It never throws into the dialog: a failed check reads as "none",
 * and the save's own check still stops a duplicate.
 */
export function useWhopPaymentCheck(target: WhopCheckTarget | null): WhopCheck {
  const key = target ? JSON.stringify(target) : null;
  const queries = useMemo(
    (): Parameters<typeof useQueries>[0] =>
      key
        ? {
            check: {
              query: api.payments.reconcileCheck.getPaymentReconciliation,
              args: { target: JSON.parse(key) as WhopCheckTarget },
            },
          }
        : {},
    [key],
  );
  const result: unknown = useQueries(queries).check;
  if (!key) return { status: "none" };
  if (result === undefined) return { status: "checking" };
  if (result instanceof Error) return { status: "none" };
  const { conflicts, prefill } = result as Reconciliation;
  return conflicts.length ? { status: "found", conflicts, prefill } : { status: "none" };
}

/** "Use Whop's amount": offered only for one Whop payment with an amount. */
export function whopAmountOffer(check: WhopCheck) {
  if (check.status !== "found" || check.prefill.length !== 1) return null;
  const [prefill] = check.prefill;
  return prefill.amount === undefined ? null : { amount: prefill.amount, currency: prefill.currency };
}

export type WhopRefusal =
  | { kind: "found"; conflicts: WhopConflict[]; message: string }
  | { kind: "capacity_hold"; message: string };

/** The two refusals the step answers; anything else is the dialog's usual error. */
export function readWhopRefusal(error: unknown): WhopRefusal | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) return null;
  const { code, message, conflicts } = data as { code?: unknown; message?: unknown; conflicts?: unknown };
  const text = typeof message === "string" ? message : "";
  if ((code === WHOP_PAYMENT_FOUND || code === "payment.amount_mismatch") && Array.isArray(conflicts)) {
    return { kind: "found", conflicts: conflicts as WhopConflict[], message: text };
  }
  if (code === CAPACITY_HOLD) return { kind: "capacity_hold", message: text };
  return null;
}

export function conflictKey(conflict: WhopConflict) {
  return [
    conflict.providerPaymentId, conflict.allocationRevision, conflict.state,
    conflict.currency, conflict.state === "read_limit" ? undefined : conflict.totalMinor,
  ].join(":");
}

export function sameConflictSet(a: WhopConflict[], b: WhopConflict[]) {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(conflictKey));
  return b.every((conflict) => keys.has(conflictKey(conflict)));
}

export function paymentPins(conflicts: WhopConflict[]) {
  return conflicts.flatMap((conflict) =>
    conflict.state === "read_limit"
      ? []
      : [{ providerPaymentId: conflict.providerPaymentId, allocationRevision: conflict.allocationRevision }],
  );
}

/** "No, this is different money", pinned to every Whop payment the person saw. */
export function differentMoneyIntent(conflicts: WhopConflict[]): ProviderIntent {
  return {
    kind: "different_money",
    pins: paymentPins(conflicts),
    ...(conflicts.some((conflict) => conflict.state === "read_limit") && { acknowledgeReadLimit: true }),
  };
}

/** What the person answered in the step. */
export type WhopAnswer =
  | {
      kind: "same_money";
      intent: ProviderIntent;
      /** Recorded here already: no new payment; proof is attached to the existing one. */
      existing: boolean;
      /** Amount and currency equal Whop's: proof is waived. */
      amountsMatch: boolean;
    }
  | { kind: "different_money"; intent: ProviderIntent };

export type ProofNeed = "required" | "optional" | "waived";

/**
 * Whether an answer needs a proof file. `newMoney` is the dialog's own rule
 * for a new payment today; `roleNeedsProof` is the closer rule without the
 * suggestion waiver, which the server doesn't apply to a linked payment.
 */
export function proofNeedFor(
  answer: WhopAnswer,
  rules: { newMoney: boolean; roleNeedsProof: boolean; marksAttendance: boolean },
): ProofNeed {
  if (answer.kind === "different_money") return rules.newMoney ? "required" : "optional";
  // Attaching nothing does nothing, unless the save also marks the call attended.
  if (answer.existing) return rules.marksAttendance ? "optional" : "required";
  if (answer.amountsMatch) return "waived";
  return rules.roleNeedsProof ? "required" : "optional";
}

/** One line for the confirm step's "What happens", after the first. */
export function whopConfirmLine(answer: WhopAnswer | null) {
  if (!answer) return null;
  if (answer.kind === "different_money") return "Keeps it apart from the Whop payment you were shown.";
  return "Links it to Whop’s payment, so the money counts once.";
}

/** The success toast after a save the step answered. */
export function whopSuccessMessage(answer: WhopAnswer, options: { marksAttendance: boolean; proofAttached: boolean }) {
  if (answer.kind === "same_money" && answer.existing) {
    if (options.marksAttendance) {
      return options.proofAttached
        ? "Proof attached and the call marked attended. No second payment was added."
        : "The call is marked attended. No second payment was added.";
    }
    return "Proof attached to the payment from Whop. No second payment was added.";
  }
  return null;
}

type Shown<Values> = {
  values: Values;
  conflicts: WhopConflict[];
  /** The server answered with a different set than the person saw. */
  notice: string | null;
  /** The server refused the same set again (a read limit). */
  error: string | null;
};

/**
 * The state a payment dialog keeps for the step: the values waiting on it,
 * the answer the confirm step saves with, and a capacity hold. Each opening
 * of the dialog starts clean, like `useConfirmStep`.
 */
export function useWhopStepState<Values>(open: boolean) {
  const [shown, setShown] = useState<Shown<Values> | null>(null);
  const [answered, setAnswered] = useState<{ answer: WhopAnswer; conflicts: WhopConflict[] } | null>(null);
  const [capacityHeld, setCapacityHeld] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setShown(null);
      setAnswered(null);
      setCapacityHeld(null);
    }
  }

  return {
    /** The step's values and conflicts while it is on screen. */
    shown,
    /** The answer the confirm step saves with. */
    answer: answered?.answer ?? null,
    /** The capacity hold's message, once the server reported one. */
    capacityHeld,
    show(values: Values, conflicts: WhopConflict[]) {
      setAnswered(null);
      setShown({ values, conflicts, notice: null, error: null });
    },
    /** Record the answer. `conflicts`: the set it answered, when the step showed the pre-check's directly. */
    choose(answer: WhopAnswer, conflicts?: WhopConflict[]) {
      const seen = conflicts ?? shown?.conflicts;
      if (seen) setAnswered({ answer, conflicts: seen });
      setShown(null);
    },
    /** Back from the step: the form, with nothing answered. */
    back() {
      setShown(null);
      setAnswered(null);
    },
    /** Back from the confirm step: the step again when it was answered. Returns whether it was. */
    backFromConfirm(values: Values) {
      if (!answered) return false;
      setShown({ values, conflicts: answered.conflicts, notice: null, error: null });
      setAnswered(null);
      return true;
    },
    reset() {
      setShown(null);
      setAnswered(null);
      setCapacityHeld(null);
    },
    /**
     * A save failed: re-show the step for `payment.whop_payment_found`, or
     * hold for `payment.capacity_hold`. Returns false for any other error.
     */
    refused(error: unknown, values: Values) {
      const refusal = readWhopRefusal(error);
      if (!refusal) return false;
      if (refusal.kind === "capacity_hold") {
        setShown(null);
        setCapacityHeld(refusal.message);
        return true;
      }
      const before = shown?.conflicts ?? answered?.conflicts ?? null;
      const same = before !== null && sameConflictSet(before, refusal.conflicts);
      setAnswered(null);
      setShown({
        values,
        conflicts: refusal.conflicts,
        notice:
          before !== null && !same
            ? "Whop’s payments for this person changed while you were saving. Check them again. What you typed is kept."
            : null,
        error: same ? refusal.message || "The payment wasn’t saved. Check Billing before saving." : null,
      });
      return true;
    },
  };
}
