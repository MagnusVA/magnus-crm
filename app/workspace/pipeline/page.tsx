import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { requireRole } from "@/lib/auth";
import { PipelinePageClient } from "./_components/pipeline-page-client";

export const unstable_instant = { prefetch: "static" };

export default async function PipelinePage() {
  await requireRole(ADMIN_ROLES);
  return <PipelinePageClient />;
}
