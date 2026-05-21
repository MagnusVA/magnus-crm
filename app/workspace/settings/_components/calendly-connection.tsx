"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  formatCalendlyLastRefresh,
  formatCalendlyTokenExpiry,
  getCalendlyTokenTiming,
} from "@/lib/calendly-connection-status";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  CheckCircle2Icon,
  AlertCircleIcon,
  RefreshCwIcon,
  LinkIcon,
  UsersIcon,
  CalendarSyncIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import posthog from "posthog-js";
import { connectionStatusConfig } from "@/lib/status-config";

interface ConnectionStatus {
  tenantId: string;
  status: string;
  needsReconnect: boolean;
  lastTokenRefresh: number | null;
  tokenExpiresAt: number | null;
  calendlyWebhookUri: string | null;
  hasWebhookSigningKey: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  eventTypeSyncInProgress: boolean;
  lastEventTypeSyncCompletedAt: number | null;
  lastEventTypeSyncStatus: "success" | "failed" | "skipped" | null;
  lastEventTypeSyncError: string | null;
  lastEventTypeSyncCount: number | null;
  lastEventTypeSyncSummary: {
    totalSeen: number;
    created: number;
    updated: number;
    unchanged: number;
    inactive: number;
    deleted: number;
    notReturned: number;
    questionsMerged: number;
  } | null;
}

interface CalendlyConnectionProps {
  connectionStatus: ConnectionStatus | null;
}

export function CalendlyConnection({
  connectionStatus,
}: CalendlyConnectionProps) {
  const refreshToken = useAction(api.calendly.tokens.refreshMyTenantToken);
  const syncMembers = useAction(api.calendly.orgMembers.syncMyTenantMembers);
  const syncEventTypes = useAction(
    api.calendly.eventTypes.syncMyTenantEventTypes,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingEventTypes, setIsSyncingEventTypes] = useState(false);

  if (!connectionStatus) {
    return null;
  }

  const isConnected =
    connectionStatus.hasAccessToken && !connectionStatus.needsReconnect;
  const now = Date.now();
  const { isExpired, isExpiringSoon } = getCalendlyTokenTiming(
    connectionStatus.tokenExpiresAt,
    now,
  );

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
      toast.error(
        error instanceof Error ? error.message : "Failed to refresh token",
      );
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
      toast.error(
        error instanceof Error ? error.message : "Failed to sync members",
      );
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

      toast.success(
        `Synced ${result.totalSeen} event types: ${result.created} new, ${result.updated} updated.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to sync event types",
      );
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
    window.location.href = `/api/calendly/start?${params.toString()}`;
  };

  const isEventTypeSyncing =
    isSyncingEventTypes || connectionStatus.eventTypeSyncInProgress;
  const syncSummary = connectionStatus.lastEventTypeSyncSummary;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Calendly Connection</CardTitle>
        <CardDescription>Manage your Calendly integration</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          {isConnected ? (
            <CheckCircle2Icon className={cn("mt-1 size-5 shrink-0", connectionStatusConfig.connected.iconClass)} />
          ) : (
            <AlertCircleIcon className={cn("mt-1 size-5 shrink-0", connectionStatusConfig.disconnected.iconClass)} />
          )}
          <div className="flex-1">
            <p className="font-medium">
              {isConnected ? "Connected" : "Disconnected"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isConnected
                ? "Your Calendly account is connected and active."
                : "Your Calendly account is not connected. Reconnect to use calendar features."}
            </p>
          </div>
          <Badge
            variant={isConnected ? connectionStatusConfig.connected.badgeVariant : connectionStatusConfig.disconnected.badgeVariant}
            className={isConnected ? connectionStatusConfig.connected.badgeClass : ""}
          >
            {isConnected ? connectionStatusConfig.connected.label : "Inactive"}
          </Badge>
        </div>

        {connectionStatus.tokenExpiresAt !== null && (
          <div className="border-t pt-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Token Expires</p>
                <p className="mt-1 text-sm font-medium">
                  {formatCalendlyTokenExpiry(
                    connectionStatus.tokenExpiresAt,
                    now,
                  )}
                </p>
              </div>
              {connectionStatus.lastTokenRefresh !== null && (
                <div>
                  <p className="text-xs text-muted-foreground">Last Refresh</p>
                  <p className="mt-1 text-sm font-medium">
                    {formatCalendlyLastRefresh(
                      connectionStatus.lastTokenRefresh,
                      now,
                    )}
                  </p>
                </div>
              )}
              <div className="flex items-center">
                {isExpired && (
                  <Badge variant="destructive">Token Expired</Badge>
                )}
                {isExpiringSoon && (
                  <Badge
                    variant={connectionStatusConfig.expiring.badgeVariant}
                    className={connectionStatusConfig.expiring.badgeClass}
                  >
                    {connectionStatusConfig.expiring.label}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="border-t pt-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">
                Last Event Type Sync
              </p>
              <p className="mt-1 text-sm font-medium">
                {connectionStatus.lastEventTypeSyncCompletedAt
                  ? formatCalendlyLastRefresh(
                      connectionStatus.lastEventTypeSyncCompletedAt,
                      now,
                    )
                  : "Never synced"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Sync Status</p>
              <div className="mt-1">
                <Badge
                  variant={
                    connectionStatus.lastEventTypeSyncStatus === "failed"
                      ? "destructive"
                      : connectionStatus.lastEventTypeSyncStatus === "success"
                        ? "secondary"
                        : "outline"
                  }
                >
                  {connectionStatus.lastEventTypeSyncStatus
                    ? connectionStatus.lastEventTypeSyncStatus.replace(
                        /_/g,
                        " ",
                      )
                    : "Not run"}
                </Badge>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Synced Count</p>
              <p className="mt-1 text-sm font-medium">
                {connectionStatus.lastEventTypeSyncCount ?? "-"}
              </p>
            </div>
            {syncSummary ? (
              <div>
                <p className="text-xs text-muted-foreground">Last Summary</p>
                <p className="mt-1 text-sm font-medium">
                  {syncSummary.created} new, {syncSummary.updated} updated
                </p>
                <p className="text-xs text-muted-foreground">
                  {syncSummary.inactive} inactive, {syncSummary.deleted}{" "}
                  deleted, {syncSummary.notReturned} not returned
                </p>
              </div>
            ) : null}
          </div>
          {connectionStatus.lastEventTypeSyncError ? (
            <p className="mt-3 text-xs text-destructive">
              {connectionStatus.lastEventTypeSyncError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshToken}
            disabled={isRefreshing || !isConnected}
          >
            {isRefreshing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            {isRefreshing ? "Refreshing..." : "Refresh Token"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncMembers}
            disabled={isSyncing || !isConnected}
          >
            {isSyncing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UsersIcon data-icon="inline-start" />
            )}
            {isSyncing ? "Syncing Members..." : "Sync Members"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncEventTypes}
            disabled={isEventTypeSyncing || !isConnected}
          >
            {isEventTypeSyncing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <CalendarSyncIcon data-icon="inline-start" />
            )}
            {isEventTypeSyncing ? "Syncing Event Types..." : "Sync Event Types"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleReconnect}>
            <LinkIcon data-icon="inline-start" />
            Reconnect Calendly
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
