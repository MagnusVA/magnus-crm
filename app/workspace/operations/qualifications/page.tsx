import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { QualificationsPageClient } from "./_components/qualifications-page-client";
import { QualificationsPageSkeleton } from "./_components/qualifications-page-skeleton";

export const unstable_instant = false;

export default async function OperationsQualificationsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<QualificationsPageSkeleton />}>
      <QualificationsPageClient />
    </Suspense>
  );
}
