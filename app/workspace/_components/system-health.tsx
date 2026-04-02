"use client";

import { useQuery } from "convex/react";
import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
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

function formatRelativeTime(timestamp: number) {
  const hours = Math.floor((Date.now() - timestamp) / (60 * 60 * 1000));
  if (hours < 1) return "Just now";
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatExpiry(timestamp: number) {
  const days = Math.floor((timestamp - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return "Expired";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return `In ${days} days`;
  return new Date(timestamp).toLocaleDateString();
}

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
  const isExpired =
    connectionStatus.tokenExpiresAt !== null &&
    connectionStatus.tokenExpiresAt < Date.now();
  const isExpiringSoon =
    !isExpired &&
    connectionStatus.tokenExpiresAt !== null &&
    connectionStatus.tokenExpiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000;

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
                <CheckCircle2Icon className="mt-0.5 size-5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <AlertCircleIcon className="mt-0.5 size-5 text-red-600 dark:text-red-400" />
              )}
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">Calendly Connection</p>
                <p className="text-xs text-muted-foreground">
                  Status: {isConnected ? "Connected" : "Disconnected"}
                </p>
                {connectionStatus.tokenExpiresAt !== null && (
                  <p className="text-xs text-muted-foreground">
                    Token expires: {formatExpiry(connectionStatus.tokenExpiresAt)}
                  </p>
                )}
                {connectionStatus.lastTokenRefresh !== null && (
                  <p className="text-xs text-muted-foreground">
                    Last refresh:{" "}
                    {formatRelativeTime(connectionStatus.lastTokenRefresh)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isExpired && <Badge variant="destructive">Token Expired</Badge>}
              {isExpiringSoon && (
                <Badge
                  variant="outline"
                  className="bg-amber-50 dark:bg-amber-950"
                >
                  Expiring Soon
                </Badge>
              )}
              {isConnected && !isExpired && !isExpiringSoon && (
                <Badge
                  variant="outline"
                  className="bg-emerald-50 dark:bg-emerald-950"
                >
                  Active
                </Badge>
              )}
              {!isConnected && (
                <Badge variant="destructive">Disconnected</Badge>
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
