"use client";

import { useState } from "react";
import { type Preloaded, useAction, usePreloadedQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CARD, CardHead, HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { ActionRow, FACT_FIGURE, Fact, Facts, NoteLine, StatusWord } from "../settings-ui";
import { SlackChannelPickerDialog } from "./slack-channel-picker-dialog";
import { slackChannelErrors, slackMissingChannel, slackState, type SlackConnected } from "./integration-status";

type Props = {
  preloadedStatus: Preloaded<typeof api.slack.channels.getInstallationStatus>;
  /** Calendly isn't connected yet: its button is the page's lime action, so Slack's is outline. */
  calendlyFirst?: boolean;
};

type ChannelKind = "notify" | "stale" | "lead_gen" | "booking_review" | "eod_report";
type ChannelError = SlackConnected["notifyChannelError"];

/**
 * Slack: the workspace it's connected to, then the five channels Magnus
 * posts to as ruled rows with the picker in their heading row. Lime only on
 * Connect or Reconnect while Slack can't post.
 */
export function SlackIntegrationCard({ preloadedStatus, calendlyFirst = false }: Props) {
  const status = usePreloadedQuery(preloadedStatus);
  const searchParams = useSearchParams();
  const { role } = useRole();
  // Returning from the Slack OAuth flow with `pickChannel=true` opens the
  // channel picker.
  const shouldAutoOpenPicker =
    status.kind === "connected" &&
    searchParams.get("slack") === "connected" &&
    searchParams.get("pickChannel") === "true";
  const [pickerOpen, setPickerOpen] = useState(false);
  const [autoOpenedPicker, setAutoOpenedPicker] = useState(false);
  if (shouldAutoOpenPicker !== autoOpenedPicker) {
    setAutoOpenedPicker(shouldAutoOpenPicker);
    if (shouldAutoOpenPicker) setPickerOpen(true);
  }
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectSlack = useAction(api.slack.channelsActions.disconnectSlack);
  const state = slackState(status);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const result = await disconnectSlack({});
      if (result.revokedInSlack) {
        toast.success("Slack disconnected and access revoked.");
      } else {
        toast.warning(
          "Slack disconnected. Slack did not confirm the token revocation — remove the Magnus app from your Slack workspace to fully revoke access.",
        );
      }
      setDisconnectOpen(false);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to disconnect Slack."));
    } finally {
      setDisconnecting(false);
    }
  }

  if (status.kind === "not_connected") {
    const slackParam = searchParams.get("slack");
    return (
      <section aria-label="Slack" className={CARD}>
        <CardHead title="Slack">
          <StatusWord tone={state.tone}>{state.word}</StatusWord>
        </CardHead>
        <div className="flex flex-col gap-2 px-4 py-3">
          <NoteLine>
            Connect Slack so workspace members can qualify leads with{" "}
            <code translate="no" className="font-mono text-[12.5px] text-foreground">
              /qualify-lead
            </code>
            , and Magnus can post new leads, stale-lead digests and booking reviews.
          </NoteLine>
          {slackParam === "denied" ? (
            <NoteLine tone="warning" role="status">
              Slack needs approval. If your workspace requires owner approval, approve the app in Slack and start the
              connection again.
            </NoteLine>
          ) : null}
          {slackParam === "start_failed" ? (
            <NoteLine tone="danger" role="alert">
              The Slack connection failed. Try again. If it fails again, confirm the Slack environment variables are
              set in Convex.
            </NoteLine>
          ) : null}
        </div>
        <ActionRow>
          <Button asChild size="sm" variant={calendlyFirst ? "outline" : "default"} className="font-semibold">
            <a href="/api/slack/start">Connect Slack</a>
          </Button>
        </ActionRow>
      </section>
    );
  }

  const isTenantMaster = role === "tenant_master";
  const active = status.status === "active";
  const canDisconnect = isTenantMaster && status.status !== "uninstalled";
  // The old "Action Required": a channel to pick, or one Slack refused.
  const needsChannels = slackMissingChannel(status) || slackChannelErrors(status).length > 0;

  return (
    <>
      <section aria-label="Slack" className={CARD}>
        <CardHead title="Slack">
          <StatusWord tone={state.tone}>{state.word}</StatusWord>
        </CardHead>

        <Facts>
          <Fact label="Workspace" title={status.teamName}>
            <span translate="no" className="block truncate font-medium">
              {status.teamName}
            </span>
          </Fact>
          <Fact label="Connected">
            <span className={FACT_FIGURE}>{formatDay(status.installedAt)}</span>
          </Fact>
        </Facts>

        <LifecycleLine status={status.status} />

        <div className="flex min-h-9 items-center gap-2 border-b border-border px-4 py-1">
          <span className={LABEL}>
            <HelpTip tip="Where Magnus posts in Slack. Private channels need /invite @Magnus after they're picked.">
              Channels
            </HelpTip>
          </span>
          {active ? (
            <Button variant="outline" size="xs" className="ml-auto" onClick={() => setPickerOpen(true)}>
              {needsChannels ? "Pick channels" : "Change channels"}
            </Button>
          ) : null}
        </div>
        <ul className="py-1">
          <ChannelRow
            purpose="Qualified leads"
            tip="Confirms each lead qualified with /qualify-lead."
            name={status.notifyChannelName}
            required
            active={active}
            error={status.notifyChannelError}
            kind="notify"
            missingCopy="Pick a channel. Qualifications still save, but nothing is posted."
          />
          <ChannelRow
            purpose="Stale leads"
            tip="The daily digest of leads nobody has touched."
            name={status.staleReminderChannelName}
            required
            active={active}
            error={status.staleReminderChannelError}
            kind="stale"
            missingCopy="Pick a channel, or the digest isn't sent."
          />
          <ChannelRow
            purpose="Lead gen"
            tip="One post for each lead gen submission. Optional."
            name={status.leadGenNotifyChannelName}
            active={active}
            error={status.leadGenNotifyChannelError}
            kind="lead_gen"
          />
          <ChannelRow
            purpose="Booking reviews"
            tip="Bookings whose details match more than one person. Optional."
            name={status.bookingReviewChannelName}
            active={active}
            error={status.bookingReviewChannelError}
            kind="booking_review"
          />
          <ChannelRow
            purpose="End-of-day"
            tip="Each closer's end-of-day report. Optional; no fallback channel."
            name={status.eodReportChannelName}
            active={active}
            error={status.eodReportChannelError}
            kind="eod_report"
          />
        </ul>

        {!active || canDisconnect ? (
          <ActionRow>
            {!active ? (
              <Button asChild size="sm" variant={calendlyFirst ? "outline" : "default"} className="font-semibold">
                <a href="/api/slack/start">Reconnect Slack</a>
              </Button>
            ) : null}
            {canDisconnect ? (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-danger-ink hover:text-danger-ink"
                onClick={() => setDisconnectOpen(true)}
              >
                Disconnect
              </Button>
            ) : null}
          </ActionRow>
        ) : null}
      </section>

      <SlackChannelPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialNotifyChannelId={status.notifyChannelId}
        initialStaleChannelId={status.staleReminderChannelId}
        initialLeadGenChannelId={status.leadGenNotifyChannelId}
        initialLeadGenChannelName={status.leadGenNotifyChannelName}
        initialBookingReviewChannelId={status.bookingReviewChannelId}
        initialBookingReviewChannelName={status.bookingReviewChannelName}
        initialEodReportChannelId={status.eodReportChannelId}
        initialEodReportChannelName={status.eodReportChannelName}
      />

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Slack?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes the bot token and stops channel notifications, stale-lead digests, and{" "}
              <span translate="no">/qualify-lead</span>. Existing Slack-qualified opportunities stay in the CRM.
              Reconnecting requires running the Slack connection again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={disconnecting}
              onClick={(event) => {
                event.preventDefault();
                void handleDisconnect();
              }}
            >
              {disconnecting && <Spinner data-icon="inline-start" />}
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Why Slack can't post, when the install isn't active. */
function LifecycleLine({ status }: { status: SlackConnected["status"] }) {
  if (status === "active") return null;
  return (
    <div className="border-b border-border px-4 py-2.5">
      {status === "uninstalled" ? (
        <NoteLine tone="warning" role="status">
          The Slack app was uninstalled. Reconnect Slack to restore <span translate="no">/qualify-lead</span>.
        </NoteLine>
      ) : (
        <NoteLine tone="danger" role="alert">
          {status === "token_expired" ? "The Slack token expired." : "The Slack tokens were revoked."} Reconnect Slack
          to restore channel posting and slash command handling.
        </NoteLine>
      )}
    </div>
  );
}

/** One channel Magnus posts to, on one fact line: what goes there, then the channel. */
function ChannelRow({
  purpose,
  tip,
  name,
  required = false,
  active,
  error,
  kind,
  missingCopy,
}: {
  purpose: string;
  tip: string;
  name: string | undefined;
  required?: boolean;
  active: boolean;
  error: ChannelError;
  kind: ChannelKind;
  missingCopy?: string;
}) {
  const problem = channelProblem(error, kind);
  const missing = active && required && !name;
  return (
    <li className="grid min-h-8 grid-cols-[6.875rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <span className="text-[13px] text-muted-foreground">
        <HelpTip tip={tip}>{purpose}</HelpTip>
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-sm",
          name ? "font-medium" : required ? "font-medium text-warning-ink" : "text-muted-foreground",
        )}
        title={name ? `#${name}` : undefined}
        translate={name ? "no" : undefined}
      >
        {name ? `#${name}` : required ? "No channel" : "Off"}
      </span>
      {missing && missingCopy ? (
        <NoteLine tone="warning" className="col-start-2">
          {missingCopy}
        </NoteLine>
      ) : null}
      {problem ? (
        <NoteLine tone={problem.tone} role={problem.tone === "danger" ? "alert" : "status"} className="col-start-2">
          {problem.text}
        </NoteLine>
      ) : null}
    </li>
  );
}

/** What went wrong posting to a channel; the row already names the channel. */
function channelProblem(error: ChannelError, kind: ChannelKind) {
  if (!error) return null;
  if (error.code === "not_in_channel") {
    return { tone: "warning" as const, text: "Magnus isn't in this channel. Run /invite @Magnus in it." };
  }
  if (error.code === "is_archived") {
    return { tone: "danger" as const, text: `Archived in Slack. ${repickChannelCopy(kind)}` };
  }
  if (error.code === "channel_not_found") {
    return { tone: "danger" as const, text: `Slack can't find this channel. ${repickChannelCopy(kind)}` };
  }
  return { tone: "danger" as const, text: `Slack returned ${error.code}. Recheck the configured channel.` };
}

function repickChannelCopy(kind: ChannelKind) {
  switch (kind) {
    case "notify":
      return "Pick a new notification channel before the next lead is qualified.";
    case "stale":
      return "Pick a new reminder channel before the next stale-lead digest.";
    case "lead_gen":
      return "Lead gen posts are off. Pick a new lead gen channel to turn them back on.";
    case "booking_review":
      return "Booking review posts are off. Pick a new channel to turn them back on; reviews still open are posted then.";
    case "eod_report":
      return "Pick a new end-of-day channel, then retry the saved reports.";
  }
}

/** "Oct 12", or "Oct 12, 2025" outside this year. */
function formatDay(value: number) {
  const sameYear = new Date(value).getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(value);
}
