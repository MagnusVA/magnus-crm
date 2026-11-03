"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/errors";
import { toast } from "sonner";

export default function AssignRecordingDialog({
  recording,
  open,
  onOpenChange,
}: {
  recording: {
    recordingId: Id<"callRecordings">;
    title: string;
    recordedAt: number;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const meetings = useQuery(
    api.fathom.recordings.assignmentMeetings,
    open ? { recordedAt: recording.recordedAt } : "skip",
  );
  const attach = useMutation(api.fathom.recordings.attach);
  const [meetingId, setMeetingId] = useState<Id<"meetings">>();
  const [busy, setBusy] = useState(false);
  async function assign() {
    if (!meetingId) return;
    setBusy(true);
    try {
      await attach({ recordingId: recording.recordingId, meetingId });
      onOpenChange(false);
      toast.success("Recording assigned");
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not assign recording."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign recording</DialogTitle>
          <DialogDescription>
            {recording.title}. Choose the sales call this recording belongs to.
          </DialogDescription>
        </DialogHeader>
        <Select
          value={meetingId ?? ""}
          onValueChange={(value) => setMeetingId(value as Id<"meetings">)}
        >
          <SelectTrigger aria-label="Meeting" className="w-full">
            <SelectValue
              placeholder={meetings ? "Choose a meeting" : "Loading meetings…"}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {meetings?.meetings.map((m) => (
                <SelectItem key={m.meetingId} value={m.meetingId}>
                  {m.label} · {new Date(m.scheduledAt).toLocaleString()}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {meetings?.meetings.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No meetings within 30 days of this recording.
          </p>
        )}
        {meetings?.capped && (
          <p className="text-sm text-muted-foreground">
            Showing the most recent meetings in this period. The list is
            partial.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!meetingId || busy} onClick={assign}>
            {busy ? "Assigning…" : "Assign recording"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
