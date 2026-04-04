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
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
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
}

interface CalendlyConnectionProps {
  connectionStatus: ConnectionStatus | null;
}

export function CalendlyConnection({
  connectionStatus,
}: CalendlyConnectionProps) {
  const refreshToken = useAction(api.calendly.tokens.refreshMyTenantToken);
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  const handleReconnect = () => {
    window.location.href = "/api/calendly/start";
  };

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

        <div className="flex gap-2 pt-2">
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
      </CardContent>
    </Card>
  );
}
