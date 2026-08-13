"use client";

import { SaveIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Spinner } from "@/components/ui/spinner";
import {
  WeeklyScheduleEditor,
  type ScheduleDraft,
  type Weekday,
} from "./weekly-schedule-editor";

export const emptyDraft: ScheduleDraft = {
  monday: "0",
  tuesday: "0",
  wednesday: "0",
  thursday: "0",
  friday: "0",
  saturday: "0",
  sunday: "0",
};

const weekdays = Object.keys(emptyDraft) as Weekday[];

export function draftFromSchedules(
  schedules: Array<{ weekday: Weekday; scheduledHours: number }>,
): ScheduleDraft {
  const next = { ...emptyDraft };
  for (const schedule of schedules) {
    next[schedule.weekday] = String(schedule.scheduledHours);
  }
  return next;
}

export function draftToScheduledHours(
  draft: ScheduleDraft,
): Record<Weekday, number> {
  const scheduledHours = {} as Record<Weekday, number>;
  for (const weekday of weekdays) {
    scheduledHours[weekday] = Number(draft[weekday] || 0);
  }
  return scheduledHours;
}

export function draftsEqual(a: ScheduleDraft, b: ScheduleDraft): boolean {
  return weekdays.every(
    (weekday) => Number(a[weekday] || 0) === Number(b[weekday] || 0),
  );
}

export type ScheduleOption = {
  id: string;
  label: string;
  badge?: string;
};

export function WeeklyScheduleDialog({
  open,
  onOpenChange,
  title,
  description,
  selectLabel,
  options,
  loading,
  emptyState,
  selectedId,
  onSelect,
  draft,
  onDraftChange,
  isSaving,
  isDirty,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  selectLabel: string;
  options: ScheduleOption[];
  loading: boolean;
  emptyState: { title: string; description: string };
  selectedId: string | null;
  onSelect: (id: string) => void;
  draft: ScheduleDraft;
  onDraftChange: (draft: ScheduleDraft) => void;
  isSaving: boolean;
  isDirty: boolean;
  onSave: () => void;
}) {
  const selectedOption = options.find((option) => option.id === selectedId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div
            className="flex flex-col gap-4"
            role="status"
            aria-label={`Loading ${title.toLowerCase()}`}
          >
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : options.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{emptyState.title}</EmptyTitle>
              <EmptyDescription>{emptyState.description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Select
                value={selectedId ?? ""}
                onValueChange={onSelect}
                disabled={isSaving}
              >
                <SelectTrigger aria-label={selectLabel} className="flex-1">
                  <SelectValue placeholder={selectLabel} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {options.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                        {option.badge ? ` (${option.badge})` : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {selectedOption?.badge ? (
                <Badge variant="secondary">{selectedOption.badge}</Badge>
              ) : null}
            </div>

            <WeeklyScheduleEditor
              value={draft}
              onChange={onDraftChange}
              showTotal
            />
          </div>
        )}

        {!loading && options.length > 0 ? (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={onSave}
              disabled={isSaving || !isDirty || !selectedId}
            >
              {isSaving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              Save schedule
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
