import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import ReportsLoading from "../loading";
import { PeoplePageClient } from "./_components/people-page-client";

export const instant = false;

// The roster lists everyone, so it stays with admins; closers and lead
// generators reach only their own member report.
export default async function PeopleReportPage() {
  await requirePermission("reports:view");

  return (
    <Suspense fallback={<ReportsLoading />}>
      <PeoplePageClient />
    </Suspense>
  );
}
