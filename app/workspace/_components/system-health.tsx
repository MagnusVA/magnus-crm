"use client";

import { useQuery } from "convex/react";
import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import {
  formatCalendlyLastRefresh,
  formatCalendlyTokenExpiry,
  getCalendlyTokenTiming,
} from "@/lib/calendly-connection-status";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
  LinkIcon,
} from "lucide-react";
import { toast } from "sonner";
import { connectionStatusConfig } from "@/lib/status-config";

export function SystemHealth() {
  const connectionStatus = useQuery(
    api.calendly.oauthQueries.getConnectionStatus,
  );
  const refreshToken = useAction(api.calendly.tokens.refreshMyTenantToken);
  const [isRefreshing, setIsRefreshing] = useState(false);

  if (connectionStatus === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">System Health</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (connectionStatus === null) {
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

  const handleReconnect = () => {
    window.location.href = "/api/calendly/start";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">System Health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {/* Calendly Connection Status */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="flex items-start gap-3">
              {isConnected ? (
                <CheckCircle2Icon className={cn("mt-0.5 size-5", connectionStatusConfig.connected.iconClass)} />
              ) : (
                <AlertCircleIcon className={cn("mt-0.5 size-5", connectionStatusConfig.disconnected.iconClass)} />
              )}
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">Calendly Connection</p>
                <p className="text-xs text-muted-foreground">
                  Status: {isConnected ? "Connected" : "Disconnected"}
                </p>
                {connectionStatus.tokenExpiresAt !== null && (
                  <p className="text-xs text-muted-foreground">
                    Token expires:{" "}
                    {formatCalendlyTokenExpiry(
                      connectionStatus.tokenExpiresAt,
                      now,
                    )}
                  </p>
                )}
                {connectionStatus.lastTokenRefresh !== null && (
                  <p className="text-xs text-muted-foreground">
                    Last refresh:{" "}
                    {formatCalendlyLastRefresh(
                      connectionStatus.lastTokenRefresh,
                      now,
                    )}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isExpired && (
                <Badge variant={connectionStatusConfig.expired.badgeVariant}>
                  {connectionStatusConfig.expired.label}
                </Badge>
              )}
              {isExpiringSoon && (
                <Badge
                  variant={connectionStatusConfig.expiring.badgeVariant}
                  className={connectionStatusConfig.expiring.badgeClass}
                >
                  {connectionStatusConfig.expiring.label}
                </Badge>
              )}
              {isConnected && !isExpired && !isExpiringSoon && (
                <Badge
                  variant={connectionStatusConfig.connected.badgeVariant}
                  className={connectionStatusConfig.connected.badgeClass}
                >
                  {connectionStatusConfig.connected.label}
                </Badge>
              )}
              {!isConnected && (
                <Badge variant={connectionStatusConfig.disconnected.badgeVariant}>
                  {connectionStatusConfig.disconnected.label}
                </Badge>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
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
            <Button variant="outline" size="sm" onClick={handleReconnect}>
              <LinkIcon data-icon="inline-start" />
              Reconnect Calendly
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
