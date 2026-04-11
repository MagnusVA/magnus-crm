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

export function RecentReassignments() {
  const reassignments = useQuery(
    api.unavailability.queries.getRecentReassignments,
    {},
  );

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
                <TableCell className="text-sm">
                  {r.fromCloserName}
                </TableCell>
                <TableCell className="text-sm">
                  {r.toCloserName}
                </TableCell>
                <TableCell className="text-sm">
                  {r.leadName ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {r.reason}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.reassignedByName}
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
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-48" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}
