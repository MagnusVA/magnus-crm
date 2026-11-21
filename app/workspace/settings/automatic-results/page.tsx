import { requirePermission } from "@/lib/auth";
import { AutomaticResultsPageClient } from "./_components/automatic-results-page-client";

export const instant = false;

/** The owner's switches for results the CRM records from Whop payments and recorded calls, the checks, the grading queue and the scorecard. */
export default async function AutomaticResultsPage() {
  await requirePermission("result-automation:view");
  return <AutomaticResultsPageClient />;
}
