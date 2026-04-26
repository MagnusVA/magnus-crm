import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { meetingStatusConfig } from "@/lib/status-config";
import type { Id } from "@/convex/_generated/dataModel";

type Meeting = {
  _id: Id<"meetings">;
  status: keyof typeof meetingStatusConfig;
  scheduledAt: number;
  durationMinutes: number;
  callClassification?: "new" | "follow_up";
};

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatMeetingType(value: Meeting["callClassification"]) {
  if (value === "follow_up") {
    return "Follow-up";
  }
  if (value === "new") {
    return "New";
  }
  return "Unclassified";
}

export function OpportunityMeetingsList({
  meetings,
  meetingBasePath,
}: {
  meetings: Meeting[];
  meetingBasePath: string;
}) {
  if (meetings.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ExternalLinkIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No meetings found</EmptyTitle>
          <EmptyDescription>
            There are no Calendly meetings linked to this opportunity yet.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Scheduled</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {meetings.map((meeting) => (
          <TableRow key={meeting._id}>
            <TableCell>
              {dateTimeFormatter.format(new Date(meeting.scheduledAt))}
            </TableCell>
            <TableCell>{meetingStatusConfig[meeting.status].label}</TableCell>
            <TableCell>{formatMeetingType(meeting.callClassification)}</TableCell>
            <TableCell>{meeting.durationMinutes} min</TableCell>
            <TableCell className="text-right">
              <Button
                asChild
                variant="ghost"
                size="sm"
                aria-label="View meeting detail"
              >
                <Link href={`${meetingBasePath}/${meeting._id}`}>
                  View
                  <ExternalLinkIcon aria-hidden="true" data-icon="inline-end" />
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      </Table>
    </div>
  );
}
