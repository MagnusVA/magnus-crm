import { redirect } from "next/navigation";

export const unstable_instant = false;

const PHONE_SALES_STATUSES = new Set([
  "scheduled",
  "completed",
  "no_show",
]);

function firstString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LegacyPipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = firstString(params.status);
  const closer = firstString(params.closer);
  const period = firstString(params.period);

  if (status && PHONE_SALES_STATUSES.has(status)) {
    const next = new URLSearchParams({
      tab: "phone-sales",
      status,
    });
    if (closer) next.set("closerId", closer);
    if (period) next.set("period", period);
    redirect(`/workspace/operations?${next.toString()}`);
  }

  const next = new URLSearchParams();
  if (status) next.set("status", status);
  if (closer) next.set("closer", closer);
  if (period) next.set("period", period);

  redirect(`/workspace/opportunities${next.size ? `?${next.toString()}` : ""}`);
}
