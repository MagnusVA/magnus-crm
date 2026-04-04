"use client";

import { useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/* -------------------------------------------------------------------------- */
/*  Presentational banner — separated for composition and testability         */
/* -------------------------------------------------------------------------- */

/**
 * Pure presentational banner shown when a tenant's Calendly connection is lost.
 *
 * Accepts callbacks and state from the parent guard — no data-fetching of its
 * own — so it can be rendered in isolation (e.g. Storybook) or swapped out for
 * a different visual treatment without touching subscription logic.
 */
function CalendlyReconnectBanner({
  onReconnect,
  onDismiss,
  isReconnecting,
}: {
  onReconnect: () => void;
  onDismiss: () => void;
  isReconnecting: boolean;
}) {
  return (
    <Alert
      variant="destructive"
      className="rounded-none border-x-0 border-t-0 animate-in fade-in slide-in-from-top-2 duration-300 motion-reduce:animate-none"
    >
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>Calendly disconnected</AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Your Calendly connection was lost. Reconnect to resume receiving
            meeting data.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={onReconnect}
              disabled={isReconnecting}
              aria-label="Reconnect Calendly account"
            >
              {isReconnecting ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Reconnecting&hellip;
                </>
              ) : (
                "Reconnect Calendly"
              )}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onDismiss}
              aria-label="Dismiss reconnection banner"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/* -------------------------------------------------------------------------- */
/*  Guard wrapper — subscribes to connection status, conditionally shows banner*/
/* -------------------------------------------------------------------------- */

/**
 * CalendlyConnectionGuard subscribes to the current tenant's Calendly
 * connection status and renders a reconnection banner when the connection
 * is lost (`status: "calendly_disconnected"`).
 *
 * **Composition:** Wraps children transparently — the banner is prepended
 * above the child tree without adding wrapper DOM nodes.
 *
 * **Integration:** Place inside `ConvexProviderWithAuth` so the query has
 * access to the authenticated identity.
 *
 * **Performance:**
 * - No manual `useMemo`/`useCallback` — React Compiler auto-memoises.
 * - OAuth redirect deferred to event handler (not an effect).
 * - Dismissal is local state — resets on next session / page reload.
 */
export function CalendlyConnectionGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const currentUser = useQuery(
    api.users.queries.getCurrentUser,
    pathname.startsWith("/workspace") ? {} : "skip",
  );
  const canCheckConnection =
    pathname.startsWith("/workspace") &&
    currentUser !== undefined &&
    currentUser !== null &&
    (currentUser.role === "tenant_master" || currentUser.role === "tenant_admin");
  const connectionStatus = useQuery(
    api.calendly.oauthQueries.getConnectionStatus,
    canCheckConnection ? {} : "skip",
  );

  // Dismissal persists until page reload — banner reappears next session
  const [isDismissed, setIsDismissed] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  // Trivial boolean — useMemo would add overhead, not save it
  const showBanner =
    (connectionStatus?.needsReconnect ?? false) && !isDismissed;

  // React Compiler auto-memoises — no manual useCallback needed
  const handleReconnect = async () => {
    if (!connectionStatus?.tenantId) return;

    setIsReconnecting(true);
    try {
      // Use server route to ensure onboarding_tenantId cookie is set before OAuth redirect
      window.location.href = `/api/calendly/start?tenantId=${encodeURIComponent(connectionStatus.tenantId)}`;
    } catch (error) {
      console.error("CalendlyConnectionGuard: Failed to start OAuth:", error);
      toast.error("Failed to reconnect Calendly. Please try again.");
      setIsReconnecting(false);
    }
  };

  const handleDismiss = () => {
    setIsDismissed(true);
  };

  return (
    <>
      {showBanner ? (
        <CalendlyReconnectBanner
          onReconnect={handleReconnect}
          onDismiss={handleDismiss}
          isReconnecting={isReconnecting}
        />
      ) : null}
      {children}
    </>
  );
}
