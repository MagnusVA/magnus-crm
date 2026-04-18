import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { ReminderDetailPageClient } from "./_components/reminder-detail-page-client";

// PPR-ready architecture marker — see AGENTS.md §RSC three-layer page
// pattern. The static shell renders before dynamic data.
export const unstable_instant = false;

/**
 * Reminder Detail Page (Phase 4A)
 *
 * Closer-only route that surfaces everything a closer needs to complete a
 * pending manual reminder: contact card (tel/sms), metadata (scheduled
 * time, urgency, reason, related meeting), history (latest meeting + prior
 * payments), and the outcome action bar (Phase 5).
 *
 * `requireRole(["closer"])` enforces closer-only access — admins and
 * masters have no reminder UI in MVP (design doc §12.2). They are
 * redirected to their role-appropriate workspace.
 */
export default async function ReminderDetailPage({
	params,
}: {
	params: Promise<{ followUpId: string }>;
}) {
	const { session } = await requireRole(["closer"]);
	const { followUpId } = await params;

	const typedFollowUpId = followUpId as Id<"followUps">;
	const preloadedDetail = await preloadQuery(
		api.closer.reminderDetail.getReminderDetail,
		{ followUpId: typedFollowUpId },
		{ token: session.accessToken },
	);

	return <ReminderDetailPageClient preloadedDetail={preloadedDetail} />;
}
