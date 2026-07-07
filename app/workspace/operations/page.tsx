import { redirect } from "next/navigation";

export const unstable_instant = false;

/**
 * Legacy operations hub. The old tabbed page (`?tab=...`) is now split into
 * real sub-routes; this page only maps old tab URLs to their new homes.
 */
const TAB_ROUTES: Record<string, string> = {
  qualifications: "/workspace/operations/qualifications",
  scheduling: "/workspace/operations/booked-calls",
  "phone-sales": "/workspace/operations/sales-calls",
};

function firstString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tab = firstString(params.tab);
  const target =
    (tab && TAB_ROUTES[tab]) || "/workspace/operations/qualifications";

  // Preserve any remaining query params (e.g. qualifiedAfter/qualifiedBefore
  // deep links from the Slack Qualifications report).
  const rest = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "tab" || value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      rest.append(key, entry);
    }
  }

  redirect(`${target}${rest.size ? `?${rest.toString()}` : ""}`);
}
