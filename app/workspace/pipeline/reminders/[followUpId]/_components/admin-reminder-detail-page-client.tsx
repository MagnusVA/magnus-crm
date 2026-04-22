"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery, useQuery } from "convex/react";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { ArrowLeftIcon, AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { LeadInfoPanel } from "@/app/workspace/closer/meetings/_components/lead-info-panel";
import { PaymentLinksPanel } from "@/app/workspace/closer/meetings/_components/payment-links-panel";
import { ReminderContactCard } from "@/app/workspace/closer/reminders/[followUpId]/_components/reminder-contact-card";
import { ReminderMetadataCard } from "@/app/workspace/closer/reminders/[followUpId]/_components/reminder-metadata-card";
import { ReminderHistoryPanel } from "@/app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel";

/**
 * Phase 7D action bar lives beside this file — dynamic import mirrors the
 * closer route so admins don't ship outcome-dialog code until they act.
 */
const AdminReminderOutcomeActionBar = dynamic(() =>
  import("./admin-reminder-outcome-action-bar").then((m) => ({
    default: m.AdminReminderOutcomeActionBar,
  })),
);

type Props = {
  preloadedDetail: Preloaded<
    typeof api.pipeline.reminderDetail.getAdminReminderDetail
  >;
  /**
   * Kept on the props contract even though the reactive `detail` object
   * carries the same id. The RSC layer uses this to build the stable
   * preload key, and downstream telemetry can read it without waiting on
   * hydration.
   */
  followUpId: Id<"followUps">;
};

/**
 * Admin Reminder Detail Page Client (Phase 7D)
 *
 * Admin mirror of the closer reminder detail surface. Reuses the same
 * presentation components (`LeadInfoPanel`, `ReminderHistoryPanel`,
 * `ReminderContactCard`, `ReminderMetadataCard`, `PaymentLinksPanel`) so
 * the two experiences stay visually consistent.
 *
 * The only differences from the closer variant:
 *   - Back link points to the pipeline (not the closer dashboard)
 *   - Action bar is `AdminReminderOutcomeActionBar`, which surfaces a
 *     subtle "Acting on behalf of {closer}" callout so admins know the
 *     payment will be attributed to the assigned closer.
 */
export function AdminReminderDetailPageClient({
  preloadedDetail,
  followUpId,
}: Props) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail);
  // Team roster gives us the assigned closer's display name for the
  // admin-on-behalf banner. The query is admin-only (matches our auth
  // surface) and already cached/subscribed by other admin pages.
  const teamMembers = useQuery(api.users.queries.listTeamMembers, {});

  usePageTitle(
    detail?.lead?.fullName
      ? `${detail.lead.fullName} — Admin`
      : "Reminder (Admin)",
  );

  // One landing event per mount when the reminder resolves — mirrors the
  // closer funnel so PostHog can compare admin vs. closer reminder
  // completion rates. Intentionally excludes PII. We pull the id from the
  // page prop (not the reactive detail) so the event fires even if the
  // query is still undefined on first paint.
  useEffect(() => {
    if (detail) {
      posthog.capture("admin_reminder_page_opened", {
        follow_up_id: followUpId,
        opportunity_id: detail.opportunity._id,
        opportunity_status: detail.opportunity.status,
        assigned_closer_id: detail.followUp.closerId,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (detail === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle>Reminder Not Found</EmptyTitle>
            <EmptyDescription>
              This reminder may have been completed already, belongs to
              another tenant, or no longer exists.
            </EmptyDescription>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => router.push("/workspace/pipeline")}
            >
              <ArrowLeftIcon data-icon="inline-start" />
              Back to Pipeline
            </Button>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const {
    followUp,
    opportunity,
    lead,
    latestMeeting,
    payments,
    paymentLinks,
  } = detail;
  const isAlreadyCompleted = followUp.status !== "pending";

  // Resolve the closer display name for the "acting on behalf" banner.
  // Falls back gracefully if the team roster hasn't loaded yet or the
  // closer has been deactivated.
  const assignedCloser = teamMembers?.find(
    (member) => member._id === followUp.closerId,
  );
  const assignedCloserName =
    assignedCloser?.fullName ?? assignedCloser?.email ?? "the assigned closer";

  const onCompleted = () => router.push("/workspace/pipeline");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/workspace/pipeline">
            <ArrowLeftIcon data-icon="inline-start" />
            Pipeline
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        {/* Left column — lead identity + history */}
        <div className="flex flex-col gap-6 md:col-span-1">
          <LeadInfoPanel
            lead={lead}
            meetingHistory={[]}
            meetingDetailBasePath="/workspace/pipeline/meetings"
          />
          <ReminderHistoryPanel
            latestMeeting={latestMeeting}
            payments={payments}
          />
        </div>

        {/* Right column — contact + metadata + actions */}
        <div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
          <ReminderContactCard followUp={followUp} lead={lead} />
          <ReminderMetadataCard
            followUp={followUp}
            opportunity={opportunity}
            latestMeeting={latestMeeting}
          />
          <AdminReminderOutcomeActionBar
            followUp={followUp}
            opportunity={opportunity}
            assignedCloserName={assignedCloserName}
            disabled={isAlreadyCompleted}
            onCompleted={onCompleted}
          />
          {paymentLinks.length > 0 && (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          )}
        </div>
      </div>
    </div>
  );
}
