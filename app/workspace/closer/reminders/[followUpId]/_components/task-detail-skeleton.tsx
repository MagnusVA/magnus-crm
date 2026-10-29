import { Skeleton } from "@/components/ui/skeleton";
import { TasksHeader, TasksSkeleton } from "@/app/workspace/closer/_components/task-list";
import { TaskPageLayout } from "./task-page-layout";

/**
 * The task page's shape while it loads: the queue on the closer's page, then
 * the board row, the note, reach and outcome cards on the left, and the
 * deal and its calls on the right.
 */
export function TaskDetailSkeleton({ withQueue }: { withQueue: boolean }) {
  return (
    <TaskPageLayout
      queue={
        withQueue ? (
          <>
            <TasksHeader titleId="queue-tasks-title" className="min-h-12" />
            <TasksSkeleton rows={5} />
          </>
        ) : undefined
      }
    >
      <TaskPaneSkeleton />
    </TaskPageLayout>
  );
}

/** The task pane alone while its task loads, beside a queue that's already there. */
export function TaskPaneSkeleton() {
  return (
    <div
      className="@container flex flex-col gap-3.5"
      role="status"
      aria-label="Loading task"
    >
      <div className="h-[9.5rem] rounded-xl bg-board @3xl:h-[5.75rem]">
        <div className="flex h-full items-center gap-6 px-4">
          <Skeleton className="h-9 w-20 bg-board-raised" />
          <Skeleton className="h-9 flex-1 bg-board-raised" />
          <Skeleton className="hidden h-8 w-40 bg-board-raised @3xl:block" />
          <Skeleton className="hidden h-9 w-28 bg-board-raised @3xl:block" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:gap-x-[1.125rem] @5xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-3.5">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-60 rounded-xl" />
        </div>
        <div className="flex flex-col gap-3.5">
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
