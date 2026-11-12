import { Suspense } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { requireRole } from "@/lib/auth";
import { GradingPageClient } from "../../_components/quality/grading-page-client";
import { GradingSkeleton } from "../../_components/quality/grading-skeleton";

export const instant = false;

/** Grading one quality-test call. Owners and admins only, like the Call insights page. */
export default async function QualityCasePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  await requireRole(["tenant_master", "tenant_admin"]);
  const { caseId } = await params;
  return (
    <Suspense fallback={<GradingSkeleton />}>
      <GradingPageClient caseId={caseId as Id<"callInsightEvalCases">} />
    </Suspense>
  );
}
