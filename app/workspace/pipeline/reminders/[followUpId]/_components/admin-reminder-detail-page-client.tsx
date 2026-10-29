"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { AlertCircleIcon, ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { TaskDetailView } from "@/app/workspace/closer/reminders/[followUpId]/_components/task-detail-view";
import { TaskPageLayout } from "@/app/workspace/closer/reminders/[followUpId]/_components/task-page-layout";
import { taskKindLabel } from "@/app/workspace/closer/reminders/[followUpId]/_components/task-detail-types";

type Props = {
  preloadedDetail: Preloaded<typeof api.pipeline.reminderDetail.getAdminReminderDetail>;
  /**
   * The page's id, so the landing event carries it even before the reactive
   * detail is read.
   */
  followUpId: Id<"followUps">;
};

/**
 * The admin twin of the closer's task page: the same task pane, with no
 * queue, acting for the task's closer. The only outcome is Won · log
 * payment, the one reminder mutation the backend allows admins; the payment
 * is credited to the closer.
 */
export function AdminReminderDetailPageClient({ preloadedDetail, followUpId }: Props) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail);

  const personName = detail ? (detail.lead.fullName ?? detail.lead.email ?? "Unknown person") : null;
  const crumb = detail && personName ? `${personName} · ${taskKindLabel(detail.followUp)}` : null;
  usePageTitle(crumb ? `${crumb} · Task (admin)` : "Task not found");
  useBreadcrumbTrail([
    { label: "Pipeline", href: "/workspace/pipeline" },
    { label: crumb ?? "Task not found", href: `/workspace/pipeline/reminders/${followUpId}` },
  ]);

  // One landing event per mount, mirroring the closer's funnel so PostHog
  // can compare the two. No PII.
  useEffect(() => {
    if (detail) {
      posthog.capture("admin_reminder_page_opened", {
        follow_up_id: followUpId,
        opportunity_id: detail.opportunity._id,
        deal_stage: detail.opportunity.stage,
        deal_outcome: detail.opportunity.outcome,
        assigned_closer_id: detail.followUp.closerId,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (detail === null) {
    return (
      <TaskPageLayout>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle>Task not found</EmptyTitle>
            <EmptyDescription>
              It may have been removed, or it belongs to another workspace.
            </EmptyDescription>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/workspace/pipeline">
                <ArrowLeftIcon data-icon="inline-start" />
                Back to Pipeline
              </Link>
            </Button>
          </EmptyHeader>
        </Empty>
      </TaskPageLayout>
    );
  }

  return (
    <TaskPageLayout>
      <TaskDetailView
        detail={detail}
        mode="admin"
        closerName={detail.assignedCloser.name ?? detail.assignedCloser.email ?? null}
        onCompleted={() => router.push("/workspace/pipeline")}
      />
    </TaskPageLayout>
  );
}
