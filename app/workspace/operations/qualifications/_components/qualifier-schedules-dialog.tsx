"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { ScheduleDraft } from "@/app/workspace/_components/weekly-schedule-editor";
import {
  WeeklyScheduleDialog,
  draftFromSchedules,
  draftToScheduledHours,
  draftsEqual,
  emptyDraft,
} from "@/app/workspace/_components/weekly-schedule-dialog";

export function QualifierSchedulesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const data = useQuery(
    api.workSchedules.listSlackQualifierSchedules,
    open ? {} : "skip",
  );
  const setWeeklySchedule = useMutation(
    api.workSchedules.setSlackQualifierWeeklySchedule,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(emptyDraft);
  const [isSaving, setIsSaving] = useState(false);

  const options = useMemo(
    () =>
      data?.slackUsers.map((user) => ({
        id: user.slackUserId,
        label:
          user.displayName ?? user.realName ?? user.username ?? user.slackUserId,
        badge: user.isDeleted ? "Deleted in Slack" : undefined,
      })) ?? [],
    [data],
  );

  useEffect(() => {
    if (open && !selectedId && options[0]) {
      setSelectedId(options[0].id);
    }
  }, [open, options, selectedId]);

  const savedDraft = useMemo(
    () =>
      draftFromSchedules(
        data?.schedules.filter(
          (schedule) => schedule.slackUserId === selectedId,
        ) ?? [],
      ),
    [data, selectedId],
  );

  useEffect(() => {
    setDraft(savedDraft);
  }, [savedDraft]);

  const handleSave = async () => {
    if (!selectedId) return;
    setIsSaving(true);
    try {
      await setWeeklySchedule({
        slackUserId: selectedId,
        scheduledHours: draftToScheduledHours(draft),
      });
      toast.success("Slack qualifier schedule saved.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save schedule.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <WeeklyScheduleDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Qualifier Schedules"
      description="Weekly scheduled hours per Slack qualifier. Efficiency on this page divides qualified leads by these hours."
      selectLabel="Select Slack qualifier"
      options={options}
      loading={data === undefined}
      emptyState={{
        title: "No Slack qualifiers",
        description:
          "Connect Slack and sync members before configuring schedules.",
      }}
      selectedId={selectedId}
      onSelect={setSelectedId}
      draft={draft}
      onDraftChange={setDraft}
      isSaving={isSaving}
      isDirty={!draftsEqual(draft, savedDraft)}
      onSave={() => void handleSave()}
    />
  );
}
