import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import ReportsLoading from "../loading";
import { AttributionPageClient } from "./_components/attribution-page-client";

export const instant = false;

export default async function AttributionPage() {
  // The Reports layout lets members in for their own report; Attribution is admins' only.
  await requirePermission("reports:view");

  return (
    <Suspense fallback={<ReportsLoading />}>
      <AttributionPageClient />
    </Suspense>
  );
}
