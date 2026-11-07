"use client";

import Link from "next/link";
import { PageBand } from "@/app/workspace/_components/page-band";
import { usePageTitle } from "@/hooks/use-page-title";
import { PipelineRecoveryPanel } from "../../../_components/pipeline-recovery-panel";

export function AttributionPageClient() {
  usePageTitle("Attribution checks");

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Attribution checks"
        description={
          <>
            Bookings the pipeline couldn’t process. DM teams and unmatched UTMs are in{" "}
            <Link href="/workspace/team/teams" className="rounded-[3px] font-semibold text-board-foreground underline decoration-board-foreground/40 underline-offset-2 outline-none hover:decoration-board-foreground focus-visible:ring-2 focus-visible:ring-ring">
              Team › Teams
            </Link>
            , the link portal in{" "}
            <Link href="/workspace/booking/portal" className="rounded-[3px] font-semibold text-board-foreground underline decoration-board-foreground/40 underline-offset-2 outline-none hover:decoration-board-foreground focus-visible:ring-2 focus-visible:ring-ring">
              Booking setup
            </Link>
            .
          </>
        }
        back={{ href: "/workspace/operations/booked-calls", label: "Booked Calls" }}
      />
      <PipelineRecoveryPanel />
    </div>
  );
}
