import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { addBusinessDays } from "../../../lib/businessDay";
import { readGetQualificationsDashboard } from "./qualificationReader";
import { readGetBookedCallsDashboard } from "./bookedReader";
import { readGetDirectory } from "./directoryReader";
export async function readOperationsPanel(ctx: QueryCtx, tenantId: Id<"tenants">, id: string, range: ResolvedAnalyticsRange) {
    const args = { range: { kind: "custom" as const, startBusinessDate: range.startDate, endBusinessDateInclusive: range.endDateInclusive } };
    return id === "qualifications.dashboard" ? readGetQualificationsDashboard(ctx, tenantId, args) : readGetBookedCallsDashboard(ctx, tenantId, args);
}
/** useGoalsData's assembly on the server. The page retains its existing hook. */
export async function readGoals(ctx: QueryCtx, tenantId: Id<"tenants">) {
    const directory = await readGetDirectory(ctx, tenantId, {});
    const range = { kind: "custom" as const, startBusinessDate: addBusinessDays(directory.today, -30), endBusinessDateInclusive: addBusinessDays(directory.today, -1) };
    const qualifications = await readGetQualificationsDashboard(ctx, tenantId, { range });
    const booked = await readGetBookedCallsDashboard(ctx, tenantId, { range });
    return { directory, qualifications, booked };
}
