import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import ReportsLoading from "../loading";
import { ScorecardPageClient } from "./_components/scorecard-page-client";

export const instant = false;

export default async function ScorecardPage() {
  // The Reports layout lets members in for their own report; the Scorecard is admins' only.
  await requirePermission("reports:view");

  return (
    <Suspense fallback={<ReportsLoading />}>
      <ScorecardPageClient />
    </Suspense>
  );
}
