"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { TimelineEntry } from "@/convex/leadCustomers/timeline";
import { Badge } from "@/components/ui/badge";
import { CallNoteFields } from "@/components/ai-assistants/call-note-fields";
import { clientDisplayName } from "@/lib/agentClient";
import { Skeleton } from "@/components/ui/skeleton";

export function CallNoteTimelineRow({
  entry,
  timeZone,
}: {
  entry: TimelineEntry;
  timeZone: string;
}) {
  const note = useQuery(api.mcp.callNotes.getForEvent, {
    eventId: entry.eventId,
  });
  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Call note added</span>
        {note ? (
          <Badge variant="outline">
            via {clientDisplayName(note.agentClient)}
          </Badge>
        ) : null}
        <time
          dateTime={new Date(entry.occurredAt).toISOString()}
          className="text-xs text-muted-foreground"
        >
          {new Intl.DateTimeFormat("en-US", {
            timeZone,
            dateStyle: "medium",
            timeStyle: "short",
          }).format(entry.occurredAt)}
        </time>
      </div>
      {note === undefined ? (
        <Skeleton className="h-12" />
      ) : note ? (
        <CallNoteFields note={note} />
      ) : (
        <p className="text-sm text-muted-foreground">
          This note is unavailable.
        </p>
      )}
    </li>
  );
}
