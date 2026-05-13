import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { SettingsPageClient } from "./_components/settings-page-client";

export const unstable_instant = false;

export default async function SettingsPage() {
  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const preloadedSlackStatus = await preloadQuery(
    api.slack.channels.getInstallationStatus,
    {},
    { token: session.accessToken },
  );

  return <SettingsPageClient preloadedSlackStatus={preloadedSlackStatus} />;
}
