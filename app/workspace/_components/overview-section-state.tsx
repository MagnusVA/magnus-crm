import { AlertCircleIcon } from "lucide-react";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { BUSINESS_DAY_REBUILD_MESSAGE } from "@/lib/businessDay";
import { cn } from "@/lib/utils";

// An Overview section's state, said in place inside its card (DESIGN.md,
// SectionEmpty and SectionError): one line, never a generic alert box.

type SectionStatus =
  | { status: "rebuilding"; message: string | null }
  | { status: "empty"; message: string | null }
  | { status: "capped"; message: string | null }
  | { status: "error"; message: string | null };

export function OverviewSectionState({
  section,
  emptyTitle,
  className,
}: {
  section: SectionStatus;
  /** What is absent, such as "No submissions in this range." */
  emptyTitle: string;
  className?: string;
}) {
  switch (section.status) {
    case "rebuilding":
      return (
        <p role="status" className={cn("px-4 py-4 text-sm text-muted-foreground", className)}>
          {section.message ?? BUSINESS_DAY_REBUILD_MESSAGE}
        </p>
      );
    case "empty":
      return <SectionEmpty title={emptyTitle} className={className} />;
    case "capped":
      return (
        <SectionProblem className={className} title="This range is too large for this section.">
          {section.message ?? "Choose a shorter range to load it."}
        </SectionProblem>
      );
    case "error":
      return (
        <SectionProblem className={className} title="Couldn't load this section.">
          {section.message ?? "Reload the page to try again."}
        </SectionProblem>
      );
  }
}

export function SectionProblem({
  title,
  children,
  className,
}: {
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex items-start gap-2 px-4 py-4 text-sm", className)}>
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-danger-ink" aria-hidden="true" />
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{title}</p>
        {children ? <p className="text-muted-foreground">{children}</p> : null}
      </div>
    </div>
  );
}

/**
 * Why a section's figures are partial, said once in words above the rows.
 * Defaults to Top Qualifiers' Slack cap.
 */
export function OverviewPartialNote({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <p className={cn("border-b px-4 py-2 text-[13px] text-muted-foreground", className)}>
      <span className="font-medium text-foreground">Partial.</span>{" "}
      {children ?? "This range hit the Slack event cap, so the ranking uses the events read."}
    </p>
  );
}
