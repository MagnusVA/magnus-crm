"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useForm } from "react-hook-form";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

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
 * Slim per-team booking goal editor for the Booked Calls goal ring: one
 * "goal per business day" input per active DM team, saved through
 * `attribution.teams.setTeamBookingQuota`. The full registry (teams, closers,
 * rates) lives in the page's Configuration sheet.
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
        error instanceof Error
          ? error.message
          : "Failed to update booking goals.";
      setSubmitError(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Booking Goals</DialogTitle>
          <DialogDescription>
            Set each DM team&apos;s booked-calls goal per business day. The
            goal ring multiplies these by the business days in the selected
            range.
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
            No active DM teams yet. Create teams in Configuration first.
          </p>
        ) : (
          <Form {...form}>
            <form
              className="flex flex-col gap-4"
              onSubmit={form.handleSubmit(onSubmit)}
            >
              {activeTeams.map((team) => (
                <FormField
                  key={team._id}
                  control={form.control}
                  name={`quotas.${team._id}`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{team.displayName}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          inputMode="numeric"
                          placeholder="Not set"
                          disabled={form.formState.isSubmitting}
                          aria-label={`Daily booking goal for ${team.displayName}`}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}

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
                  Save Booking Goals
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
