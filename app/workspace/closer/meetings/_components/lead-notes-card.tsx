"use client";

import { useQuery } from "convex/react";
import { MessageSquareTextIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Read-only view of the lead's notes on the closer meeting page.
 *
 * DM closers add these notes in the link portal; phone closers need them as
 * pre-call context. Reuses `api.leads.notes.listLeadNotes`, which already
 * permits the `closer` role.
 */
export function LeadNotesCard({ leadId }: { leadId: Id<"leads"> }) {
  const notes = useQuery(api.leads.notes.listLeadNotes, { leadId });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquareTextIcon className="size-4" aria-hidden="true" />
          Notes
        </CardTitle>
        <CardDescription>Notes added by DM closers in the link portal</CardDescription>
      </CardHeader>
      <CardContent>
        {notes === undefined ? (
          <div
            role="status"
            aria-label="Loading notes"
            className="flex flex-col gap-3"
          >
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No notes yet — DM closers can add notes from the link portal.
          </p>
        ) : (
          <div className="flex flex-col divide-y">
            {notes.map((note) => (
              <div
                key={note.noteId}
                className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {note.authorLabel}
                  </span>
                  <Badge variant="outline">
                    {note.authorKind === "dm_closer" ? "DM closer" : "Team"}
                  </Badge>
                  <time
                    dateTime={new Date(note.createdAt).toISOString()}
                    className="tabular-nums"
                  >
                    {DATE_TIME_FORMATTER.format(new Date(note.createdAt))}
                  </time>
                </div>
                <p className="text-sm whitespace-pre-wrap wrap-break-word">
                  {note.content}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
