"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function PortalUsageCard() {
  const events = useQuery(api.linkPortal.copyQueries.listRecentCopyEvents, {
    limit: 25,
  });

  if (events === undefined) {
    return (
      <Skeleton
        className="h-64 w-full"
        role="status"
        aria-label="Loading recent portal copy activity"
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portal Copy Activity</CardTitle>
        <CardDescription>
          Recent successful link copies, without storing generated URLs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No portal copy activity recorded yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Copied</TableHead>
                <TableHead>Program</TableHead>
                <TableHead>DM Closer</TableHead>
                <TableHead>Campaign</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="tabular-nums">
                    {formatTimestamp(event.copiedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="max-w-56 truncate">
                      {event.bookingProgramName}
                    </div>
                    <div className="max-w-56 truncate text-xs text-muted-foreground">
                      {event.eventTypeName}
                    </div>
                  </TableCell>
                  <TableCell>
                    {event.dmCloser ? (
                      <MemberIdentity identity={event.dmCloser} className="max-w-48" />
                    ) : (
                      <div className="max-w-48 truncate">{event.dmCloserName}</div>
                    )}
                    <div className="max-w-48 truncate text-xs text-muted-foreground">
                      {event.attributionTeamName}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-40 truncate">{event.campaignLabel}</div>
                    <div
                      className="max-w-40 truncate font-mono text-xs text-muted-foreground"
                      translate="no"
                    >
                      {event.utmCampaign}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
