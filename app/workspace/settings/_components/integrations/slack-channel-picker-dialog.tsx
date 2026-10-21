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
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { FieldGroup } from "@/components/ui/field";
import {
  Form,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";

const channelPickerSchema = z.object({
  notifyChannelId: z.string().min(1, "Pick a notification channel"),
  staleReminderChannelId: z.string().min(1, "Pick a reminder channel"),
  // Optional: empty turns lead gen notifications off.
  leadGenNotifyChannelId: z.string(),
  // Optional: empty turns booking review alerts off.
  bookingReviewChannelId: z.string(),
});

type ChannelPickerValues = z.infer<typeof channelPickerSchema>;

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
}: Props) {
  const listChannels = useAction(api.slack.channelsActions.listInstalledChannels);
  const saveChannels = useMutation(api.slack.channels.setSlackNotifyChannels);
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [unavailableLeadGenChannel, setUnavailableLeadGenChannel] =
    useState<SlackChannel | null>(null);
  const [unavailableBookingReviewChannel, setUnavailableBookingReviewChannel] =
    useState<SlackChannel | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(channelPickerSchema),
    defaultValues: {
      notifyChannelId: initialNotifyChannelId ?? "",
      staleReminderChannelId: initialStaleChannelId ?? "",
      leadGenNotifyChannelId: initialLeadGenChannelId ?? "",
      bookingReviewChannelId: initialBookingReviewChannelId ?? "",
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

  useEffect(() => {
    if (!open) return;
    form.reset({
      notifyChannelId: initialNotifyChannelId ?? "",
      staleReminderChannelId: initialStaleChannelId ?? "",
      leadGenNotifyChannelId: initialLeadGenChannelId ?? "",
      bookingReviewChannelId: initialBookingReviewChannelId ?? "",
    });
  }, [
    form,
    initialNotifyChannelId,
    initialStaleChannelId,
    initialLeadGenChannelId,
    initialBookingReviewChannelId,
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
  const privateChannels = [
    selectedNotify,
    selectedStale,
    selectedLeadGen,
    selectedBookingReview,
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
    if (!notify || !stale || leadGen === undefined || bookingReview === undefined) {
      toast.error("Pick valid Slack channels.");
      return;
    }
    if (
      notify.isArchived ||
      stale.isArchived ||
      leadGen?.isArchived ||
      bookingReview?.isArchived
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
          <DialogTitle>Pick Slack Channels</DialogTitle>
          <DialogDescription>
            New-lead confirmations and stale-lead digests post to these
            channels. Lead gen submissions post only if you pick a channel
            for them, and so do booking reviews.
          </DialogDescription>
        </DialogHeader>

        {listError && (
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>Couldn&apos;t List Channels</AlertTitle>
            <AlertDescription>
              {listError} Reconnect Slack if the app is missing channel-read
              scopes.
            </AlertDescription>
          </Alert>
        )}

        {!channels && !listError && (
          <div
            className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
            role="status"
          >
            <Spinner />
            Loading channels…
          </div>
        )}

        {channels && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <FieldGroup>
                <FormField
                  control={form.control}
                  name="notifyChannelId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notify Channel</FormLabel>
                      <ChannelCombobox
                        channels={channels}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="Search channels…"
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="staleReminderChannelId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Stale-Lead Reminder Channel</FormLabel>
                      <ChannelCombobox
                        channels={channels}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="Search channels…"
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="leadGenNotifyChannelId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Lead Gen Channel (Optional)</FormLabel>
                      <ChannelCombobox
                        channels={leadGenChannels ?? channels}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="Off - search channels…"
                      />
                      <FormDescription>
                        {leadGenUnchangedAndUnavailable
                          ? "Magnus can't find this channel in Slack's channel list. Saving keeps it; pick another channel or clear it to turn these posts off."
                          : "Posts each lead gen submission. Clear it to turn these posts off."}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="bookingReviewChannelId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Booking Review Channel (Optional)</FormLabel>
                      <ChannelCombobox
                        channels={bookingReviewChannels ?? channels}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="Off - search channels…"
                      />
                      <FormDescription>
                        {bookingReviewUnchangedAndUnavailable
                          ? "Magnus can't find this channel in Slack's channel list. Saving keeps it; pick another channel or clear it to turn these posts off."
                          : "Posts a booking whose details match two people, with a link to decide. When you pick a channel, reviews still waiting are posted there. Clear it to turn these posts off."}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {privateChannels.length > 0 && (
                  <Alert>
                    <LockIcon aria-hidden="true" />
                    <AlertTitle>Private Channel Selected</AlertTitle>
                    <AlertDescription>
                      {formatPrivateChannelCopy(privateChannels)}
                    </AlertDescription>
                  </Alert>
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
                  <Button type="submit" disabled={form.formState.isSubmitting}>
                    {form.formState.isSubmitting && (
                      <Spinner data-icon="inline-start" />
                    )}
                    Save Channels
                  </Button>
                </DialogFooter>
              </FieldGroup>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChannelCombobox({
  channels,
  value,
  onValueChange,
  placeholder,
}: {
  channels: SlackChannel[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
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
      <ComboboxInput placeholder={placeholder} showClear />
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
                <span className="ml-auto text-xs text-muted-foreground">
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
