import { requireRole } from "@/lib/auth";
import { CloserPipelinePageClient } from "./_components/closer-pipeline-page-client";

export default async function CloserPipelinePage() {
  await requireRole(["closer"]);
  return <CloserPipelinePageClient />;
}
