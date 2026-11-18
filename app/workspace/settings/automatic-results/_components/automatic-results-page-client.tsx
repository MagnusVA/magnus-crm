"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { usePageTitle } from "@/hooks/use-page-title";
import { WHOP_SETTINGS_HREF, dayTimeFormat, useWhopConnection } from "@/components/whop/whop-settings-parts";
import { AutomationBanner } from "@/app/workspace/_components/automation-banner";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, SETTINGS_ROOT } from "@/app/workspace/settings/_components/settings-ui";
import { cn } from "@/lib/utils";
import { AUTOMATION_KINDS } from "./automation-kinds";
import { AutomaticResultsBand } from "./automatic-results-band";
import { AutomaticResultsSkeleton } from "./automatic-results-skeleton";
import { ControlsCard } from "./controls-card";
import { GraderCard } from "./grader-card";
import { GradingCard } from "./grading-card";
import { LevelsCard } from "./levels-card";
import { ScorecardCard } from "./scorecard-card";

/**
 * One page for automatic results: the switches, the four levels, who grades,
 * the scorecard, and the grading queue for those who grade. The page gate
 * admits `result-automation:view`; each control checks its own permission.
 */
export function AutomaticResultsPageClient() {
  usePageTitle("Automatic results");
  const { hasPermission } = useRole();
  const view = useQuery(api.automation.settings.getSettings, {});
  const connection = useWhopConnection();
  if (view === undefined || connection === undefined) return <AutomaticResultsSkeleton />;

  const whopConnected = connection?.status === "connected";
  const canGrade = hasPermission("result-automation:grade");
  const paused = view.configured !== null && !view.configured.enabled;
  const needsWhop = AUTOMATION_KINDS.some((kind) => kind.needsWhop);

  return (
    <div className={SETTINGS_ROOT}>
      <AutomaticResultsBand />
      <AutomationBanner onPanel />

      {paused ? (
        <div role="status" className={cn(CARD, "border-warning-ink/40 bg-warning-surface px-4 py-3")}>
          <p className="text-[13px] leading-[1.45] font-medium text-warning-ink">
            Paused{view.configured?.pausedAt ? ` since ${dayTimeFormat.format(view.configured.pausedAt)}` : ""}. Nothing
            is written or proposed. Whop intake and manual recording keep running.
          </p>
        </div>
      ) : null}

      {needsWhop && !whopConnected ? (
        <div className={cn(CARD, "px-4 py-3")}>
          <NoteLine tone="warning">
            Whop is not connected, so the payment kinds can&apos;t decide anything.{" "}
            <Link href={WHOP_SETTINGS_HREF} className={cn(detailLinkClass, "inline text-[13px]")}>
              Settings › Whop
            </Link>
          </NoteLine>
        </div>
      ) : null}

      <SectionErrorBoundary sectionName="Automatic results switches">
        <ControlsCard view={view} whopConnected={whopConnected} canGrade={canGrade} />
      </SectionErrorBoundary>
      <LevelsCard />
      <SectionErrorBoundary sectionName="Automatic results grader">
        <GraderCard view={view} />
      </SectionErrorBoundary>
      <SectionErrorBoundary sectionName="Automatic results scorecard">
        <ScorecardCard />
      </SectionErrorBoundary>
      {canGrade ? (
        <SectionErrorBoundary sectionName="Automatic results grading">
          <GradingCard canResolveUnsure={hasPermission("result-automation:resolve-unsure")} />
        </SectionErrorBoundary>
      ) : null}
    </div>
  );
}
