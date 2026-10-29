"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import posthog from "posthog-js";
import { ArrowLeftIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { businessDateForInstant, businessDayRange } from "@/lib/businessDay";
import { groupCloserTasks, nextReminderId, opensTaskPage } from "@/lib/closer-tasks";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import type { CloserTasks } from "@/app/workspace/closer/_components/task-list";
import { TaskDetailView } from "./task-detail-view";
import { TaskPaneSkeleton } from "./task-detail-skeleton";
import { TaskPageLayout } from "./task-page-layout";
import { TaskQueue, TaskQueueSheet } from "./task-queue";
import { taskKindLabel } from "./task-detail-types";

type Detail = NonNullable<FunctionReturnType<typeof api.closer.reminderDetail.getReminderDetail>>;

/**
 * The closer's tasks, worked as a queue: the list of open tasks beside the
 * task the URL names (`/workspace/closer/reminders/[followUpId]`). It lives
 * in the reminders layout, so moving between tasks keeps the queue mounted
 * and swaps only the pane: the task on screen stays, dimmed, until the next
 * one arrives, and a row's hover or focus starts loading its task.
 *
 * `/workspace/closer/reminders` itself (Today's "All tasks") opens the first
 * task in queue order, Overdue, Today, then Later.
 *
 * `getReminderDetail` returns null for a task that isn't the closer's own
 * reminder, which reads as "Task not found".
 */
export function TasksWorkspace() {
  const router = useRouter();
  const params = useParams<{ followUpId?: string }>();
  const followUpId = params.followUpId as Id<"followUps"> | undefined;
  const tasks = useQuery(api.closer.followUpQueries.getCloserTasks, {});
  const now = useNow();
  const { setting } = useBusinessDay();

  // The index opens the first task in queue order.
  const firstId = useMemo(() => {
    if (!tasks) return undefined;
    const today = businessDateForInstant(now, setting);
    const groups = groupCloserTasks(tasks, now, businessDayRange(today, setting).end);
    return [...groups.overdue, ...groups.today, ...groups.later].find(opensTaskPage)?._id ?? null;
  }, [tasks, now, setting]);
  useEffect(() => {
    if (!followUpId && firstId) router.replace(`/workspace/closer/reminders/${firstId}`);
  }, [followUpId, firstId, router]);

  const queueProps = { tasks, currentId: followUpId ?? "", now, setting };

  return (
    <TaskPageLayout queue={<TaskQueue {...queueProps} idPrefix="queue-tasks" />}>
      <TaskQueueSheet {...queueProps} />
      <SectionErrorBoundary
        sectionName="task"
        fallback={
          <div className="rounded-xl border bg-card">
            <SectionError what="this task" />
          </div>
        }
      >
        {followUpId ? (
          <TaskPane followUpId={followUpId} tasks={tasks} />
        ) : firstId === null ? (
          <NoOpenTasks />
        ) : (
          <TaskPaneSkeleton />
        )}
      </SectionErrorBoundary>
    </TaskPageLayout>
  );
}

/**
 * The open task. While the next task loads, the one on screen stays (dimmed,
 * not clickable) instead of a skeleton; a skeleton shows only on the first
 * load.
 */
function TaskPane({
  followUpId,
  tasks,
}: {
  followUpId: Id<"followUps">;
  tasks: CloserTasks | undefined;
}) {
  const live = useQuery(api.closer.reminderDetail.getReminderDetail, { followUpId });
  // The last task that resolved, kept on screen while the next one loads.
  const [shown, setShown] = useState<{ id: string; detail: Detail | null } | null>(null);
  if (live !== undefined && (shown?.id !== followUpId || shown.detail !== live)) {
    setShown({ id: followUpId, detail: live });
  }
  const loading = live === undefined;
  const detail = loading ? shown?.detail : live;

  useTaskTrail(loading ? undefined : live);

  if (detail === undefined) return <TaskPaneSkeleton />;
  return (
    <div
      aria-busy={loading || undefined}
      className={cn(
        "transition-opacity duration-150 ease-out",
        loading && "pointer-events-none opacity-60",
      )}
    >
      {detail === null ? (
        <TaskNotFound />
      ) : (
        <OpenTask key={detail.followUp._id} detail={detail} tasks={tasks} />
      )}
    </div>
  );
}

/** One task, mounted per task so its outcome steps and landing event start fresh. */
function OpenTask({ detail, tasks }: { detail: Detail; tasks: CloserTasks | undefined }) {
  const router = useRouter();
  // A task created after this moment is one this page just set (Try again).
  const [openedAt] = useState(() => Date.now());
  const currentId = detail.followUp._id;

  // A landing event per task opened: the funnel's anchor (task opened →
  // outcome chosen → completed). No PII.
  useEffect(() => {
    posthog.capture("reminder_page_opened", {
      follow_up_id: detail.followUp._id,
      opportunity_id: detail.opportunity._id,
      deal_stage: detail.opportunity.stage,
      deal_outcome: detail.opportunity.outcome,
      contact_method: detail.followUp.contactMethod ?? null,
      has_phone: Boolean(detail.lead.phone),
    });
    // Once per task, not on reactive updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCompleted = () => {
    const next = tasks ? nextReminderId(tasks.reminders, { currentId, openedAt }) : null;
    router.push(next ? `/workspace/closer/reminders/${next}` : "/workspace/closer");
  };

  return <TaskDetailView detail={detail} mode="closer" closerName={null} onCompleted={onCompleted} />;
}

/** The title and breadcrumbs name the task once it has loaded. */
function useTaskTrail(detail: Detail | null | undefined) {
  const personName = detail ? (detail.lead.fullName ?? detail.lead.email ?? "Unknown person") : null;
  const crumb = detail && personName ? `${personName} · ${taskKindLabel(detail.followUp)}` : null;
  const label = detail === undefined ? "Tasks" : (crumb ?? "Task not found");
  usePageTitle(crumb ? `${crumb} · Task` : label);
  useBreadcrumbTrail([
    { label: "Today", href: "/workspace/closer" },
    {
      label,
      href: detail ? `/workspace/closer/reminders/${detail.followUp._id}` : "/workspace/closer/reminders",
    },
  ]);
}

function NoOpenTasks() {
  useTaskTrail(undefined);
  return (
    <section
      aria-labelledby="no-tasks-title"
      className="rounded-xl border bg-card text-sm text-card-foreground"
    >
      <header className="flex min-h-[46px] items-center border-b px-4 py-2">
        <h1 id="no-tasks-title" className="text-[15px] font-semibold">
          No call-back or text-back tasks
        </h1>
      </header>
      <div className="flex flex-col items-start gap-3 px-4 py-4">
        <p className="max-w-prose text-muted-foreground">
          Tasks you set from a call land here. Scheduling links waiting on a booking are in the
          list and open on the person&apos;s page.
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

function TaskNotFound() {
  return (
    <section
      aria-labelledby="task-not-found-title"
      className="rounded-xl border bg-card text-sm text-card-foreground"
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
