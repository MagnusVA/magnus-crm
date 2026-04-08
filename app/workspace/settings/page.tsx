import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { requireRole } from "@/lib/auth";
import { SettingsPageClient } from "./_components/settings-page-client";

export const unstable_instant = { prefetch: "static" };

export default async function SettingsPage() {
  const { session } = await requireRole(ADMIN_ROLES);

  const [preloadedEventTypeConfigs, preloadedConnectionStatus] =
    await Promise.all([
      preloadQuery(
        api.eventTypeConfigs.queries.listEventTypeConfigs,
        {},
        { token: session.accessToken },
      ),
      preloadQuery(
        api.calendly.oauthQueries.getConnectionStatus,
        {},
        { token: session.accessToken },
      ),
    ]);

  return (
    <SettingsPageClient
      preloadedEventTypeConfigs={preloadedEventTypeConfigs}
      preloadedConnectionStatus={preloadedConnectionStatus}
    />
  );
}
