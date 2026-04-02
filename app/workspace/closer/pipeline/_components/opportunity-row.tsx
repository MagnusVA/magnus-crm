import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { EyeIcon } from "lucide-react";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "../../_components/status-config";

type OpportunityRowProps = {
  leadName: string;
  leadEmail?: string;
  status: string;
  latestMeetingId?: string;
  latestMeetingAt?: number;
  createdAt: number;
};

/**
 * Single row in the closer pipeline table.
 *
 * Displays lead info, status badge, next/latest meeting date, creation
 * relative time, and a "View" action linking to the meeting detail page.
 */
export function OpportunityRow({
  leadName,
  leadEmail,
  status,
  latestMeetingId,
  latestMeetingAt,
  createdAt,
}: OpportunityRowProps) {
  const config =
    opportunityStatusConfig[status as OpportunityStatus] ??
    opportunityStatusConfig.scheduled;

  return (
    <TableRow>
      {/* Lead */}
      <TableCell>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{leadName}</span>
          {leadEmail && (
            <span className="truncate text-xs text-muted-foreground">
              {leadEmail}
            </span>
          )}
        </div>
      </TableCell>

      {/* Status */}
      <TableCell>
        <Badge variant="outline" className={cn(config.badgeClass)}>
          {config.label}
        </Badge>
      </TableCell>

      {/* Meeting date */}
      <TableCell className="tabular-nums">
        {latestMeetingAt ? (
          <span title={format(latestMeetingAt, "PPP p")}>
            {format(latestMeetingAt, "MMM d, h:mm a")}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      {/* Created */}
      <TableCell className="text-muted-foreground">
        {formatDistanceToNow(createdAt, { addSuffix: true })}
      </TableCell>

      {/* Actions */}
      <TableCell className="text-right">
        {latestMeetingId ? (
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/workspace/closer/meetings/${latestMeetingId}`}>
              <EyeIcon data-icon="inline-start" />
              View
            </Link>
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">No meeting</span>
        )}
      </TableCell>
    </TableRow>
  );
}
