import { Suspense } from "react";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { requireRole } from "@/lib/auth";
import { DashboardHeader } from "./_components/dashboard-header";
import { StatsSection } from "./_components/stats-section";
import { PipelineSection } from "./_components/pipeline-section";
import { SystemHealthSection } from "./_components/system-health-section";
import { StatsRowSkeleton } from "./_components/skeletons/stats-row-skeleton";
import { PipelineSummarySkeleton } from "./_components/skeletons/pipeline-summary-skeleton";
import { SystemHealthSkeleton } from "./_components/skeletons/system-health-skeleton";
import { SectionErrorBoundary } from "./_components/section-error-boundary";

export default async function AdminDashboardPage() {
  const { crmUser, session } = await requireRole(ADMIN_ROLES);

  return (
    <div className="flex flex-col gap-6">
      {/* Header renders immediately — no data dependency */}
      <DashboardHeader displayName={crmUser.fullName ?? crmUser.email} />

      {/* Each section streams independently with isolated error handling */}
      <SectionErrorBoundary sectionName="stats">
        <Suspense fallback={<StatsRowSkeleton />}>
          <StatsSection token={session.accessToken} />
        </Suspense>
      </SectionErrorBoundary>

      <SectionErrorBoundary sectionName="pipeline summary">
        <Suspense fallback={<PipelineSummarySkeleton />}>
          <PipelineSection token={session.accessToken} />
        </Suspense>
      </SectionErrorBoundary>

      <SectionErrorBoundary sectionName="system health">
        <Suspense fallback={<SystemHealthSkeleton />}>
          <SystemHealthSection />
        </Suspense>
      </SectionErrorBoundary>
    </div>
  );
}
