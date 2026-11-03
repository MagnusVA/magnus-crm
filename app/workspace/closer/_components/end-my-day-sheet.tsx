"use client";

import { useState } from "react";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { getErrorMessage } from "@/lib/errors";
import { formatAmountMinor } from "@/lib/format-currency";
import { EndDayStatus } from "./end-day-status";

type Summary = FunctionReturnType<typeof api.closer.endOfDay.getDaySummary>;
const formSchema = z.object({
  note: z.string().max(2000, "Keep the note under 2,000 characters."),
});

export function EndMyDaySheet({
  open,
  onOpenChange,
  summary,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: Summary;
  timeZone?: string;
}) {
  const endDay = useMutation(api.closer.endOfDay.endMyDay);
  const retry = useMutation(api.closer.endOfDay.retryEndOfDayPost);
  const [reportId, setReportId] = useState<Id<"endOfDayReports">>();
  const [error, setError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const latest = useQuery(
    api.closer.endOfDay.getMyReport,
    reportId ? { reportId } : "skip",
  );
  const form = useForm({
    resolver: standardSchemaResolver(formSchema),
    defaultValues: { note: "" },
  });
  const numbers = latest?.numbers ?? summary.numbers;
  const gaps = latest?.gaps ?? summary.gaps;
  const zone = latest?.timeZone ?? summary.timeZone;
  const since = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(latest?.periodStart ?? summary.periodStart);
  async function submit(values: z.infer<typeof formSchema>) {
    setError(undefined);
    try {
      const report = await endDay({ note: values.note || undefined, timeZone });
      setReportId(report._id);
    } catch (error) {
      setError(getErrorMessage(error, "Couldn't end your day. Try again."));
    }
  }
  async function retryPost() {
    if (!reportId) return;
    setRetrying(true);
    setError(undefined);
    try {
      await retry({ reportId });
    } catch (error) {
      setError(getErrorMessage(error, "Couldn't retry the Slack post."));
    } finally {
      setRetrying(false);
    }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-[480px]">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>End my day</SheetTitle>
          <SheetDescription>
            Since {since} · your time · {zone}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
          {(latest?.previousDayUnclosed ?? summary.previousDayUnclosed) && (
            <p className="text-[13px] text-warning-ink">
              The previous day was never closed. This report covers the last 24
              hours.
            </p>
          )}
          <CallNumbers title="New calls" calls={numbers.newCalls} />
          <p className="text-[13px]">
            Close rate, first calls{" "}
            <strong className="font-condensed text-xl tabular-nums">
              {numbers.closeRate.won} of {numbers.closeRate.cohort}
            </strong>
          </p>
          <Separator />
          <CallNumbers title="Follow-up calls" calls={numbers.followUpCalls} />
          <p className="text-[13px]">
            Call-backs due {numbers.callbacks.due} · Done{" "}
            {numbers.callbacks.done} · Pending {numbers.callbacks.pending}
            <br />
            Overran {numbers.overran}
          </p>
          <Separator />
          <section className="flex flex-col gap-2" aria-label="Money">
            <h3 className="font-condensed text-xs font-semibold tracking-widest uppercase">
              Money
            </h3>
            {numbers.money.length ? (
              numbers.money.map((money) => (
                <div key={money.currency} className="grid grid-cols-2 gap-3">
                  <Figure
                    label={`cash · ${money.currency}`}
                    value={formatAmountMinor(money.cashMinor, money.currency)}
                  />
                  <Figure
                    label={`deposits · ${money.currency}`}
                    value={formatAmountMinor(
                      money.depositsMinor,
                      money.currency,
                    )}
                  />
                </div>
              ))
            ) : (
              <p className="text-[13px] text-muted-foreground">
                No payments recorded in this window.
              </p>
            )}
            <p className="text-[13px]">
              Won {numbers.deals.won} · Deposits {numbers.deals.deposits} · Lost{" "}
              {numbers.deals.lost} · Follow-up {numbers.deals.followUp}
            </p>
            {numbers.people.map((person, index) => (
              <p className="text-[13px]" key={index}>
                {person.name} · {person.kind.replaceAll("_", " ")}
                {person.amounts?.length
                  ? ` · ${person.amounts.map((amount) => `${formatAmountMinor(amount.amountMinor, amount.currency)}, ${amount.program}`).join("; ")}`
                  : person.program
                    ? ` · ${person.program}`
                    : ""}
              </p>
            ))}
          </section>
          <Separator />
          <section
            className="flex flex-col gap-2"
            aria-label="Open before you go"
          >
            <h3 className="font-condensed text-xs font-semibold tracking-widest uppercase">
              Open before you go
            </h3>
            {gaps.length ? (
              <ul className="flex flex-col gap-2 text-[13px]">
                {gaps.map((gap, index) => (
                  <li key={index}>
                    {gap.meetingId || gap.followUpId ? (
                      <Link
                        className="underline underline-offset-4"
                        href={
                          gap.meetingId
                            ? `/workspace/closer/meetings/${gap.meetingId}`
                            : `/workspace/closer/reminders/${gap.followUpId}`
                        }
                      >
                        {gap.label}
                      </Link>
                    ) : (
                      gap.label
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Nothing. Every call has a result.
              </p>
            )}
          </section>
          {!reportId && (
            <form id="end-day-form" onSubmit={form.handleSubmit(submit)}>
              <FieldGroup>
                <Controller
                  name="note"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="end-day-note">
                        Note for the team, optional
                      </FieldLabel>
                      <Textarea
                        {...field}
                        id="end-day-note"
                        maxLength={2000}
                        rows={3}
                        aria-invalid={fieldState.invalid}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </FieldGroup>
            </form>
          )}
        </div>
        <SheetFooter className="border-t px-5 py-4">
          {error && (
            <p role="alert" className="text-[13px] text-danger-ink">
              {error}
            </p>
          )}
          {reportId ? (
            <>
              <p role="status" className="text-[13px]">
                {latest ? (
                  <EndDayStatus report={latest} />
                ) : (
                  "Day ended · Saving report…"
                )}
              </p>
              {latest?.slackStatus === "failed" && (
                <Button
                  variant="secondary"
                  onClick={retryPost}
                  disabled={retrying}
                >
                  {retrying && <Spinner data-icon="inline-start" />}Retry Slack
                  post
                </Button>
              )}
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button
                type="submit"
                form="end-day-form"
                disabled={form.formState.isSubmitting}
              >
                {form.formState.isSubmitting && (
                  <Spinner data-icon="inline-start" />
                )}
                {summary.slackChannelId
                  ? `End day and post to #${summary.slackChannelName ?? summary.slackChannelId}`
                  : "End day"}
              </Button>
              {!summary.slackChannelId && (
                <p className="text-center text-[13px] text-muted-foreground">
                  No Slack channel is set
                </p>
              )}
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Figure({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <p className="font-condensed text-[30px] leading-tight font-semibold tabular-nums">
        {value}
      </p>
      <p className="text-[13px] text-muted-foreground">{label}</p>
    </div>
  );
}
function CallNumbers({
  title,
  calls,
}: {
  title: string;
  calls: Summary["numbers"]["newCalls"];
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="font-condensed text-xs font-semibold tracking-widest uppercase">
        {title}
      </h3>
      <div className="grid grid-cols-3 gap-3">
        <Figure value={calls.scheduled} label="scheduled" />
        <Figure value={calls.held} label={`held · ${calls.noShow} no-show`} />
        <Figure
          value={
            calls.showRate === null
              ? "—"
              : `${Math.round(calls.showRate * 100)}%`
          }
          label="show rate"
        />
      </div>
      <p className="text-[13px] text-muted-foreground">
        Canceled {calls.canceled} · Not recorded {calls.notRecorded}
      </p>
    </section>
  );
}
