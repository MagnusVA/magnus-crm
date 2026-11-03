"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/errors";

// Mirrors MAX_BOOKING_DAILY_QUOTA in convex/attribution/teams.ts.
const MAX_DAILY_QUOTA = 5000;

const quotaFieldSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (value === "") {
      return true;
    }
    const numeric = Number(value);
    return (
      Number.isInteger(numeric) && numeric >= 0 && numeric <= MAX_DAILY_QUOTA
    );
  }, `Enter a whole number from 0 to ${MAX_DAILY_QUOTA}, or leave it blank.`);

const bookingGoalsFormSchema = z.object({
  quotas: z.record(z.string(), quotaFieldSchema),
});

type BookingGoalsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Per-team booking goal editor for the Booked calls team goals: one "goal per
 * business day" field per active DM team, saved through
 * `attribution.teams.setTeamBookingQuota`. The full registry (teams, closers,
 * rates) lives on the Attribution page.
 */
export function BookingGoalsDialog({
  open,
  onOpenChange,
}: BookingGoalsDialogProps) {
  const teams = useQuery(api.attribution.teams.listTeams, open ? {} : "skip");
  const setTeamBookingQuota = useMutation(
    api.attribution.teams.setTeamBookingQuota,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activeTeams = useMemo(
    () => (teams ?? []).filter((team) => team.isActive),
    [teams],
  );

  const form = useForm({
    resolver: standardSchemaResolver(bookingGoalsFormSchema),
    defaultValues: { quotas: {} as Record<string, string> },
  });

  useEffect(() => {
    if (!open || teams === undefined) {
      return;
    }
    form.reset({
      quotas: Object.fromEntries(
        activeTeams.map((team) => [
          team._id,
          team.bookingDailyQuota === undefined
            ? ""
            : String(team.bookingDailyQuota),
        ]),
      ),
    });
  }, [activeTeams, form, open, teams]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setSubmitError(null);
    }
    onOpenChange(nextOpen);
  };

  const onSubmit = async (values: z.infer<typeof bookingGoalsFormSchema>) => {
    setSubmitError(null);
    try {
      for (const team of activeTeams) {
        const raw = (values.quotas[team._id] ?? "").trim();
        const next = raw === "" ? null : Number(raw);
        const current = team.bookingDailyQuota ?? null;
        if (next === current) {
          continue;
        }
        await setTeamBookingQuota({
          teamId: team._id as Id<"attributionTeams">,
          bookingDailyQuota: next,
        });
      }
      toast.success("Booking goals updated");
      onOpenChange(false);
    } catch (error) {
      const message =
        getErrorMessage(error, "Failed to update booking goals.");
      setSubmitError(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit booking goals</DialogTitle>
          <DialogDescription>
            Set each DM team&apos;s booked-calls goal per business day. A
            team&apos;s goal for a range is this number times the days in the
            range. Leave it blank for no goal.
          </DialogDescription>
        </DialogHeader>

        {submitError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not save booking goals</AlertTitle>
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}

        {teams === undefined ? (
          <div
            className="flex flex-col gap-3"
            role="status"
            aria-label="Loading DM teams"
          >
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : activeTeams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active DM teams yet. Create teams on the Attribution page first.
          </p>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit(onSubmit)}
          >
            <FieldGroup className="gap-0 rounded-[9.8px] border">
              {activeTeams.map((team) => (
                <Controller
                  key={team._id}
                  control={form.control}
                  name={`quotas.${team._id}`}
                  render={({ field, fieldState }) => (
                    <Field
                      orientation="horizontal"
                      data-invalid={fieldState.invalid}
                      className="flex-wrap border-b px-4 py-2.5 last:border-b-0"
                    >
                      <FieldLabel htmlFor={`quota-${team._id}`} className="min-w-0 flex-1 font-medium">
                        {team.displayName}
                      </FieldLabel>
                      <div className="flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
                        <Input
                          {...field}
                          id={`quota-${team._id}`}
                          value={field.value ?? ""}
                          inputMode="numeric"
                          placeholder="No goal"
                          disabled={form.formState.isSubmitting}
                          aria-invalid={fieldState.invalid}
                          aria-label={`Daily booking goal for ${team.displayName}`}
                          className="w-24 text-right font-condensed text-[15px] font-semibold tabular-nums placeholder:font-sans placeholder:text-[13px] placeholder:font-normal"
                        />
                        a day
                      </div>
                      {fieldState.invalid ? <FieldError errors={[fieldState.error]} className="basis-full" /> : null}
                    </Field>
                  )}
                />
              ))}
            </FieldGroup>

            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={form.formState.isSubmitting}
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                Save goals
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
