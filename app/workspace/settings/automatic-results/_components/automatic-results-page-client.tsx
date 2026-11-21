"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { usePageTitle } from "@/hooks/use-page-title";
import { WHOP_SETTINGS_HREF, dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, SETTINGS_ROOT } from "@/app/workspace/settings/_components/settings-ui";
import { cn } from "@/lib/utils";
import { AUTOMATION_KINDS, CALL_INSIGHTS_SETTINGS_HREF, type AutomationKind } from "./automation-kinds";
import { AuditCard } from "./audit-card";
import { AutomaticResultsBand } from "./automatic-results-band";
import { AutomaticResultsSkeleton } from "./automatic-results-skeleton";
import { AutomaticWritesCard } from "./automatic-writes-card";
import { BreakerBanners } from "./breaker-banners";
import { CertificatesCard } from "./certificates-card";
import { ControlsCard } from "./controls-card";
import { GraderCard } from "./grader-card";
import { GradingCard } from "./grading-card";
import { LevelsCard } from "./levels-card";
import { NoticesCard } from "./notices-card";
import { ScorecardCard } from "./scorecard-card";

/**
 * One page for automatic results: the switches and the alert, the kinds that
 * went back to one tap, the clean samples, the checks of automatic results,
 * everything recorded by itself, pending losses, who grades, the scorecard,
 * and the grading queue. The page gate admits `result-automation:view`
 * (owner and admins); each control checks its own permission and says why
 * it is off.
 */
export function AutomaticResultsPageClient() {
  usePageTitle("Automatic results");
  const { hasPermission } = useRole();
  const view = useQuery(api.automation.settings.getSettings, {});
  const certificates = useQuery(api.automation.certificates.getCertificates, {});
  if (view === undefined) return <AutomaticResultsSkeleton />;

  const canGrade = hasPermission("result-automation:grade");
  const modeOf = (kind: AutomationKind) => view.configured?.kinds[kind]?.mode ?? "off";
  const anyAutomatic = AUTOMATION_KINDS.some((definition) => modeOf(definition.kind) === "automatic");
  const paymentKindsOn = AUTOMATION_KINDS.some(
    (definition) => definition.source === "payment" && modeOf(definition.kind) !== "off",
  );
  const callKindsOn =
    AUTOMATION_KINDS.some((definition) => definition.source === "call" && modeOf(definition.kind) !== "off") ||
    (view.configured?.paidOnCallAlert?.mode ?? "off") !== "off";
  const pausedAt = view.configured?.pausedAt;

  return (
    <div className={SETTINGS_ROOT}>
      <AutomaticResultsBand />

      {view.paused ? (
        <div role="status" className={cn(CARD, "border-warning-ink/40 bg-warning-surface px-4 py-3")}>
          <p className="text-[13px] leading-[1.45] font-medium text-warning-ink">
            {view.configured === null
              ? "Nothing is running. Every kind is Off."
              : `Paused${pausedAt ? ` since ${dayTimeFormat.format(pausedAt)}` : ""}. Nothing is written, proposed or closed. Whop intake and manual recording keep running.`}
          </p>
        </div>
      ) : null}

      <BreakerBanners breakers={view.breakers} canReset={view.canRaise} />

      {!view.whopConnected ? (
        <div className={cn(CARD, "px-4 py-3")}>
          <NoteLine tone="warning">
            Whop is not connected, so the payment kinds can&apos;t decide anything. The call kinds don&apos;t need it.{" "}
            <Link href={WHOP_SETTINGS_HREF} className={cn(detailLinkClass, "inline text-[13px]")}>
              Settings › Whop
            </Link>
          </NoteLine>
        </div>
      ) : view.whopLagging && paymentKindsOn && !view.paused ? (
        <div role="status" className={cn(CARD, "px-4 py-3")}>
          <NoteLine tone="warning">
            {view.whopLastReadAt === null
              ? "Whop has not been read yet."
              : `Whop has not been read since ${dayTimeFormat.format(view.whopLastReadAt)}.`}{" "}
            Payments recorded by themselves wait until it is read again, and ask instead.
          </NoteLine>
        </div>
      ) : null}

      {callKindsOn && !view.callInsightsOn ? (
        <div className={cn(CARD, "px-4 py-3")}>
          <NoteLine tone="warning">
            Call insights is off, so the three kinds that read calls and the paid-on-call alert do nothing. The payment
            kinds keep running.{" "}
            <Link href={CALL_INSIGHTS_SETTINGS_HREF} className={cn(detailLinkClass, "inline text-[13px]")}>
              Call insights settings
            </Link>
          </NoteLine>
        </div>
      ) : null}

      <SectionErrorBoundary sectionName="Automatic results switches">
        <ControlsCard view={view} certificates={certificates} whopConnected={view.whopConnected} />
      </SectionErrorBoundary>
      <LevelsCard />
      <SectionErrorBoundary sectionName="Automatic results samples">
        <CertificatesCard view={view} certificates={certificates} />
      </SectionErrorBoundary>
      {canGrade ? (
        <SectionErrorBoundary sectionName="Automatic results checks">
          <AuditCard show={anyAutomatic} />
        </SectionErrorBoundary>
      ) : null}
      <SectionErrorBoundary sectionName="Automatic results recorded by itself">
        <AutomaticWritesCard canUndo={hasPermission("result-automation:lower")} />
      </SectionErrorBoundary>
      {view.canLower ? (
        <SectionErrorBoundary sectionName="Automatic results pending losses">
          <NoticesCard show={modeOf("refusal_loss") !== "off"} />
        </SectionErrorBoundary>
      ) : null}
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
