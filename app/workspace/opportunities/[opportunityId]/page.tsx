import { fetchQuery } from "convex/nextjs";
import { notFound, redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyOpportunityDetailPage({
  params,
}: {
  params: Promise<{ opportunityId: string }>;
}) {
  const { opportunityId } = await params;
  const { session } = await requirePermission("pipeline:view-own");
  let target = null;

  try {
    target = await fetchQuery(
      api.leadCustomers.redirects.resolveOpportunityRedirect,
      { opportunityId: opportunityId as Id<"opportunities"> },
      { token: session.accessToken },
    );
  } catch {
    target = null;
  }

  if (!target) notFound();
  redirect(
    `/workspace/leads-customers/${target.leadId}?opportunityId=${target.opportunityId}`,
  );
}
