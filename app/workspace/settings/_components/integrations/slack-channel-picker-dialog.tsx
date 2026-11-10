"use client";

import { useEffect, useMemo, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useAction, useMutation } from "convex/react";
import {
  ArchiveIcon,
  EyeOffIcon,
  HashIcon,
  LockIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";

const channelPickerSchema = z.object({
  notifyChannelId: z.string().min(1, "Pick a notification channel"),
  staleReminderChannelId: z.string().min(1, "Pick a reminder channel"),
  // Optional: empty turns lead gen notifications off.
  leadGenNotifyChannelId: z.string(),
  // Optional: empty turns booking review alerts off.
  bookingReviewChannelId: z.string(),
  // Optional: empty turns end-of-day report posts off.
  eodReportChannelId: z.string(),
});

type ChannelPickerValues = z.infer<typeof channelPickerSchema>;

const LABEL_CLASS = "items-baseline gap-2 text-[13px] font-medium";
const DESCRIPTION_CLASS = "text-[13px] leading-[1.45]";
const ERROR_CLASS = "text-[13px] text-danger-ink";

const REQUIRED_CHANNEL_FIELDS = [
  "notifyChannelId",
  "staleReminderChannelId",
] as const satisfies readonly (keyof ChannelPickerValues)[];

type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  isArchived: boolean;
  /** A saved channel missing from Magnus's channel list. */
  isUnavailable?: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialNotifyChannelId?: string;
  initialStaleChannelId?: string;
  initialLeadGenChannelId?: string;
  initialLeadGenChannelName?: string;
  initialBookingReviewChannelId?: string;
  initialBookingReviewChannelName?: string;
  initialEodReportChannelId?: string;
  initialEodReportChannelName?: string;
};

export function SlackChannelPickerDialog({
  open,
  onOpenChange,
  initialNotifyChannelId,
  initialStaleChannelId,
  initialLeadGenChannelId,
  initialLeadGenChannelName,
  initialBookingReviewChannelId,
  initialBookingReviewChannelName,
  initialEodReportChannelId,
  initialEodReportChannelName,
}: Props) {
  const listChannels = useAction(api.slack.channelsActions.listInstalledChannels);
  const saveChannels = useMutation(api.slack.channels.setSlackNotifyChannels);
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [unavailableLeadGenChannel, setUnavailableLeadGenChannel] =
    useState<SlackChannel | null>(null);
  const [unavailableBookingReviewChannel, setUnavailableBookingReviewChannel] =
    useState<SlackChannel | null>(null);
  const [unavailableEodReportChannel, setUnavailableEodReportChannel] =
    useState<SlackChannel | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(channelPickerSchema),
    defaultValues: {
      notifyChannelId: initialNotifyChannelId ?? "",
      staleReminderChannelId: initialStaleChannelId ?? "",
      leadGenNotifyChannelId: initialLeadGenChannelId ?? "",
      bookingReviewChannelId: initialBookingReviewChannelId ?? "",
      eodReportChannelId: initialEodReportChannelId ?? "",
    },
  });
  const notifyChannelId = useWatch({
    control: form.control,
    name: "notifyChannelId",
  });
  const staleReminderChannelId = useWatch({
    control: form.control,
    name: "staleReminderChannelId",
  });
  const leadGenNotifyChannelId = useWatch({
    control: form.control,
    name: "leadGenNotifyChannelId",
  });
  const bookingReviewChannelId = useWatch({
    control: form.control,
    name: "bookingReviewChannelId",
  });
  const eodReportChannelId = useWatch({
    control: form.control,
    name: "eodReportChannelId",
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      notifyChannelId: initialNotifyChannelId ?? "",
      staleReminderChannelId: initialStaleChannelId ?? "",
      leadGenNotifyChannelId: initialLeadGenChannelId ?? "",
      bookingReviewChannelId: initialBookingReviewChannelId ?? "",
      eodReportChannelId: initialEodReportChannelId ?? "",
    });
  }, [
    form,
    initialNotifyChannelId,
    initialStaleChannelId,
    initialLeadGenChannelId,
    initialBookingReviewChannelId,
    initialEodReportChannelId,
    open,
  ]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setChannels(null);
        setListError(null);
        setUnavailableLeadGenChannel(null);
        setUnavailableBookingReviewChannel(null);
        setUnavailableEodReportChannel(null);
        return listChannels({});
      })
      .then((rows) => {
        if (!rows || cancelled) return;
        // A saved channel can be missing from the list: deleted, a private
        // channel Magnus left, or past the listing's 2,000-channel limit.
        // Required channels must be picked again rather than let a hidden ID
        // fail the save.
        const visibleIds = new Set(rows.map((channel) => channel.id));
        for (const name of REQUIRED_CHANNEL_FIELDS) {
          const savedId = form.getValues(name);
          if (savedId && !visibleIds.has(savedId)) {
            form.setValue(name, "");
          }
        }
        // The optional channels stay selected and are saved unchanged, so a
        // short listing can't silently turn their posts off or move them.
        const savedLeadGenId = form.getValues("leadGenNotifyChannelId");
        if (savedLeadGenId && !visibleIds.has(savedLeadGenId)) {
          setUnavailableLeadGenChannel(
            unavailableChannel(savedLeadGenId, initialLeadGenChannelName),
          );
        }
        const savedBookingReviewId = form.getValues("bookingReviewChannelId");
        if (savedBookingReviewId && !visibleIds.has(savedBookingReviewId)) {
          setUnavailableBookingReviewChannel(
            unavailableChannel(savedBookingReviewId, initialBookingReviewChannelName),
          );
        }
        const savedEodReportId = form.getValues("eodReportChannelId");
        if (savedEodReportId && !visibleIds.has(savedEodReportId)) {
          setUnavailableEodReportChannel(
            unavailableChannel(savedEodReportId, initialEodReportChannelName),
          );
        }
        setChannels(rows);
      })
      .catch((error) => {
        if (!cancelled) {
          setListError(
            getErrorMessage(error, "Failed to list channels."),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    form,
    initialLeadGenChannelName,
    initialBookingReviewChannelName,
    initialEodReportChannelName,
    listChannels,
    open,
  ]);

  const selectedNotify = useMemo(
    () => channels?.find((channel) => channel.id === notifyChannelId),
    [channels, notifyChannelId],
  );
  const selectedStale = useMemo(
    () => channels?.find((channel) => channel.id === staleReminderChannelId),
    [channels, staleReminderChannelId],
  );
  const selectedLeadGen = useMemo(
    () => channels?.find((channel) => channel.id === leadGenNotifyChannelId),
    [channels, leadGenNotifyChannelId],
  );
  const leadGenChannels = useMemo(
    () =>
      channels && unavailableLeadGenChannel
        ? [unavailableLeadGenChannel, ...channels]
        : channels,
    [channels, unavailableLeadGenChannel],
  );
  const leadGenUnchangedAndUnavailable =
    unavailableLeadGenChannel !== null &&
    leadGenNotifyChannelId === unavailableLeadGenChannel.id;
  const selectedBookingReview = useMemo(
    () => channels?.find((channel) => channel.id === bookingReviewChannelId),
    [channels, bookingReviewChannelId],
  );
  const bookingReviewChannels = useMemo(
    () =>
      channels && unavailableBookingReviewChannel
        ? [unavailableBookingReviewChannel, ...channels]
        : channels,
    [channels, unavailableBookingReviewChannel],
  );
  const bookingReviewUnchangedAndUnavailable =
    unavailableBookingReviewChannel !== null &&
    bookingReviewChannelId === unavailableBookingReviewChannel.id;
  const selectedEodReport = useMemo(
    () => channels?.find((channel) => channel.id === eodReportChannelId),
    [channels, eodReportChannelId],
  );
  const eodReportChannels = useMemo(
    () =>
      channels && unavailableEodReportChannel
        ? [unavailableEodReportChannel, ...channels]
        : channels,
    [channels, unavailableEodReportChannel],
  );
  const eodReportUnchangedAndUnavailable =
    unavailableEodReportChannel !== null &&
    eodReportChannelId === unavailableEodReportChannel.id;
  const privateChannels = [
    selectedNotify,
    selectedStale,
    selectedLeadGen,
    selectedBookingReview,
    selectedEodReport,
  ].filter((channel): channel is SlackChannel => Boolean(channel?.isPrivate));

  async function onSubmit(values: ChannelPickerValues) {
    const notify = channels?.find(
      (channel) => channel.id === values.notifyChannelId,
    );
    const stale = channels?.find(
      (channel) => channel.id === values.staleReminderChannelId,
    );
    const keepUnavailableLeadGen =
      unavailableLeadGenChannel !== null &&
      values.leadGenNotifyChannelId === unavailableLeadGenChannel.id;
    const leadGen =
      values.leadGenNotifyChannelId && !keepUnavailableLeadGen
        ? channels?.find((channel) => channel.id === values.leadGenNotifyChannelId)
        : null;
    const keepUnavailableBookingReview =
      unavailableBookingReviewChannel !== null &&
      values.bookingReviewChannelId === unavailableBookingReviewChannel.id;
    const bookingReview =
      values.bookingReviewChannelId && !keepUnavailableBookingReview
        ? channels?.find((channel) => channel.id === values.bookingReviewChannelId)
        : null;
    const keepUnavailableEodReport =
      unavailableEodReportChannel !== null &&
      values.eodReportChannelId === unavailableEodReportChannel.id;
    const eodReport =
      values.eodReportChannelId && !keepUnavailableEodReport
        ? channels?.find((channel) => channel.id === values.eodReportChannelId)
        : null;
    if (
      !notify ||
      !stale ||
      leadGen === undefined ||
      bookingReview === undefined ||
      eodReport === undefined
    ) {
      toast.error("Pick valid Slack channels.");
      return;
    }
    if (
      notify.isArchived ||
      stale.isArchived ||
      leadGen?.isArchived ||
      bookingReview?.isArchived ||
      eodReport?.isArchived
    ) {
      toast.error("Archived channels cannot receive Slack messages.");
      return;
    }

    try {
      await saveChannels({
        notifyChannelId: notify.id,
        notifyChannelName: notify.name,
        staleReminderChannelId: stale.id,
        staleReminderChannelName: stale.name,
        // Omitted leaves the saved lead gen channel, and any error, as is.
        leadGenNotifyChannel: keepUnavailableLeadGen
          ? undefined
          : leadGen
            ? { channelId: leadGen.id, channelName: leadGen.name }
            : null,
        // Omitted leaves the saved booking review channel as is; null turns
        // booking review alerts off.
        bookingReviewChannel: keepUnavailableBookingReview
          ? undefined
          : bookingReview
            ? { channelId: bookingReview.id, channelName: bookingReview.name }
            : null,
        // Omitted leaves the saved end-of-day channel as is; null turns
        // end-of-day report posts off.
        eodReportChannel: keepUnavailableEodReport
          ? undefined
          : eodReport
            ? { channelId: eodReport.id, channelName: eodReport.name }
            : null,
      });
      toast.success("Slack channels saved.");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Failed to save channels."),
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pick Slack channels</DialogTitle>
          <DialogDescription className="text-[13px]">
            New-lead confirmations and stale-lead digests post to these
            channels. Lead gen submissions post only if you pick a channel
            for them, and so do booking reviews and end-of-day reports.
          </DialogDescription>
        </DialogHeader>

        {listError && (
          <div role="alert" className="flex items-start gap-2 text-[13px] text-danger-ink">
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              Couldn&apos;t list channels. {listError} Reconnect Slack if the
              app is missing channel-read scopes.
            </p>
          </div>
        )}

        {!channels && !listError && (
          <div
            className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground"
            role="status"
          >
            <Spinner />
            Loading channels…
          </div>
        )}

        {channels && (
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup className="gap-4">
              <Controller
                control={form.control}
                name="notifyChannelId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5">
                    <FieldLabel htmlFor="slack-notify-channel" className={LABEL_CLASS}>
                      Notify channel
                    </FieldLabel>
                    <ChannelCombobox
                      id="slack-notify-channel"
                      channels={channels}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="Search channels…"
                      invalid={fieldState.invalid}
                    />
                    <FieldDescription className={DESCRIPTION_CLASS}>
                      New-lead confirmations from <span translate="no">/qualify-lead</span>.
                    </FieldDescription>
                    <FieldError className={ERROR_CLASS} errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="staleReminderChannelId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5">
                    <FieldLabel htmlFor="slack-stale-channel" className={LABEL_CLASS}>
                      Stale-lead reminder channel
                    </FieldLabel>
                    <ChannelCombobox
                      id="slack-stale-channel"
                      channels={channels}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="Search channels…"
                      invalid={fieldState.invalid}
                    />
                    <FieldDescription className={DESCRIPTION_CLASS}>
                      The daily stale-lead digest.
                    </FieldDescription>
                    <FieldError className={ERROR_CLASS} errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="leadGenNotifyChannelId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5">
                    <FieldLabel htmlFor="slack-lead-gen-channel" className={LABEL_CLASS}>
                      Lead gen channel
                      <span className="text-muted-foreground/80">Optional</span>
                    </FieldLabel>
                    <ChannelCombobox
                      id="slack-lead-gen-channel"
                      channels={leadGenChannels ?? channels}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="Off - search channels…"
                    />
                    <FieldDescription className={DESCRIPTION_CLASS}>
                      {leadGenUnchangedAndUnavailable
                        ? "Magnus can't find this channel in Slack's channel list. Saving keeps it; pick another channel or clear it to turn these posts off."
                        : "Posts each lead gen submission. Clear it to turn these posts off."}
                    </FieldDescription>
                    <FieldError className={ERROR_CLASS} errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="bookingReviewChannelId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5">
                    <FieldLabel htmlFor="slack-booking-review-channel" className={LABEL_CLASS}>
                      Booking review channel
                      <span className="text-muted-foreground/80">Optional</span>
                    </FieldLabel>
                    <ChannelCombobox
                      id="slack-booking-review-channel"
                      channels={bookingReviewChannels ?? channels}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="Off - search channels…"
                    />
                    <FieldDescription className={DESCRIPTION_CLASS}>
                      {bookingReviewUnchangedAndUnavailable
                        ? "Magnus can't find this channel in Slack's channel list. Saving keeps it; pick another channel or clear it to turn these posts off."
                        : "Posts a booking whose details match two people, with a link to decide. When you pick a channel, reviews still waiting are posted there. Clear it to turn these posts off."}
                    </FieldDescription>
                    <FieldError className={ERROR_CLASS} errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="eodReportChannelId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5">
                    <FieldLabel htmlFor="slack-eod-report-channel" className={LABEL_CLASS}>
                      End-of-day report channel
                      <span className="text-muted-foreground/80">Optional</span>
                    </FieldLabel>
                    <ChannelCombobox
                      id="slack-eod-report-channel"
                      channels={eodReportChannels ?? channels}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="Off - search channels…"
                    />
                    <FieldDescription className={DESCRIPTION_CLASS}>
                      {eodReportUnchangedAndUnavailable
                        ? "Magnus can't find this channel in Slack's channel list. Saving keeps it; pick another channel or clear it to turn these posts off."
                        : "Each closer's report posts here when they end their day. No fallback channel. Clear it to turn these posts off."}
                    </FieldDescription>
                    <FieldError className={ERROR_CLASS} errors={[fieldState.error]} />
                  </Field>
                )}
              />

              {privateChannels.length > 0 && (
                <div role="status" className="flex items-start gap-2 text-[13px] text-warning-ink">
                  <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <p>{formatPrivateChannelCopy(privateChannels)}</p>
                </div>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={form.formState.isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" className="font-semibold" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting && (
                    <Spinner data-icon="inline-start" />
                  )}
                  Save channels
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChannelCombobox({
  id,
  channels,
  value,
  onValueChange,
  placeholder,
  invalid,
}: {
  id: string;
  channels: SlackChannel[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  invalid?: boolean;
}) {
  const selected = channels.find((channel) => channel.id === value) ?? null;

  return (
    <Combobox
      items={channels}
      value={selected}
      onValueChange={(channel: SlackChannel | null) =>
        onValueChange(channel?.id ?? "")
      }
      itemToStringLabel={(channel: SlackChannel) => channel.name}
      itemToStringValue={(channel: SlackChannel) => channel.name}
      autoHighlight
    >
      <ComboboxInput id={id} placeholder={placeholder} showClear aria-invalid={invalid || undefined} />
      <ComboboxContent>
        <ComboboxEmpty>No channels found.</ComboboxEmpty>
        <ComboboxList>
          {(channel: SlackChannel) => (
            <ComboboxItem
              key={channel.id}
              value={channel}
              disabled={channel.isArchived}
            >
              {channel.isUnavailable ? (
                <EyeOffIcon aria-hidden="true" />
              ) : channel.isArchived ? (
                <ArchiveIcon aria-hidden="true" />
              ) : channel.isPrivate ? (
                <LockIcon aria-hidden="true" />
              ) : (
                <HashIcon aria-hidden="true" />
              )}
              <span className="min-w-0 truncate">{channel.name}</span>
              {(channel.isArchived || channel.isUnavailable) && (
                <span className="ml-auto font-condensed text-[11px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  {channel.isUnavailable ? "Not found" : "Archived"}
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function unavailableChannel(id: string, name: string | undefined): SlackChannel {
  return {
    id,
    name: name ?? id,
    isPrivate: false,
    isMember: false,
    isArchived: false,
    isUnavailable: true,
  };
}

function formatPrivateChannelCopy(channels: SlackChannel[]) {
  const uniqueNames = Array.from(new Set(channels.map((channel) => channel.name)));
  if (uniqueNames.length === 1) {
    return `#${uniqueNames[0]} is private - run /invite @Magnus in that channel after saving.`;
  }
  return `These channels are private: ${uniqueNames
    .map((name) => `#${name}`)
    .join(", ")}. Run /invite @Magnus in each channel after saving.`;
}
