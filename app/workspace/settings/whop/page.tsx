import { requireRole } from "@/lib/auth";
import { WhopPageClient } from "./_components/whop-page-client";

export const instant = false;

/** Whop's own settings page: the webhook, the connection's health, and products and prices mapped to programs and payment types. */
export default async function WhopSettingsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);
  return <WhopPageClient />;
}
