import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import ReportsLoading from "../loading";
import { PipelinePageClient } from "./_components/pipeline-page-client";

export const instant = false;

export default async function PipelinePage() {
  // The Reports layout lets members in for their own report; Pipeline is admins' only.
  await requirePermission("reports:view");

  return (
    <Suspense fallback={<ReportsLoading />}>
      <PipelinePageClient />
    </Suspense>
  );
}
