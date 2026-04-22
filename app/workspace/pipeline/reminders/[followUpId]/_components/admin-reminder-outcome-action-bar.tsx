"use client";

import dynamic from "next/dynamic";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoIcon } from "lucide-react";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";

// Reuse the closer-owned dialog; the backend is role-aware and stamps
// `origin: "admin_reminder"` + `attributedCloserId: followUp.closerId`
// when an admin calls `logReminderPayment`.
const ReminderPaymentDialog = dynamic(() =>
  import(
    "@/app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog"
  ).then((m) => ({
    default: m.ReminderPaymentDialog,
  })),
);

/**
 * Terminal opportunity statuses where the reminder cannot meaningfully
 * resolve. Mirrors the closer action bar's gate so admins see the same
 * "nothing to do here" treatment.
 */
const TERMINAL_OPPORTUNITY_STATUSES = new Set<OpportunityStatus>([
  "payment_received",
  "lost",
  "no_show",
]);

type Props = {
  followUp: Doc<"followUps">;
  opportunity: Doc<"opportunities">;
  assignedCloserName: string;
  disabled: boolean;
  onCompleted: () => void;
};

/**
 * Admin Reminder Outcome Action Bar (Phase 7D)
 *
 * Thin admin-on-behalf variant of the closer `ReminderOutcomeActionBar`.
 * Only surfaces the **log payment** outcome because that's the only
 * reminder mutation extended to admin callers in v0.5.1
 * (see `logReminderPayment` in `convex/closer/reminderOutcomes.ts`).
 *
 * Non-payment outcomes (mark lost, no-response) remain closer-only; the
 * admin UX is intentionally limited to signal "only you can finish
 * closing this" to the assigned closer — admins can still intervene on a
 * payment but everything else stays in the closer's queue.
 *
 * The bar always shows an "Acting on behalf of {closer}" callout so
 * admins understand the commissionable credit goes to the closer.
 */
export function AdminReminderOutcomeActionBar({
  followUp,
  opportunity,
  assignedCloserName,
  disabled,
  onCompleted,
}: Props) {
  // --- Branch 1: reminder already completed ------------------------------
  if (disabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <InfoIcon />
            <AlertDescription>
              This reminder has already been completed.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  // --- Branch 2: opportunity locked in terminal state --------------------
  const statusKey = opportunity.status as OpportunityStatus;
  if (TERMINAL_OPPORTUNITY_STATUSES.has(statusKey)) {
    const statusLabel =
      opportunityStatusConfig[statusKey]?.label ??
      opportunity.status.replace(/_/g, " ");
    return (
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <InfoIcon />
            <AlertDescription>
              The underlying opportunity is already <b>{statusLabel}</b>.
              This reminder can no longer drive a status change.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  // --- Branch 3: actionable (admin-on-behalf log payment) ----------------
  return (
    <Card>
      <CardHeader>
        <CardTitle>Outcome</CardTitle>
        <CardDescription>
          Log a payment on behalf of the assigned closer. Commission credit
          flows to the closer, not you.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 [&_button]:w-full">
        <Alert>
          <InfoIcon />
          <AlertDescription>
            Acting on behalf of{" "}
            <span className="font-medium">{assignedCloserName}</span>. Any
            payment you record here will be attributed to them for
            commission.
          </AlertDescription>
        </Alert>

        <ReminderPaymentDialog
          followUpId={followUp._id}
          onSuccess={onCompleted}
        />

        <p className="text-xs text-muted-foreground">
          Marking the reminder as lost or no-response stays with the assigned
          closer so commission attribution flows to the person who owns the
          relationship.
        </p>
      </CardContent>
    </Card>
  );
}
