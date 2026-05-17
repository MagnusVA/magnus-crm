"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

type TeamGoalDialogProps = {
  currentGoal: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const teamGoalFormSchema = z.object({
  dailyTeamQualificationGoal: z
    .string()
    .trim()
    .refine((value) => {
      if (value === "") {
        return true;
      }
      const numeric = Number(value);
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 5000;
    }, "Enter a whole number from 0 to 5000, or leave it blank."),
});

export function TeamGoalDialog({
  currentGoal,
  open,
  onOpenChange,
}: TeamGoalDialogProps) {
  const setTeamDailyGoal = useMutation(
    api.reporting.slackQualifications.setTeamDailyGoal,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm({
    resolver: standardSchemaResolver(teamGoalFormSchema),
    defaultValues: { dailyTeamQualificationGoal: "" },
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    form.reset({
      dailyTeamQualificationGoal:
        currentGoal === null ? "" : String(currentGoal),
    });
  }, [currentGoal, form, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setSubmitError(null);
    }
    onOpenChange(nextOpen);
  };

  const onSubmit = async (values: z.infer<typeof teamGoalFormSchema>) => {
    setSubmitError(null);
    const rawGoal = values.dailyTeamQualificationGoal.trim();
    const dailyTeamQualificationGoal =
      rawGoal === "" ? null : Number(rawGoal);

    try {
      await setTeamDailyGoal({ dailyTeamQualificationGoal });
      toast.success("Team goal updated");
      onOpenChange(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update team goal.";
      setSubmitError(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Team Daily Goal</DialogTitle>
          <DialogDescription>
            Set one team-wide target for Slack-qualified leads in a Honduras
            1am-to-1am business day.
          </DialogDescription>
        </DialogHeader>

        {submitError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not save team goal</AlertTitle>
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}

        <Form {...form}>
          <form
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit(onSubmit)}
          >
            <FormField
              control={form.control}
              name="dailyTeamQualificationGoal"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Daily team goal</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      inputMode="numeric"
                      placeholder="Not set"
                      disabled={form.formState.isSubmitting}
                    />
                  </FormControl>
                  <FormDescription>
                    Leave blank to track team counts and setter contribution
                    without goal attainment.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                Save Team Goal
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
