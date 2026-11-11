import { preloadQuery } from "@/lib/convex-server-reads";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { ContentReveal } from "@/components/page-transitions";
import { ApprovalPageClient } from "./approval-page-client";

export const instant = false;

/**
 * A change an admin's AI assistant prepared, approved or declined here
 * (docs/plans/admin-assistant.md §4). The assistant links to this page;
 * `getPlan` decides who may see and approve it.
 */
export default async function AssistantApprovalPage({
  params,
}: {
  params: Promise<{ planId: string }>;
}) {
  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const { planId } = await params;

  const preloadedPlan = await preloadQuery(
    api.mcp.approvals.getPlan,
    { planId },
    { token: session.accessToken },
  );

  return (
    <ContentReveal>
      <ApprovalPageClient planId={planId} preloadedPlan={preloadedPlan} />
    </ContentReveal>
  );
}
