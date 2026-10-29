import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { TaskDetailPageClient } from "./_components/task-detail-page-client";

export const unstable_instant = false;

/**
 * The closer's task page (`followUps` of type `manual_reminder`; the route
 * keeps its old name, the UI says Task). Closers only: admins open the twin
 * at `/workspace/pipeline/reminders/[followUpId]`.
 */
export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ followUpId: string }>;
}) {
  const { session } = await requireRole(["closer"]);
  const { followUpId } = await params;

  const preloadedDetail = await preloadQuery(
    api.closer.reminderDetail.getReminderDetail,
    { followUpId: followUpId as Id<"followUps"> },
    { token: session.accessToken },
  );

  return <TaskDetailPageClient preloadedDetail={preloadedDetail} />;
}
