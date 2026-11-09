"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FathomLinkField } from "@/app/workspace/closer/meetings/_components/fathom-link-field";

const AssignDialog = dynamic(() => import("./assign-recording-dialog"));
/** Shared by the closer and admin meeting views. The pasted link remains the fallback. */
export function RecordingCard(props: {
  meetingId: Id<"meetings">;
  initialLink: string;
  savedAt?: number;
}) {
  const recording = useQuery(api.fathom.recordings.forMeeting, {
    meetingId: props.meetingId,
  });
  const { role } = useRole();
  const [assigning, setAssigning] = useState(false);
  if (recording === undefined)
    return (
      <Skeleton className="h-28" aria-label="Loading recording" role="status" />
    );
  if (!recording) return <FathomLinkField {...props} savedAt={props.savedAt} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recording</CardTitle>
        <p className="text-sm text-muted-foreground">
          {new Date(recording.recordedAt).toLocaleString()} ·{" "}
          {Math.round(recording.minutes)} min
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm font-medium">{recording.title}</p>
        {recording.summary && (
          <div className="max-h-80 overflow-y-auto whitespace-pre-wrap text-sm">
            {recording.summary}
          </div>
        )}
        {recording.actionItems.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Action items</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {recording.actionItems.map((item, i) => (
                <li key={i}>{item.description}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {recording.transcriptDeletedAt
            ? "Transcript removed after 90 days."
            : `${recording.transcriptPageCount} transcript pages`}{" "}
          · Recording does not record attendance. Record the call&apos;s result
          separately.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href={recording.url} target="_blank" rel="noopener noreferrer">
              Open in Fathom
            </a>
          </Button>
          {(role === "tenant_admin" || role === "tenant_master") && (
            <Button variant="ghost" onClick={() => setAssigning(true)}>
              Wrong meeting? Reassign
            </Button>
          )}
        </div>
        {assigning && (
          <AssignDialog
            recording={recording}
            open={assigning}
            onOpenChange={setAssigning}
          />
        )}
      </CardContent>
    </Card>
  );
}
