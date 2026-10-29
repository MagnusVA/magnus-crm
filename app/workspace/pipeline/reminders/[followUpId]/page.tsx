import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { AdminReminderDetailPageClient } from "./_components/admin-reminder-detail-page-client";

// PPR-ready architecture marker — see AGENTS.md §RSC three-layer page
// pattern. The static shell renders before dynamic data.
export const unstable_instant = false;

/**
 * The admin twin of the closer's task page: any reminder in the tenant,
 * the same task pane with no queue, and an "Acting for {closer}" payment.
 *   - `requireRole(["tenant_master", "tenant_admin"])` — admin-only
 *   - Uses `getAdminReminderDetail` (any reminder within the tenant)
 *
 * Payments logged here flow through the same
 * `logReminderPayment` mutation as the closer path; the backend detects
 * the admin role and stamps `origin: "admin_reminder"` +
 * `attributedCloserId: followUp.closerId` on the payment row.
 */
export default async function AdminReminderDetailPage({
  params,
}: {
  params: Promise<{ followUpId: string }>;
}) {
  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const { followUpId } = await params;

  const typedFollowUpId = followUpId as Id<"followUps">;
  const preloadedDetail = await preloadQuery(
    api.pipeline.reminderDetail.getAdminReminderDetail,
    { followUpId: typedFollowUpId },
    { token: session.accessToken },
  );

  return (
    <AdminReminderDetailPageClient
      preloadedDetail={preloadedDetail}
      followUpId={typedFollowUpId}
    />
  );
}
