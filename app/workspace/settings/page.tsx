import { redirect } from "next/navigation";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { SettingsPageClient } from "./_components/settings-page-client";

export const unstable_instant = false;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  // Legacy deep links to tabs that moved out of Settings.
  if (tab === "attribution") {
    redirect("/workspace/operations/booked-calls/attribution");
  }
  if (tab === "schedules") {
    redirect("/workspace/operations/booked-calls");
  }

  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const preloadedSlackStatus = await preloadQuery(
    api.slack.channels.getInstallationStatus,
    {},
    { token: session.accessToken },
  );

  return <SettingsPageClient preloadedSlackStatus={preloadedSlackStatus} />;
}
