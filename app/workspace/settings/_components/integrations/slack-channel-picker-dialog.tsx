"use client";

import { useEffect, useMemo, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useAction, useMutation } from "convex/react";
import {
  ArchiveIcon,
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";

const channelPickerSchema = z.object({
  notifyChannelId: z.string().min(1, "Pick a notification channel"),
  staleReminderChannelId: z.string().min(1, "Pick a reminder channel"),
});

type ChannelPickerValues = z.infer<typeof channelPickerSchema>;

type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  isArchived: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialNotifyChannelId?: string;
  initialStaleChannelId?: string;
};

export function SlackChannelPickerDialog({
  open,
  onOpenChange,
  initialNotifyChannelId,
  initialStaleChannelId,
}: Props) {
  const listChannels = useAction(api.slack.channelsActions.listInstalledChannels);
  const saveChannels = useMutation(api.slack.channels.setSlackNotifyChannels);
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(channelPickerSchema),
    defaultValues: {
      notifyChannelId: initialNotifyChannelId ?? "",
      staleReminderChannelId: initialStaleChannelId ?? "",
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

  useEffect(() => {
    if (!open) return;
    form.reset({
      notifyChannelId: initialNotifyChannelId ?? "",
      staleReminderChannelId: initialStaleChannelId ?? "",
    });
  }, [form, initialNotifyChannelId, initialStaleChannelId, open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setChannels(null);
        setListError(null);
        return listChannels({});
      })
      .then((rows) => {
        if (!rows) return;
        if (!cancelled) setChannels(rows);
      })
      .catch((error) => {
        if (!cancelled) {
          setListError(
            error instanceof Error ? error.message : "Failed to list channels.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [listChannels, open]);

  const selectedNotify = useMemo(
    () => channels?.find((channel) => channel.id === notifyChannelId),
    [channels, notifyChannelId],
  );
  const selectedStale = useMemo(
    () => channels?.find((channel) => channel.id === staleReminderChannelId),
    [channels, staleReminderChannelId],
  );
  const privateChannels = [selectedNotify, selectedStale].filter(
    (channel): channel is SlackChannel => Boolean(channel?.isPrivate),
  );

  async function onSubmit(values: ChannelPickerValues) {
    const notify = channels?.find(
      (channel) => channel.id === values.notifyChannelId,
    );
    const stale = channels?.find(
      (channel) => channel.id === values.staleReminderChannelId,
    );
    if (!notify || !stale) {
      toast.error("Pick valid Slack channels.");
      return;
    }
    if (notify.isArchived || stale.isArchived) {
      toast.error("Archived channels cannot receive Slack messages.");
      return;
    }

    try {
      await saveChannels({
        notifyChannelId: notify.id,
        notifyChannelName: notify.name,
        staleReminderChannelId: stale.id,
        staleReminderChannelName: stale.name,
      });
      toast.success("Slack channels saved.");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save channels.",
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
            channels.
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
              {channel.isArchived ? (
                <ArchiveIcon aria-hidden="true" />
              ) : channel.isPrivate ? (
                <LockIcon aria-hidden="true" />
              ) : (
                <HashIcon aria-hidden="true" />
              )}
              <span className="min-w-0 truncate">{channel.name}</span>
              {channel.isArchived && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Archived
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
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
