"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CallNoteFields } from "@/components/ai-assistants/call-note-fields";
import { clientDisplayName } from "@/lib/agentClient";
import { useBusinessDay } from "@/hooks/use-business-day";
import { DetailCard, DetailCardFooter } from "./detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";

export function CallNotesCard({
  opportunityId,
}: {
  opportunityId: Id<"opportunities">;
}) {
  const result = useQuery(api.mcp.callNotes.getForDeal, { opportunityId });
  const { setting } = useBusinessDay();
  return (
    <DetailCard title="Call notes">
      {result === undefined ? (
        <Skeleton className="m-4 h-16" />
      ) : result.notes.length === 0 ? (
        <SectionEmpty title="No call notes yet.">
          Notes your AI assistant writes show up here.
        </SectionEmpty>
      ) : (
        <ol className="divide-y">
          {result.notes.map((note) => (
            <li key={note._id} className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="outline">
                  via {clientDisplayName(note.agentClient)}
                </Badge>
                <time
                  dateTime={new Date(note.createdAt).toISOString()}
                  className="text-xs text-muted-foreground"
                >
                  {new Intl.DateTimeFormat("en-US", {
                    timeZone: setting.timeZone,
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(note.createdAt)}
                </time>
              </div>
              <CallNoteFields note={note} />
            </li>
          ))}
        </ol>
      )}
      {result?.isPartial ? (
        <DetailCardFooter>Showing the newest 50 notes.</DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}
