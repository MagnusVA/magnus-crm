"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
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
        <CardTitle>Calendly Connection</CardTitle>
        <CardDescription>Manage your Calendly integration</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          {isConnected ? (
            <CheckCircle2Icon className="mt-1 size-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertCircleIcon className="mt-1 size-5 flex-shrink-0 text-red-600 dark:text-red-400" />
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
            variant={isConnected ? "secondary" : "destructive"}
            className={
              isConnected
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                : ""
            }
          >
            {isConnected ? "Active" : "Inactive"}
          </Badge>
        </div>

        {connectionStatus.tokenExpiresAt !== null && (
          <div className="border-t pt-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Token Expires</p>
                <p className="mt-1 text-sm font-medium">
                  {formatExpiry(connectionStatus.tokenExpiresAt)}
                </p>
              </div>
              {connectionStatus.lastTokenRefresh !== null && (
                <div>
                  <p className="text-xs text-muted-foreground">Last Refresh</p>
                  <p className="mt-1 text-sm font-medium">
                    {formatRelativeTime(connectionStatus.lastTokenRefresh)}
                  </p>
                </div>
              )}
              <div className="flex items-center">
                {isExpired && (
                  <Badge variant="destructive">Token Expired</Badge>
                )}
                {isExpiringSoon && (
                  <Badge
                    variant="outline"
                    className="bg-amber-50 dark:bg-amber-950"
                  >
                    Expiring Soon
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
