"use client";

import Link from "next/link";
import { BellRingIcon } from "lucide-react";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { NextStep } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { SetNextStepButton } from "@/app/workspace/_components/set-next-step-button";
import { CancelTaskDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/cancel-task-dialog";
import { DeleteOpportunityDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/delete-opportunity-dialog";
import { MarkDealLostDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/mark-deal-lost-dialog";
import { SideDealPaymentDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/side-deal-payment-dialog";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { DealModalSection } from "./deal-modal-section";
import type { DealModalDetail } from "./deal-modal-types";

function taskHref(viewerRole: DealModalDetail["permissions"]["viewerRole"], taskId: string) {
  return viewerRole === "closer"
    ? `/workspace/closer/reminders/${taskId}`
    : `/workspace/pipeline/reminders/${taskId}`;
}

/**
 * An open deal's next step and what can be done about it, in the person
 * page's idiom: the step (the next call, the open task, or the amber "No
 * next step"), then the deal's one lime action beside it. "Set next step"
 * is lime when the deal takes one; an open side deal's "Record payment"
 * is lime only when "Set next step" isn't showing (DESIGN.md, The Next
 * Action Rule). Closing actions and an admin's fixes sit under it as
 * outline buttons, never lime.
 */
export function DealModalNextStep({
  detail,
  now,
  setting,
  recordOutcomeHref,
  onDeleted,
}: {
  detail: DealModalDetail;
  now: number;
  setting: BusinessDaySetting;
  /** The meeting page of a call that ended with no result, if any. */
  recordOutcomeHref: string | null;
  onDeleted: () => void;
}) {
  const { opportunity, permissions, nextStep, pendingStaleNudge } = detail;
  if (nextStep === null) return null;

  const leadName = detail.lead?.fullName ?? null;
  const isAdmin = permissions.viewerRole !== "closer";
  const showSetNextStep = nextStep.canSet;
  // One "Mark lost": the side deal's own path when it applies, else an admin's fix.
  const markLostMode = permissions.canMarkLost
    ? ("side_deal" as const)
    : permissions.canAdminMarkLost
      ? ("admin" as const)
      : null;
  const canCancelTask = permissions.canAdminCancelTask && nextStep.taskId !== null;
  const hasFixes = canCancelTask || markLostMode !== null || permissions.canDeleteOpportunity;

  return (
    <DealModalSection title="Next step">
      <div className="flex min-h-13 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-5">
        <div className="min-w-0 text-[0.9375rem]">
          <NextStep next={nextStep} now={now} setting={setting} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {recordOutcomeHref ? (
            <Link href={recordOutcomeHref} className={detailLinkClass}>
              Record outcome
            </Link>
          ) : null}
          {nextStep.taskId !== null ? (
            <Link href={taskHref(permissions.viewerRole, nextStep.taskId)} className={detailLinkClass}>
              Open task
            </Link>
          ) : null}
          {permissions.canRecordPayment ? (
            <SideDealPaymentDialog
              opportunityId={opportunity._id}
              variant={showSetNextStep ? "outline" : "default"}
            />
          ) : null}
          {showSetNextStep ? (
            <SetNextStepButton opportunityId={opportunity._id} leadName={leadName} />
          ) : null}
        </div>
      </div>

      {pendingStaleNudge ? (
        <p className="flex items-center gap-2 border-t px-4 py-2 text-[0.8125rem] text-warning-ink sm:px-5">
          <BellRingIcon aria-hidden="true" className="size-3.5 shrink-0" />
          No activity on this side deal for three days. Record the payment or close it.
        </p>
      ) : null}

      {hasFixes ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t bg-muted/50 px-4 py-2 sm:px-5">
          <span className="text-[0.8125rem] text-muted-foreground">
            {isAdmin ? "Fix the deal" : "Close the deal"}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {canCancelTask && nextStep.taskId !== null ? (
              <CancelTaskDialog followUpId={nextStep.taskId} leadName={leadName} />
            ) : null}
            {markLostMode ? (
              <MarkDealLostDialog
                opportunityId={opportunity._id}
                mode={markLostMode}
                leadName={leadName}
              />
            ) : null}
            {permissions.canDeleteOpportunity ? (
              <DeleteOpportunityDialog opportunityId={opportunity._id} onDeleted={onDeleted} />
            ) : null}
          </div>
        </div>
      ) : null}
    </DealModalSection>
  );
}
