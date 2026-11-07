"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ShuffleIcon } from "lucide-react";
import { format } from "date-fns";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { HelpTip, LABEL } from "./team-ui";

/** The most the query returns: the workspace's latest reassignments. */
const CLOSER_LIMIT = 50;

/**
 * The workspace's recent reassignments in a card. With `closerId`, a ruled
 * list of the ones to or from that closer, for the member card.
 */
export function RecentReassignments({ closerId }: { closerId?: Id<"users"> } = {}) {
  const reassignments = useQuery(
    api.unavailability.queries.getRecentReassignments,
    closerId ? { limit: CLOSER_LIMIT } : {},
  );

  if (closerId) {
    return <CloserReassignments closerId={closerId} reassignments={reassignments} />;
  }

  if (reassignments === undefined) {
    return <ReassignmentsSkeleton />;
  }

  if (reassignments.length === 0) {
    return null; // Don't show the section if no reassignments
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShuffleIcon className="size-4" />
          Recent Reassignments
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reassignments.map((r) => (
              <TableRow key={r._id}>
                <TableCell className="text-xs">
                  {r.meetingScheduledAt
                    ? format(
                        new Date(r.meetingScheduledAt),
                        "MMM d, h:mm a",
                      )
                    : "—"}
                </TableCell>
                <TableCell>
                  <MemberIdentity identity={r.fromCloser} />
                </TableCell>
                <TableCell>
                  <MemberIdentity identity={r.toCloser} />
                </TableCell>
                <TableCell className="text-sm">
                  {r.leadName ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {r.reason}
                  </Badge>
                </TableCell>
                <TableCell>
                  <MemberIdentity identity={r.reassignedBy} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ReassignmentsSkeleton() {
  return (
    <Card role="status" aria-label="Loading recent reassignments">
      <CardHeader>
        <Skeleton className="h-5 w-48" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}

type Reassignment = FunctionReturnType<typeof api.unavailability.queries.getRecentReassignments>[number];

function CloserReassignments({
  closerId,
  reassignments,
}: {
  closerId: Id<"users">;
  reassignments: Reassignment[] | undefined;
}) {
  const mine = reassignments?.filter(
    (row) => row.fromCloserId === closerId || row.toCloserId === closerId,
  );
  return (
    <div className="flex flex-col">
      <span className={LABEL}>
        <HelpTip
          tip={`Meetings moved to or from this closer when someone was marked unavailable, among the workspace's last ${CLOSER_LIMIT} reassignments.`}
        >
          Recent reassignments
        </HelpTip>
      </span>
      {mine === undefined ? (
        <div role="status" aria-label="Loading reassignments" className="mt-2 flex flex-col gap-1.5">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : mine.length === 0 ? (
        <p className="mt-1.5 text-[13px] text-muted-foreground">No meetings moved to or from them lately.</p>
      ) : (
        <ul className="mt-1">
          {mine.slice(0, 8).map((row) => (
            <li
              key={row._id}
              className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-t border-border py-2 text-[13.5px] first:border-t-0 @lg/card:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,0.8fr)]"
            >
              <span className="font-condensed text-[14px] font-semibold tabular-nums text-muted-foreground">
                {format(new Date(row.meetingScheduledAt ?? row.reassignedAt), "MMM d")}
              </span>
              <span className="min-w-0 truncate">
                {row.fromCloserName} → {row.toCloserName}
              </span>
              <span className="col-start-2 truncate text-[12.5px] text-muted-foreground @lg/card:col-start-3">
                {row.leadName ?? "Lead"} · {row.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
