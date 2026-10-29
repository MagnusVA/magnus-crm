import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { TaskDetailSkeleton } from "./[followUpId]/_components/task-detail-skeleton";
import { TasksWorkspace } from "./[followUpId]/_components/tasks-workspace";

/**
 * The closer's tasks: the queue and the open task live here rather than in
 * the task page, so moving between tasks keeps them mounted and loads only
 * the next task. Closers only: admins open a task at
 * `/workspace/pipeline/reminders/[followUpId]`.
 */
export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<TaskDetailSkeleton withQueue />}>
      <CloserTasks>{children}</CloserTasks>
    </Suspense>
  );
}

async function CloserTasks({ children }: { children: React.ReactNode }) {
  await requireRole(["closer"]);
  return (
    <>
      <TasksWorkspace />
      {children}
    </>
  );
}
