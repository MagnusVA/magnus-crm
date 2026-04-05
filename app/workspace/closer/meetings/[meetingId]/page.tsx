import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { MeetingDetailPageClient } from "./_components/meeting-detail-page-client";

export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ meetingId: string }>;
}) {
  const { session } = await requireRole(["closer"]);
  const { meetingId } = await params;

  const typedMeetingId = meetingId as Id<"meetings">;
  const preloadedDetail = await preloadQuery(
    api.closer.meetingDetail.getMeetingDetail,
    { meetingId: typedMeetingId },
    { token: session.accessToken },
  );

  return (
    <MeetingDetailPageClient
      preloadedDetail={preloadedDetail}
    />
  );
}
