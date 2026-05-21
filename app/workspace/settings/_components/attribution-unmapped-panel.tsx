"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
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
import { formatDistanceToNow } from "date-fns";

export function AttributionUnmappedPanel() {
  const unmapped = useQuery(api.operations.unmappedUtms.listRecentUnmappedUtms, {});

  if (unmapped === undefined) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Recent Unmapped UTMs</CardTitle>
          <Badge variant={unmapped.length > 0 ? "secondary" : "outline"}>
            {unmapped.length}
          </Badge>
        </div>
        <CardDescription>
          Create or update a canonical DM team and DM closer to map future
          bookings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Scheduled</TableHead>
              <TableHead>UTM Source</TableHead>
              <TableHead>UTM Medium</TableHead>
              <TableHead>Campaign</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {unmapped.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No unmapped external UTM values in the last 30 days.
                </TableCell>
              </TableRow>
            ) : (
              unmapped.map((row) => (
                <TableRow key={row.meetingId}>
                  <TableCell>
                    {formatDistanceToNow(row.scheduledAt, { addSuffix: true })}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.utmSource ?? "-"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.utmMedium ?? "-"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.utmCampaign ?? "-"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
