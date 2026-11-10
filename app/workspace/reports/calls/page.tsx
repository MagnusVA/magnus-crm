import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import ReportsLoading from "../loading";
import { CallsPageClient } from "./_components/calls-page-client";

export const instant = false;

// Calls reads the whole team, so it stays with admins even though the
// Reports area lets closers in for their own member report.
export default async function CallsReportPage() {
  await requirePermission("reports:view");

  return (
    <Suspense fallback={<ReportsLoading />}>
      <CallsPageClient />
    </Suspense>
  );
}
