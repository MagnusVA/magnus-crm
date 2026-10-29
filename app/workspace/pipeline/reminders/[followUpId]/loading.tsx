import { TaskDetailSkeleton } from "@/app/workspace/closer/reminders/[followUpId]/_components/task-detail-skeleton";

export default function AdminTaskDetailLoading() {
  return <TaskDetailSkeleton withQueue={false} />;
}
