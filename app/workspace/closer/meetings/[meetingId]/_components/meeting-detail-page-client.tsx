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
import { MeetingDetailView } from "../../_components/meeting-detail-view";
import { MeetingDetailSkeleton } from "../../_components/meeting-detail-skeleton";

type MeetingDetailData = FunctionReturnType<
  typeof api.closer.meetingDetail.getMeetingDetail
>;

export function MeetingDetailPageClient({
  preloadedDetail,
  viewerRole,
}: {
  preloadedDetail: Preloaded<typeof api.closer.meetingDetail.getMeetingDetail>;
  viewerRole: Doc<"users">["role"];
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail) as MeetingDetailData;
  usePageTitle(detail?.lead?.fullName ?? "Meeting");

  const refreshDetail = async () => {
    router.refresh();
  };

  if (detail === undefined) {
    return <MeetingDetailSkeleton />;
  }

  if (detail === null) {
    return <MeetingNotFound onBack={() => router.push("/workspace/closer")} />;
  }

  return (
    <MeetingDetailView
      detail={detail}
      mode="closer"
      viewerRole={viewerRole}
      onStatusChanged={refreshDetail}
    />
  );
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
            This meeting doesn&apos;t exist or you don&apos;t have access to it.
          </EmptyDescription>
          <Button variant="outline" onClick={onBack} className="mt-4">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to Dashboard
          </Button>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
