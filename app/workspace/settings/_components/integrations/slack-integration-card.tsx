"use client";

import { useEffect, useMemo, useState } from "react";
import { type Preloaded, useMutation, usePreloadedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  CheckCircle2Icon,
  MessageSquareTextIcon,
  PlugZapIcon,
  RefreshCwIcon,
  Settings2Icon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { SlackChannelPickerDialog } from "./slack-channel-picker-dialog";

type InstallationStatus = FunctionReturnType<
  typeof api.slack.channels.getInstallationStatus
>;
type ConnectedStatus = Extract<InstallationStatus, { kind: "connected" }>;

type Props = {
  preloadedStatus: Preloaded<typeof api.slack.channels.getInstallationStatus>;
};

export function SlackIntegrationCard({ preloadedStatus }: Props) {
  const status = usePreloadedQuery(preloadedStatus);
  const searchParams = useSearchParams();
  const { role } = useRole();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectSlack = useMutation(api.slack.channels.disconnectSlack);

  useEffect(() => {
    if (
      status.kind === "connected" &&
      searchParams.get("slack") === "connected" &&
      searchParams.get("pickChannel") === "true"
    ) {
      setPickerOpen(true);
    }
  }, [searchParams, status.kind]);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectSlack({});
      toast.success("Slack disconnected.");
      setDisconnectOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to disconnect Slack.",
      );
    } finally {
      setDisconnecting(false);
    }
  }

  if (status.kind === "not_connected") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquareTextIcon aria-hidden="true" />
            Slack
          </CardTitle>
          <CardDescription>
            Connect Slack so workspace members can qualify leads with
            <span translate="no"> /qualify-lead</span>.
          </CardDescription>
          <CardAction>
            <Badge variant="secondary">Disconnected</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {searchParams.get("slack") === "denied" && (
            <Alert>
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle>Slack Approval Required</AlertTitle>
              <AlertDescription>
                If your workspace requires owner approval, approve the app in
                Slack and start the connection again.
              </AlertDescription>
            </Alert>
          )}
          {searchParams.get("slack") === "start_failed" && (
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle>Slack Connection Failed</AlertTitle>
              <AlertDescription>
                Try again. If it fails again, confirm the Slack environment
                variables are set in Convex.
              </AlertDescription>
            </Alert>
          )}
          <div>
            <Button asChild>
              <a href="/api/slack/start">
                <PlugZapIcon data-icon="inline-start" />
                Connect Slack
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isTenantMaster = role === "tenant_master";
  const actionRequired =
    status.status === "active" &&
    (!status.notifyChannelId ||
      !status.staleReminderChannelId ||
      Boolean(status.notifyChannelError) ||
      Boolean(status.staleReminderChannelError));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex min-w-0 items-center gap-2">
            <MessageSquareTextIcon aria-hidden="true" />
            <span className="truncate">Slack</span>
          </CardTitle>
          <CardDescription>
            Connected to{" "}
            <strong className="font-medium text-foreground">
              {status.teamName}
            </strong>{" "}
            on {formatDate(status.installedAt)}.
          </CardDescription>
          <CardAction>
            <StatusBadge status={status} actionRequired={actionRequired} />
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {status.status === "active" && !status.notifyChannelId && (
            <Alert>
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle>Pick a Notification Channel</AlertTitle>
              <AlertDescription>
                Slack qualifications are saved in the CRM, but channel messages
                need a configured destination.
              </AlertDescription>
            </Alert>
          )}

          {status.status === "active" && !status.staleReminderChannelId && (
            <Alert>
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle>Pick a Reminder Channel</AlertTitle>
              <AlertDescription>
                Daily stale-lead digests need a configured Slack channel.
              </AlertDescription>
            </Alert>
          )}

          <ChannelErrorAlert error={status.notifyChannelError} kind="notify" />
          <ChannelErrorAlert
            error={status.staleReminderChannelError}
            kind="stale"
          />
          <LifecycleAlert status={status.status} />
          <ChannelSummary status={status} />
        </CardContent>

        <CardFooter className="flex flex-wrap gap-2">
          {status.status === "active" && (
            <Button variant="secondary" onClick={() => setPickerOpen(true)}>
              <Settings2Icon data-icon="inline-start" />
              {actionRequired ? "Pick Channels" : "Change Channels"}
            </Button>
          )}
          {status.status !== "active" && (
            <Button asChild>
              <a href="/api/slack/start">
                <RefreshCwIcon data-icon="inline-start" />
                Reconnect
              </a>
            </Button>
          )}
          {isTenantMaster && status.status !== "uninstalled" && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDisconnectOpen(true)}
            >
              <UnplugIcon data-icon="inline-start" />
              Disconnect
            </Button>
          )}
        </CardFooter>
      </Card>

      <SlackChannelPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialNotifyChannelId={status.notifyChannelId}
        initialStaleChannelId={status.staleReminderChannelId}
      />

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Slack?</AlertDialogTitle>
            <AlertDialogDescription>
              Future Slack qualifications will ask users to contact an admin.
              Existing Slack-qualified opportunities stay in the CRM.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>
              Cancel
            </AlertDialogCancel>
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

function StatusBadge({
  status,
  actionRequired,
}: {
  status: ConnectedStatus;
  actionRequired: boolean;
}) {
  if (actionRequired) {
    return (
      <Badge variant="destructive">
        <TriangleAlertIcon data-icon="inline-start" />
        Action Required
      </Badge>
    );
  }

  switch (status.status) {
    case "active":
      return (
        <Badge>
          <CheckCircle2Icon data-icon="inline-start" />
          Connected
        </Badge>
      );
    case "token_expired":
      return <Badge variant="destructive">Token Expired</Badge>;
    case "revoked":
      return <Badge variant="destructive">Tokens Revoked</Badge>;
    case "uninstalled":
      return <Badge variant="secondary">Uninstalled</Badge>;
  }
}

function LifecycleAlert({
  status,
}: {
  status: ConnectedStatus["status"];
}) {
  if (status === "active") return null;

  if (status === "uninstalled") {
    return (
      <Alert>
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>Slack App Uninstalled</AlertTitle>
        <AlertDescription>
          Reconnect Slack to restore <span translate="no">/qualify-lead</span>.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>
        {status === "token_expired"
          ? "Slack Token Expired"
          : "Slack Tokens Revoked"}
      </AlertTitle>
      <AlertDescription>
        Reconnect Slack to restore channel posting and slash command handling.
      </AlertDescription>
    </Alert>
  );
}

function ChannelErrorAlert({
  error,
  kind,
}: {
  error: ConnectedStatus["notifyChannelError"];
  kind: "notify" | "stale";
}) {
  const content = useMemo(() => {
    if (!error) return null;
    const channelName = error.channelName ? `#${error.channelName}` : "the channel";
    if (error.code === "not_in_channel") {
      return {
        title: "Invite Magnus to the Channel",
        description: `Bot not in ${channelName} - run /invite @Magnus in that channel.`,
      };
    }
    if (error.code === "is_archived") {
      return {
        title: "Channel Archived",
        description:
          kind === "notify"
            ? "Pick a new notification channel before the next lead is qualified."
            : "Pick a new reminder channel before the next stale-lead digest.",
      };
    }
    if (error.code === "channel_not_found") {
      return {
        title: "Channel Not Found",
        description:
          kind === "notify"
            ? "Pick a new notification channel before the next lead is qualified."
            : "Pick a new reminder channel before the next stale-lead digest.",
      };
    }
    return {
      title: "Slack Posting Failed",
      description: `Slack returned ${error.code}. Recheck the configured channel.`,
    };
  }, [error, kind]);

  if (!content) return null;

  return (
    <Alert variant={error?.code === "not_in_channel" ? "default" : "destructive"}>
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{content.title}</AlertTitle>
      <AlertDescription>{content.description}</AlertDescription>
    </Alert>
  );
}

function ChannelSummary({ status }: { status: ConnectedStatus }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div className="min-w-0 rounded-lg border p-3">
        <dt className="text-muted-foreground">Notify Channel</dt>
        <dd className="truncate font-medium">
          {status.notifyChannelName
            ? `#${status.notifyChannelName}`
            : "Not configured"}
        </dd>
      </div>
      <div className="min-w-0 rounded-lg border p-3">
        <dt className="text-muted-foreground">Stale-Lead Reminder</dt>
        <dd className="truncate font-medium">
          {status.staleReminderChannelName
            ? `#${status.staleReminderChannelName}`
            : "Not configured"}
        </dd>
      </div>
    </dl>
  );
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(value);
}
