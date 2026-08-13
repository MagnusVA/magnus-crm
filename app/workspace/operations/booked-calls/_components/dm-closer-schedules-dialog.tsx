"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ScheduleDraft } from "@/app/workspace/_components/weekly-schedule-editor";
import {
  WeeklyScheduleDialog,
  draftFromSchedules,
  draftToScheduledHours,
  draftsEqual,
  emptyDraft,
} from "@/app/workspace/_components/weekly-schedule-dialog";

export function DmCloserSchedulesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const data = useQuery(
    api.workSchedules.listDmCloserSchedules,
    open ? {} : "skip",
  );
  const setWeeklySchedule = useMutation(
    api.workSchedules.setDmCloserWeeklySchedule,
  );
  const [selectedId, setSelectedId] = useState<Id<"dmClosers"> | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(emptyDraft);
  const [isSaving, setIsSaving] = useState(false);

  const options = useMemo(() => {
    if (!data) return [];
    const teamNameById = new Map(
      data.attributionTeams.map((team) => [team._id, team.displayName]),
    );
    return data.dmClosers.map((closer) => ({
      id: closer._id,
      label: `${teamNameById.get(closer.teamId) ?? "Unknown team"} / ${closer.displayName}`,
      badge: closer.isActive ? undefined : "Inactive",
    }));
  }, [data]);

  useEffect(() => {
    if (open && !selectedId && options[0]) {
      setSelectedId(options[0].id);
    }
  }, [open, options, selectedId]);

  const savedDraft = useMemo(
    () =>
      draftFromSchedules(
        data?.schedules.filter(
          (schedule) => schedule.dmCloserId === selectedId,
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
        dmCloserId: selectedId,
        scheduledHours: draftToScheduledHours(draft),
      });
      toast.success("DM closer schedule saved.");
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
      title="DM Closer Schedules"
      description="Weekly scheduled hours per DM closer. Booking efficiency on this page divides booked calls by these hours."
      selectLabel="Select DM closer"
      options={options}
      loading={data === undefined}
      emptyState={{
        title: "No DM closers",
        description:
          "Add DM closers under Configuration before setting schedules.",
      }}
      selectedId={selectedId}
      onSelect={(id) => setSelectedId(id as Id<"dmClosers">)}
      draft={draft}
      onDraftChange={setDraft}
      isSaving={isSaving}
      isDirty={!draftsEqual(draft, savedDraft)}
      onSave={() => void handleSave()}
    />
  );
}
