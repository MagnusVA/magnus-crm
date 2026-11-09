import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import ReportsLoading from "../loading";
import { LogPageClient } from "./_components/log-page-client";

export const instant = false;

export default async function LogPage() {
  // The Reports layout lets members in for their own report; the full Log is admins' only.
  await requirePermission("reports:view");

  return (
    <Suspense fallback={<ReportsLoading />}>
      <LogPageClient />
    </Suspense>
  );
}
