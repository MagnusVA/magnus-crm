"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { AttributionTeamDialog } from "./attribution-team-dialog";
import { DmCloserDialog } from "./dm-closer-dialog";
import { useTeamsDirectory } from "./teams-data";
import { TeamsTable, TeamsTableSkeleton } from "./teams-table";
import { UnmatchedUtms, type CreateRequest } from "./unmatched-utms";

/**
 * Team › Teams: one ruled table of teams (members by role, hours a week,
 * booked goal, status) with the lead generators on no team last, then the UTM
 * values on recent bookings that matched no team or DM closer, with a fix
 * each. `?new=team` opens the New team dialog (the band's button links
 * there); `?focus=unmatched` scrolls to the unmatched values.
 */
export function TeamsPageClient() {
  usePageTitle("Teams");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const directory = useTeamsDirectory();
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const teamMembers = useQuery(api.users.queries.listTeamMembers, {});

  const [request, setRequest] = useState<CreateRequest | null>(null);
  const newFromUrl = searchParams.get("new") === "team";
  const teamDialogOpen = newFromUrl || request?.kind === "team";
  const created = useRef<string | null>(null);

  function closeTeamDialog() {
    setRequest(null);
    const teamId = created.current;
    created.current = null;
    if (teamId) {
      router.push(`/workspace/team/teams/${teamId}`);
    } else if (newFromUrl) {
      window.history.replaceState(null, "", pathname);
    }
  }

  const unmatchedLoaded = coverage !== undefined && activity !== undefined && directory !== undefined;
  const focusUnmatched = searchParams.get("focus") === "unmatched";
  useEffect(() => {
    if (unmatchedLoaded && focusUnmatched) document.getElementById("unmatched")?.scrollIntoView({ block: "start" });
  }, [unmatchedLoaded, focusUnmatched]);

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      {directory ? <TeamsTable directory={directory} /> : <TeamsTableSkeleton />}
      {unmatchedLoaded ? (
        <UnmatchedUtms
          groups={activity.unmatchedUtms}
          capped={activity.capped}
          teams={coverage.teams}
          closers={directory.closers}
          onCreate={setRequest}
        />
      ) : null}

      <AttributionTeamDialog
        open={teamDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeTeamDialog();
        }}
        defaults={request?.kind === "team" ? { utmSource: request.utmSource, displayName: request.displayName } : undefined}
        onSaved={(teamId) => {
          created.current = teamId;
        }}
      />
      {directory ? (
        <DmCloserDialog
          open={request?.kind === "closer"}
          onOpenChange={(open) => {
            if (!open) setRequest(null);
          }}
          teams={directory.teams}
          teamMembers={teamMembers ?? []}
          defaults={
            request?.kind === "closer"
              ? {
                  utmMedium: request.utmMedium,
                  displayName: request.displayName,
                  teamId: request.teamId as Id<"attributionTeams"> | undefined,
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
