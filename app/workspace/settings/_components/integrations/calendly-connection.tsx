"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { useNow } from "@/hooks/use-now";
import {
  formatCalendlyLastRefresh,
  formatCalendlyTokenExpiry,
  getCalendlyTokenTiming,
} from "@/lib/calendly-connection-status";
import { getErrorMessage } from "@/lib/errors";
import posthog from "@/lib/posthog-browser";
import { ActionRow, FACT_FIGURE, Fact, Facts, NoteLine, StatusWord, type Tone } from "../settings-ui";
import { calendlyState, calendlyWebhookReady, type CalendlyStatus } from "./integration-status";

const SYNC_RESULT: Record<NonNullable<CalendlyStatus["lastEventTypeSyncStatus"]>, { word: string; tone: Tone }> = {
  success: { word: "Synced", tone: "muted" },
  failed: { word: "Failed", tone: "danger" },
  skipped: { word: "Skipped", tone: "muted" },
};

/**
 * The Calendly connection: one status word in the title row, the token,
 * webhook and event type sync as dense facts, and the card's actions in the
 * footer. Lime only on Reconnect while Calendly isn't connected.
 */
export function CalendlyConnection({ connectionStatus }: { connectionStatus: CalendlyStatus | null }) {
  const refreshToken = useAction(api.calendly.tokens.refreshMyTenantToken);
  const syncMembers = useAction(api.calendly.orgMembers.syncMyTenantMembers);
  const syncEventTypes = useAction(api.calendly.eventTypes.syncMyTenantEventTypes);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingEventTypes, setIsSyncingEventTypes] = useState(false);
  const now = useNow();

  if (!connectionStatus) {
    return null;
  }

  const state = calendlyState(connectionStatus, now);
  const isConnected = state.connected;
  const { isExpired, isExpiringSoon } = getCalendlyTokenTiming(connectionStatus.tokenExpiresAt, now);

  const handleRefreshToken = async () => {
    setIsRefreshing(true);
    try {
      const result = await refreshToken();
      if (result.refreshed) {
        toast.success("Token refreshed successfully");
      } else {
        toast.info(result.reason ?? "Token refresh skipped");
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to refresh token"));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSyncMembers = async () => {
    setIsSyncing(true);
    try {
      const result = await syncMembers();
      if (result.reason) {
        toast.error(`Sync skipped: ${result.reason.replace(/_/g, " ")}`);
      } else {
        toast.success(
          `Synced ${result.synced} member${result.synced !== 1 ? "s" : ""}${result.deleted > 0 ? `, removed ${result.deleted} stale` : ""}`,
        );
      }
      posthog.capture("calendly_members_synced", {
        synced: result.synced,
        deleted: result.deleted,
        reason: result.reason ?? null,
      });
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to sync members"));
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncEventTypes = async () => {
    setIsSyncingEventTypes(true);
    try {
      const result = await syncEventTypes();
      posthog.capture("calendly_event_types_synced", result);

      if (result.status === "skipped") {
        toast.info("An event type sync is already running.");
        return;
      }

      toast.success(`Synced ${result.totalSeen} event types: ${result.created} new, ${result.updated} updated.`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to sync event types"));
    } finally {
      setIsSyncingEventTypes(false);
    }
  };

  const handleReconnect = () => {
    posthog.capture("calendly_reconnected", {
      was_connected: isConnected,
      needs_reconnect: connectionStatus.needsReconnect,
    });
    const params = new URLSearchParams({
      tenantId: connectionStatus.tenantId,
      mode: "reconnect",
      returnTo: "/workspace/settings",
    });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- /api/calendly/start is a route handler and needs a full page load
    window.location.href = `/api/calendly/start?${params.toString()}`;
  };

  const isEventTypeSyncing = isSyncingEventTypes || connectionStatus.eventTypeSyncInProgress;
  const syncSummary = connectionStatus.lastEventTypeSyncSummary;
  const syncResult = connectionStatus.lastEventTypeSyncStatus
    ? SYNC_RESULT[connectionStatus.lastEventTypeSyncStatus]
    : null;
  const webhookReady = calendlyWebhookReady(connectionStatus);

  return (
    <section aria-label="Calendly" className={CARD}>
      <CardHead title="Calendly">
        <StatusWord tone={state.tone}>{state.word}</StatusWord>
      </CardHead>

      {!isConnected ? (
        <div className="px-4 py-3">
          <NoteLine>
            {connectionStatus.needsReconnect
              ? "Magnus lost access to your Calendly account. Reconnect it to keep receiving bookings, members and event types."
              : "Bookings, members and event types come from Calendly. Connect it to start receiving meetings."}
          </NoteLine>
        </div>
      ) : (
        <>
          {connectionStatus.tokenExpiresAt !== null ? (
            <Facts>
              <Fact
                label="Token expires"
                tip="Magnus refreshes the Calendly token on its own before it expires. Refresh token does it now."
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className={FACT_FIGURE}>
                    {formatCalendlyTokenExpiry(connectionStatus.tokenExpiresAt, now)}
                  </span>
                  {isExpired ? <StatusWord tone="danger">Expired</StatusWord> : null}
                  {isExpiringSoon ? <StatusWord tone="warning">Expiring soon</StatusWord> : null}
                </span>
              </Fact>
              {connectionStatus.lastTokenRefresh !== null ? (
                <Fact label="Last refresh">
                  <span className={FACT_FIGURE}>{formatCalendlyLastRefresh(connectionStatus.lastTokenRefresh, now)}</span>
                </Fact>
              ) : null}
            </Facts>
          ) : null}
          <Facts>
            <Fact
              label="Webhook"
              tip="Calendly tells Magnus about each booking and cancellation through this webhook. Reconnecting sets it up again."
            >
              {webhookReady ? (
                <span>Receiving bookings</span>
              ) : (
                <span className="text-warning-ink">Not set up. Reconnect Calendly to receive bookings.</span>
              )}
            </Fact>
          </Facts>
          <Facts>
            <Fact label="Event types" tip="When Magnus last read your Calendly event types, and what it found.">
              <span className="flex flex-wrap items-baseline gap-x-2">
                {connectionStatus.lastEventTypeSyncCompletedAt ? (
                  <span className={FACT_FIGURE}>
                    {formatCalendlyLastRefresh(connectionStatus.lastEventTypeSyncCompletedAt, now)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Never synced</span>
                )}
                {isEventTypeSyncing ? (
                  <StatusWord tone="muted">Syncing</StatusWord>
                ) : syncResult ? (
                  <StatusWord tone={syncResult.tone}>{syncResult.word}</StatusWord>
                ) : null}
                {connectionStatus.lastEventTypeSyncCount !== null ? (
                  <span className="text-[13px] text-muted-foreground">
                    <span className="font-condensed text-[14px] tabular-nums">
                      {connectionStatus.lastEventTypeSyncCount}
                    </span>{" "}
                    event types
                  </span>
                ) : null}
              </span>
            </Fact>
            {syncSummary ? (
              <Fact
                label="Last changes"
                tip="What the last sync changed. Not returned: event types Calendly no longer lists for your organization."
              >
                <span className="font-condensed text-[14px] tabular-nums">
                  {syncSummary.created} new · {syncSummary.updated} updated
                </span>
                <span className="block text-[13px] text-muted-foreground">
                  {syncSummary.inactive} inactive, {syncSummary.deleted} deleted, {syncSummary.notReturned} not returned
                </span>
              </Fact>
            ) : null}
            {connectionStatus.lastEventTypeSyncError ? (
              <div className="px-4 pt-0.5 pb-1.5">
                <NoteLine tone="danger" role="alert">
                  {connectionStatus.lastEventTypeSyncError}
                </NoteLine>
              </div>
            ) : null}
          </Facts>
        </>
      )}

      <ActionRow>
        {isConnected ? (
          <>
            <Button variant="outline" size="sm" onClick={handleSyncEventTypes} disabled={isEventTypeSyncing}>
              {isEventTypeSyncing ? <Spinner data-icon="inline-start" /> : null}
              {isEventTypeSyncing ? "Syncing event types…" : "Sync event types"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleSyncMembers} disabled={isSyncing}>
              {isSyncing ? <Spinner data-icon="inline-start" /> : null}
              {isSyncing ? "Syncing members…" : "Sync members"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefreshToken} disabled={isRefreshing}>
              {isRefreshing ? <Spinner data-icon="inline-start" /> : null}
              {isRefreshing ? "Refreshing…" : "Refresh token"}
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={handleReconnect}>
              Reconnect
            </Button>
          </>
        ) : (
          <Button size="sm" className="font-semibold" onClick={handleReconnect}>
            {connectionStatus.needsReconnect ? "Reconnect Calendly" : "Connect Calendly"}
          </Button>
        )}
      </ActionRow>
    </section>
  );
}
