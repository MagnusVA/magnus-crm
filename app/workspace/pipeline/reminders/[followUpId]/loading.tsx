import { TaskDetailSkeleton } from "@/app/workspace/closer/reminders/[followUpId]/_components/task-detail-skeleton";
import { SkeletonExit } from "@/components/page-transitions";

export default function AdminTaskDetailLoading() {
  return (
    <SkeletonExit>
      <TaskDetailSkeleton withQueue={false} />
    </SkeletonExit>
  );
}
