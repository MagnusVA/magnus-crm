"use client";

import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import type { Doc } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { ArrowLeftIcon, AlertCircleIcon } from "lucide-react";
import { MeetingDetailView } from "@/app/workspace/closer/meetings/_components/meeting-detail-view";
import { MeetingDetailSkeleton } from "@/app/workspace/closer/meetings/_components/meeting-detail-skeleton";

type MeetingDetailData = FunctionReturnType<
  typeof api.closer.meetingDetail.getMeetingDetail
>;

/**
 * The admin twin of the closer's meeting page: the same composition, with
 * the outcome actions calling the admin mutations on the assigned closer's
 * behalf, and no outcome window.
 */
export function AdminMeetingDetailClient({
  preloadedDetail,
  viewerRole,
}: {
  preloadedDetail: Preloaded<typeof api.closer.meetingDetail.getMeetingDetail>;
  viewerRole: Doc<"users">["role"];
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail) as MeetingDetailData;
  usePageTitle(detail?.lead?.fullName ? `${detail.lead.fullName} — Admin` : "Meeting");

  if (detail === undefined) {
    return <MeetingDetailSkeleton />;
  }

  if (detail === null) {
    return (
      <MeetingNotFound onBack={() => router.push("/workspace/pipeline")} />
    );
  }

  return <MeetingDetailView detail={detail} mode="admin" viewerRole={viewerRole} />;
}

function MeetingNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircleIcon />
          </EmptyMedia>
          <EmptyTitle>Meeting Not Found</EmptyTitle>
          <EmptyDescription>
            This meeting doesn&apos;t exist or you don&apos;t have access to
            it.
          </EmptyDescription>
          <Button variant="outline" onClick={onBack} className="mt-4">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to Pipeline
          </Button>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
