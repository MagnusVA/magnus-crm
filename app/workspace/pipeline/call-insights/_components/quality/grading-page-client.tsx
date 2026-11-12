"use client";

import { useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageBand } from "@/app/workspace/_components/page-band";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { usePageTitle } from "@/hooks/use-page-title";
import { pickLine, splitWords } from "@/lib/callInsights/quality-display";
import { CALL_INSIGHTS_HREF } from "../call-insights-band";
import { GradingGradePhase } from "./grading-grade-phase";
import {
  EMPTY_DRAFT,
  GradingListPhase,
  type ItemDraft,
} from "./grading-list-phase";
import {
  GRADING_COLUMNS,
  GRADING_ROOT,
  GradingSkeleton,
} from "./grading-skeleton";
import { GradingTranscript } from "./grading-transcript";

const QUALITY_HREF = `${CALL_INSIGHTS_HREF}?tab=quality`;

const PHASE_WORDS = {
  list: "Step 1 of 2: list what the prospect said before you see the reading.",
  grade: "Step 2 of 2: grade what the reading found.",
  done: "Graded.",
} as const;

/**
 * Grading one quality-test call: the transcript on one side and the form on
 * the other, stacked on small screens. Step 1 is the admin's own blind
 * reading; step 2 grades the reading; a graded call shows its summary.
 */
export function GradingPageClient({
  caseId,
}: {
  caseId: Id<"callInsightEvalCases">;
}) {
  usePageTitle("Grade a call");
  useBreadcrumbTrail([
    { label: "Pipeline", href: "/workspace/pipeline" },
    { label: "Call insights", href: CALL_INSIGHTS_HREF },
    { label: "Quality", href: QUALITY_HREF },
  ]);
  return (
    <SectionErrorBoundary sectionName="quality grading">
      <GradingScreen caseId={caseId} />
    </SectionErrorBoundary>
  );
}

function GradingScreen({ caseId }: { caseId: Id<"callInsightEvalCases"> }) {
  // Right after a navigation the Convex client can run a query before it has
  // the session's token; wait for it rather than fail with auth.not_authenticated.
  const { isAuthenticated } = useConvexAuth();
  const view = useQuery(
    api.callInsights.eval.cases.caseForGrading,
    isAuthenticated ? { caseId } : "skip",
  );
  const [draft, setDraft] = useState<ItemDraft>(EMPTY_DRAFT);
  const format = useLocalFormat();

  if (view === undefined) return <GradingSkeleton />;

  const facts = [
    splitWords(view.case.split),
    view.case.campaign,
    view.case.scheduledAt
      ? format(view.case.scheduledAt, "MMM d, yyyy, h:mm a")
      : null,
  ].filter(Boolean);

  return (
    <div className={GRADING_ROOT}>
      <PageBand
        back={{ href: QUALITY_HREF, label: "Quality" }}
        title={<span translate="no">{view.case.leadName}</span>}
        description={
          <>
            {facts.join(" · ")}
            <br />
            {PHASE_WORDS[view.phase]}
          </>
        }
      />
      <div className={GRADING_COLUMNS}>
        <GradingTranscript
          caseId={caseId}
          lineCount={view.transcript.lineCount}
          onPickLine={
            view.phase === "list"
              ? (line) =>
                  setDraft((current) => ({
                    ...current,
                    ...pickLine(current, line),
                  }))
              : undefined
          }
          className="@5xl:sticky @5xl:top-4"
        />
        {/* Statements, quotes and suggested values: kept out of session replay and autocapture. */}
        <div className="ph-no-capture min-w-0">
          {view.phase === "list" ? (
            <GradingListPhase view={view} draft={draft} setDraft={setDraft} />
          ) : (
            <GradingGradePhase
              key={`${view.case.labelRevision}:${view.phase}`}
              view={view}
            />
          )}
        </div>
      </div>
    </div>
  );
}
