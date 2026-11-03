"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { AttributionTeamDialog } from "./attribution-team-dialog";
import { buildBoard } from "./booking-model";
import { DmCloserDialog } from "./dm-closer-dialog";
import { TeamsTable, TeamsTableSkeleton } from "./teams/teams-table";
import { UnmatchedUtms, type CreateRequest } from "./teams/unmatched-utms";

/**
 * DM teams (concept B): one ruled table of teams with goal, roster, reach and
 * bookings, then the unmatched UTM values with a suggested fix each.
 * `?new=team` opens the New DM team dialog (the band's button links there);
 * `?focus=unmatched` scrolls to the unmatched values.
 */
export function TeamsPageClient() {
  usePageTitle("DM teams");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const teamMembers = useQuery(api.users.queries.listTeamMembers, {});
  const board = useMemo(() => (coverage ? buildBoard(coverage) : null), [coverage]);

  const [request, setRequest] = useState<CreateRequest | null>(null);
  const newFromUrl = searchParams.get("new") === "team";
  const teamDialogOpen = newFromUrl || request?.kind === "team";
  const created = useRef<string | null>(null);

  function closeTeamDialog() {
    setRequest(null);
    const teamId = created.current;
    created.current = null;
    if (teamId) {
      router.push(`/workspace/booking/teams/${teamId}`);
    } else if (newFromUrl) {
      window.history.replaceState(null, "", pathname);
    }
  }

  const loaded = coverage !== undefined && activity !== undefined && closers !== undefined && board !== null;
  const focusUnmatched = searchParams.get("focus") === "unmatched";
  useEffect(() => {
    if (loaded && focusUnmatched) document.getElementById("unmatched")?.scrollIntoView({ block: "start" });
  }, [loaded, focusUnmatched]);

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      {loaded ? (
        <>
          <TeamsTable coverage={coverage} board={board} bookings={activity.bookings30d.teams} closers={closers} />
          <UnmatchedUtms
            groups={activity.unmatchedUtms}
            capped={activity.capped}
            teams={coverage.teams}
            closers={closers}
            onCreate={setRequest}
          />
        </>
      ) : (
        <TeamsTableSkeleton />
      )}

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
      {teams ? (
        <DmCloserDialog
          open={request?.kind === "closer"}
          onOpenChange={(open) => {
            if (!open) setRequest(null);
          }}
          teams={teams}
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
