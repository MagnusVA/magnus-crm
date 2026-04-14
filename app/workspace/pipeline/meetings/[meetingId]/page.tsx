import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { AdminMeetingDetailClient } from "./_components/admin-meeting-detail-client";

export const unstable_instant = false;

export default async function AdminMeetingDetailPage({
  params,
}: {
  params: Promise<{ meetingId: string }>;
}) {
  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const { meetingId } = await params;

  const typedMeetingId = meetingId as Id<"meetings">;
  const preloadedDetail = await preloadQuery(
    api.closer.meetingDetail.getMeetingDetail,
    { meetingId: typedMeetingId },
    { token: session.accessToken },
  );

  return <AdminMeetingDetailClient preloadedDetail={preloadedDetail} />;
}
