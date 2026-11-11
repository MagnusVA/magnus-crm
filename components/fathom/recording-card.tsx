"use client";

import { useLayoutEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { MaximizeIcon } from "lucide-react";
import {
  Card,
  CardAction,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FathomLinkField } from "@/app/workspace/closer/meetings/_components/fathom-link-field";

import { RecordingSummary } from "./recording-summary";

const AssignDialog = dynamic(() => import("./assign-recording-dialog"));
const RecordingDialog = dynamic(() => import("./recording-dialog"));

/** Shows the summary's top in the card and says when more sits below. */
function useClipped(content: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content]);
  return [ref, clipped] as const;
}

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
  const [expanded, setExpanded] = useState(false);
  const [previewRef, previewClipped] = useClipped(recording?.summary);
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
        <CardAction>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mr-2 text-muted-foreground"
                onClick={() => setExpanded(true)}
                aria-label="Open recording summary in a larger view"
              >
                <MaximizeIcon className="size-3.5" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Open larger view</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm font-medium">{recording.title}</p>
        {recording.summary && (
          <div className="space-y-1">
            <div
              ref={previewRef}
              className={cn(
                "max-h-72 overflow-hidden",
                previewClipped && "mask-b-from-60% mask-b-to-100%",
              )}
            >
              <RecordingSummary markdown={recording.summary} />
            </div>
            {previewClipped && (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => setExpanded(true)}
              >
                Read the full summary
              </Button>
            )}
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
        {expanded && (
          <RecordingDialog
            recording={recording}
            open={expanded}
            onOpenChange={setExpanded}
          />
        )}
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
