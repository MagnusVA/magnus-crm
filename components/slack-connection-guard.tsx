"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type SlackConnectionStatus = FunctionReturnType<
  typeof api.slack.installations.getConnectionStatus
>;

type ReconnectStatus = Extract<
  SlackConnectionStatus["status"],
  "token_expired" | "revoked" | "uninstalled"
>;

function bannerCopy(status: ReconnectStatus) {
  switch (status) {
    case "token_expired":
      return {
        title: "Slack disconnected",
        body: (
          <>
            Slack lead qualification is paused because the Slack token expired.
            Reconnect Slack to restore{" "}
            <span translate="no">/qualify-lead</span>, channel notifications,
            and stale-lead reminders.
          </>
        ),
        action: "Reconnect Slack",
      };
    case "revoked":
      return {
        title: "Slack access revoked",
        body: (
          <>
            Slack revoked this app&apos;s tokens. Reconnect Slack to restore
            lead qualification and notifications.
          </>
        ),
        action: "Reconnect Slack",
      };
    case "uninstalled":
      return {
        title: "Slack app uninstalled",
        body: (
          <>
            The Magnus Slack app was removed from your workspace. Reinstall it
            to restore <span translate="no">/qualify-lead</span> and Slack
            notifications.
          </>
        ),
        action: "Reinstall Slack",
      };
  }
}

function toastForSlackRedirect(status: string) {
  switch (status) {
    case "connected":
      toast.success("Slack reconnected.");
      return;
    case "denied":
      toast.error("Slack connection was not approved.");
      return;
    case "start_failed":
      toast.error("Could not start the Slack connection. Please try again.");
      return;
    case "oauth_failed":
      toast.error("Slack connection failed. Please try again.");
      return;
    case "admin_required":
      toast.error("Only tenant owners and admins can connect Slack.");
      return;
  }
}

function toastForSlackOpen(reason: string) {
  switch (reason) {
    case "not_found":
      toast.error("That opportunity is not available in this workspace.");
      return;
    case "forbidden":
      toast.error("You do not have access to that opportunity.");
      return;
    case "invalid_opportunity":
      toast.error("That Slack opportunity link is invalid.");
      return;
    case "system_admin":
      toast.error("Open tenant opportunities from a workspace account.");
      return;
  }
}

function dismissKey(status: SlackConnectionStatus) {
  return [
    status.installationId ?? "none",
    status.status,
    status.tokenExpiresAt ?? "no-expiry",
    status.lastRefreshedAt ?? "no-refresh",
    status.installedAt ?? "not-installed",
  ].join(":");
}

function SlackReconnectBanner({
  status,
  onDismiss,
}: {
  status: ReconnectStatus;
  onDismiss: () => void;
}) {
  const copy = bannerCopy(status);

  return (
    <Alert className="rounded-none border-x-0 border-t-0 border-amber-500/30 bg-amber-50 text-amber-950 animate-in fade-in slide-in-from-top-2 duration-300 motion-reduce:animate-none dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription className="text-amber-900/90 dark:text-amber-100/85">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p>{copy.body}</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href="/api/slack/start" aria-label={copy.action}>
                <RefreshCwIcon data-icon="inline-start" />
                {copy.action}
              </a>
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onDismiss}
              aria-label="Dismiss Slack reconnection banner"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function SlackConnectionGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const processedSlackRedirectRef = useRef<string | null>(null);
  const currentUser = useQuery(
    api.users.queries.getCurrentUser,
    pathname.startsWith("/workspace") ? {} : "skip",
  );
  const canCheckConnection =
    pathname.startsWith("/workspace") &&
    currentUser !== undefined &&
    currentUser !== null &&
    (currentUser.role === "tenant_master" ||
      currentUser.role === "tenant_admin");
  const connectionStatus = useQuery(
    api.slack.installations.getConnectionStatus,
    canCheckConnection ? {} : "skip",
  );
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !pathname.startsWith("/workspace")
    ) {
      return;
    }

    const url = new URL(window.location.href);
    const slackStatus = url.searchParams.get("slack");
    const slackOpenReason = url.searchParams.get("slackOpen");
    if (!slackStatus && !slackOpenReason) return;

    const redirectKey = `${url.pathname}${url.search}`;
    if (processedSlackRedirectRef.current === redirectKey) return;

    processedSlackRedirectRef.current = redirectKey;
    if (slackStatus) {
      toastForSlackRedirect(slackStatus);
    }
    if (slackOpenReason) {
      toastForSlackOpen(slackOpenReason);
    }
  }, [pathname]);

  const currentDismissKey = connectionStatus
    ? dismissKey(connectionStatus)
    : null;
  const reconnectStatus =
    connectionStatus?.status === "token_expired" ||
    connectionStatus?.status === "revoked" ||
    connectionStatus?.status === "uninstalled"
      ? connectionStatus.status
      : null;
  const showBanner =
    Boolean(connectionStatus?.needsReconnect) &&
    reconnectStatus !== null &&
    currentDismissKey !== null &&
    dismissedKey !== currentDismissKey;

  return (
    <>
      {showBanner ? (
        <SlackReconnectBanner
          status={reconnectStatus}
          onDismiss={() => setDismissedKey(currentDismissKey)}
        />
      ) : null}
      {children}
    </>
  );
}
