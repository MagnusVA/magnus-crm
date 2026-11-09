import { fetchQuery } from "convex/nextjs";
import { redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { requirePermission } from "@/lib/auth";

export const instant = false;

/**
 * "My report": the viewer's own member report. Closers and lead generators
 * reach it from their sidebar; admins can open it too. The range and any
 * other query string carry over.
 */
export default async function MyReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session } = await requirePermission("reports:view-own");
  const teamMemberId = await fetchQuery(api.reports.me.getMyTeamMemberId, {}, { token: session.accessToken });

  if (teamMemberId) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(await searchParams)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
    }
    const search = query.toString();
    redirect(`/workspace/reports/people/${teamMemberId}${search ? `?${search}` : ""}`);
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-2 px-4 py-16 text-center">
      <h1 className="font-condensed text-2xl font-semibold tracking-[0.01em]">No report yet</h1>
      <p className="text-sm text-muted-foreground">
        Your account isn&apos;t linked to a team member yet, so there&apos;s no report to show. Ask an admin to link
        it in Team.
      </p>
    </div>
  );
}
