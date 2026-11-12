import { Skeleton } from "@/components/ui/skeleton";
import { CARD } from "@/app/workspace/team/_components/team-ui";

/** The grading page is wider than the tab pages: the transcript and the form sit side by side. */
export const GRADING_ROOT =
  "@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

/** Transcript left, form right from `@5xl`; stacked narrower. */
export const GRADING_COLUMNS =
  "grid items-start gap-3.5 short:gap-3 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]";

function PanelSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div role="status" aria-label={label} className={CARD}>
      <div className="flex min-h-11 items-center gap-3 border-b border-border px-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ml-auto h-4 w-20" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-4 w-9" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function GradingSkeleton() {
  return (
    <div className={GRADING_ROOT}>
      <div
        role="status"
        aria-label="Loading the call"
        className="rounded-xl bg-board px-4 py-4"
      >
        <Skeleton className="mb-2 h-3 w-24 bg-board-raised" />
        <Skeleton className="h-7 w-56 bg-board-raised" />
        <Skeleton className="mt-2 h-3 w-72 max-w-full bg-board-raised" />
      </div>
      <div className={GRADING_COLUMNS}>
        <PanelSkeleton rows={10} label="Loading the transcript" />
        <PanelSkeleton rows={6} label="Loading the grading form" />
      </div>
    </div>
  );
}
