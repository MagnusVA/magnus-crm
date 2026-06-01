"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WeeklyScheduleEditor,
  type ScheduleDraft,
  type Weekday,
} from "./weekly-schedule-editor";

const emptyDraft: ScheduleDraft = {
  monday: "0",
  tuesday: "0",
  wednesday: "0",
  thursday: "0",
  friday: "0",
  saturday: "0",
  sunday: "0",
};

const weekdays = Object.keys(emptyDraft) as Weekday[];

function draftFromSchedules(
  schedules: Array<{ weekday: Weekday; scheduledHours: number }>,
): ScheduleDraft {
  const next = { ...emptyDraft };
  for (const schedule of schedules) {
    next[schedule.weekday] = String(schedule.scheduledHours);
  }
  return next;
}

function draftToScheduledHours(draft: ScheduleDraft): Record<Weekday, number> {
  const scheduledHours = {} as Record<Weekday, number>;
  for (const weekday of weekdays) {
    scheduledHours[weekday] = Number(draft[weekday] || 0);
  }
  return scheduledHours;
}

function WorkSchedulesSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-label="Loading work schedules"
    >
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function WorkSchedulesTab() {
  const qualifierData = useQuery(api.workSchedules.listSlackQualifierSchedules, {});
  const dmCloserData = useQuery(api.workSchedules.listDmCloserSchedules, {});
  const setQualifierWeeklySchedule = useMutation(
    api.workSchedules.setSlackQualifierWeeklySchedule,
  );
  const setDmCloserWeeklySchedule = useMutation(
    api.workSchedules.setDmCloserWeeklySchedule,
  );
  const [selectedSlackUserId, setSelectedSlackUserId] = useState<string | null>(
    null,
  );
  const [selectedDmCloserId, setSelectedDmCloserId] =
    useState<Id<"dmClosers"> | null>(null);
  const [qualifierDraft, setQualifierDraft] = useState<ScheduleDraft>(emptyDraft);
  const [dmCloserDraft, setDmCloserDraft] = useState<ScheduleDraft>(emptyDraft);
  const [savingTarget, setSavingTarget] = useState<"slack" | "dm" | null>(null);

  const slackOptions = useMemo(
    () =>
      qualifierData?.slackUsers.map((user) => ({
        id: user.slackUserId,
        label:
          user.displayName ?? user.realName ?? user.username ?? user.slackUserId,
        isDeleted: user.isDeleted,
      })) ?? [],
    [qualifierData],
  );

  const dmOptions = useMemo(() => {
    if (!dmCloserData) return [];
    const teamNameById = new Map(
      dmCloserData.attributionTeams.map((team) => [team._id, team.displayName]),
    );
    return dmCloserData.dmClosers.map((closer) => ({
      id: closer._id,
      label: `${teamNameById.get(closer.teamId) ?? "Unknown team"} / ${closer.displayName}`,
      isActive: closer.isActive,
    }));
  }, [dmCloserData]);

  const selectedSlackUser = slackOptions.find(
    (option) => option.id === selectedSlackUserId,
  );
  const selectedDmCloser = dmOptions.find(
    (option) => option.id === selectedDmCloserId,
  );

  useEffect(() => {
    if (!selectedSlackUserId && slackOptions[0]) {
      setSelectedSlackUserId(slackOptions[0].id);
    }
  }, [selectedSlackUserId, slackOptions]);

  useEffect(() => {
    if (!selectedDmCloserId && dmOptions[0]) {
      setSelectedDmCloserId(dmOptions[0].id);
    }
  }, [selectedDmCloserId, dmOptions]);

  useEffect(() => {
    setQualifierDraft(
      draftFromSchedules(
        qualifierData?.schedules.filter(
          (schedule) => schedule.slackUserId === selectedSlackUserId,
        ) ?? [],
      ),
    );
  }, [qualifierData, selectedSlackUserId]);

  useEffect(() => {
    setDmCloserDraft(
      draftFromSchedules(
        dmCloserData?.schedules.filter(
          (schedule) => schedule.dmCloserId === selectedDmCloserId,
        ) ?? [],
      ),
    );
  }, [dmCloserData, selectedDmCloserId]);

  if (qualifierData === undefined || dmCloserData === undefined) {
    return <WorkSchedulesSkeleton />;
  }

  if (qualifierData.slackUsers.length === 0 && dmCloserData.dmClosers.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No schedulable actors</EmptyTitle>
          <EmptyDescription>
            Slack qualifiers and DM closers appear here after they are synced or
            configured.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Slack qualifiers
            </h2>
            <p className="text-sm text-muted-foreground">
              Weekly scheduled hours per Slack user for efficiency denominators.
            </p>
          </div>
          {selectedSlackUser?.isDeleted ? (
            <Badge variant="secondary">Deleted in Slack</Badge>
          ) : null}
        </div>
        {slackOptions.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Slack qualifiers</EmptyTitle>
              <EmptyDescription>
                Connect Slack and sync members before configuring schedules.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Select
              value={selectedSlackUserId ?? ""}
              onValueChange={(value) => setSelectedSlackUserId(value)}
            >
              <SelectTrigger aria-label="Select Slack qualifier">
                <SelectValue placeholder="Select Slack qualifier" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {slackOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                      {option.isDeleted ? " (deleted)" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <WeeklyScheduleEditor
              value={qualifierDraft}
              onChange={setQualifierDraft}
              isSaving={savingTarget === "slack"}
              onSave={async () => {
                if (!selectedSlackUserId) return;
                setSavingTarget("slack");
                try {
                  await setQualifierWeeklySchedule({
                    slackUserId: selectedSlackUserId,
                    scheduledHours: draftToScheduledHours(qualifierDraft),
                  });
                  toast.success("Slack qualifier schedule saved.");
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Could not save schedule.",
                  );
                } finally {
                  setSavingTarget(null);
                }
              }}
            />
          </>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">DM closers</h2>
            <p className="text-sm text-muted-foreground">
              Weekly scheduled hours per DM closer for booking efficiency.
            </p>
          </div>
          {selectedDmCloser && !selectedDmCloser.isActive ? (
            <Badge variant="secondary">Inactive</Badge>
          ) : null}
        </div>
        {dmOptions.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No DM closers</EmptyTitle>
              <EmptyDescription>
                Add DM closers under Attribution before configuring schedules.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Select
              value={selectedDmCloserId ?? ""}
              onValueChange={(value) =>
                setSelectedDmCloserId(value as Id<"dmClosers">)
              }
            >
              <SelectTrigger aria-label="Select DM closer">
                <SelectValue placeholder="Select DM closer" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {dmOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <WeeklyScheduleEditor
              value={dmCloserDraft}
              onChange={setDmCloserDraft}
              isSaving={savingTarget === "dm"}
              onSave={async () => {
                if (!selectedDmCloserId) return;
                setSavingTarget("dm");
                try {
                  await setDmCloserWeeklySchedule({
                    dmCloserId: selectedDmCloserId,
                    scheduledHours: draftToScheduledHours(dmCloserDraft),
                  });
                  toast.success("DM closer schedule saved.");
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Could not save schedule.",
                  );
                } finally {
                  setSavingTarget(null);
                }
              }}
            />
          </>
        )}
      </section>
    </div>
  );
}
