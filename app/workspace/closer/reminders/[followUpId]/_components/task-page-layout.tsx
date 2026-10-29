/**
 * The closer's task page frame: from lg up, the 340px queue runs the full
 * height beside the task pane, flush with the sidebar; below lg only the
 * pane shows, with the queue behind a control inside it. Without a queue
 * (the admin twin) it is the plain workspace page.
 */
export function TaskPageLayout({
  queue,
  children,
}: {
  queue?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!queue) return <div className="flex min-w-0 flex-col gap-3.5 pb-6">{children}</div>;
  return (
    // Cancels the workspace's px-6 py-5 so the queue meets the sidebar and
    // the header.
    <div className="-mx-6 -my-5 grid min-h-[calc(100svh-3.25rem)] lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside
        aria-labelledby="queue-tasks-title"
        className="hidden min-w-0 border-r bg-card lg:block"
      >
        {queue}
      </aside>
      <div className="flex min-w-0 flex-col gap-3.5 px-6 pt-5 pb-11">{children}</div>
    </div>
  );
}
