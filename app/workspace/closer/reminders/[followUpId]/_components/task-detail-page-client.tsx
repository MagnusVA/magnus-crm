"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery, useQuery } from "convex/react";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { nextReminderId } from "@/lib/closer-tasks";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TaskDetailView } from "./task-detail-view";
import { TaskPageLayout } from "./task-page-layout";
import { TaskQueue, TaskQueueSheet } from "./task-queue";
import { taskKindLabel } from "./task-detail-types";

/**
 * The closer's task page: the queue of their open tasks beside the open
 * task. Tasks are worked as a queue: once an outcome closes this task, the
 * next open reminder opens (Overdue, Today, then Later), or Today when none
 * is left.
 *
 * The preloaded `getReminderDetail` stays subscribed, so the page follows an
 * outcome recorded in another tab. It returns null for a task that isn't the
 * closer's own reminder, which reads as "Task not found".
 */
export function TaskDetailPageClient({
  preloadedDetail,
}: {
  preloadedDetail: Preloaded<typeof api.closer.reminderDetail.getReminderDetail>;
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail);
  const tasks = useQuery(api.closer.followUpQueries.getCloserTasks, {});
  const now = useNow();
  const { setting } = useBusinessDay();
  // A task created after this moment is one this page just set (Try again).
  const [openedAt] = useState(() => Date.now());

  const personName = detail ? (detail.lead.fullName ?? detail.lead.email ?? "Unknown person") : null;
  const crumb = detail && personName ? `${personName} · ${taskKindLabel(detail.followUp)}` : null;
  usePageTitle(crumb ? `${crumb} · Task` : "Task not found");
  useBreadcrumbTrail(
    detail
      ? [
          { label: "Today", href: "/workspace/closer" },
          { label: crumb ?? "Task", href: `/workspace/closer/reminders/${detail.followUp._id}` },
        ]
      : [{ label: "Today", href: "/workspace/closer" }, { label: "Task not found", href: "#" }],
  );

  // A landing event per mount once the task resolves: the funnel's anchor
  // (task opened → outcome chosen → completed). No PII.
  useEffect(() => {
    if (detail) {
      posthog.capture("reminder_page_opened", {
        follow_up_id: detail.followUp._id,
        opportunity_id: detail.opportunity._id,
        deal_stage: detail.opportunity.stage,
        deal_outcome: detail.opportunity.outcome,
        contact_method: detail.followUp.contactMethod ?? null,
        has_phone: Boolean(detail.lead.phone),
      });
    }
    // Once per mount, not on reactive updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentId = detail?.followUp._id ?? "";
  const queueProps = { tasks, currentId, now, setting };

  const onCompleted = () => {
    const next = tasks ? nextReminderId(tasks.reminders, { currentId, openedAt }) : null;
    router.push(next ? `/workspace/closer/reminders/${next}` : "/workspace/closer");
  };

  return (
    <TaskPageLayout queue={<TaskQueue {...queueProps} idPrefix="queue-tasks" />}>
      <TaskQueueSheet {...queueProps} />
      {detail === null ? (
        <TaskNotFound />
      ) : (
        <TaskDetailView
          detail={detail}
          mode="closer"
          closerName={null}
          onCompleted={onCompleted}
        />
      )}
    </TaskPageLayout>
  );
}

function TaskNotFound() {
  return (
    <section
      aria-labelledby="task-not-found-title"
      className="m-4 rounded-xl border bg-card text-sm text-card-foreground lg:m-6"
    >
      <header className="flex min-h-[46px] items-center border-b px-4 py-2">
        <h1 id="task-not-found-title" className="text-[15px] font-semibold">
          Task not found
        </h1>
      </header>
      <div className="flex flex-col items-start gap-3 px-4 py-4">
        <p className="max-w-prose text-muted-foreground">
          This link isn&apos;t one of your call-back or text-back tasks. It may belong to another
          closer, or point to a scheduling link, which opens on the person&apos;s page. Pick a task
          from the list, or go back to Today.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/workspace/closer">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to Today
          </Link>
        </Button>
      </div>
    </section>
  );
}
