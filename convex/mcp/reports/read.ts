import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { mcpCallerValidator, requireMcpAdmin } from "../guard";
import { resolvedRangeValidator } from "../../analytics/results";
import { analyticsFiltersValidator } from "../../analytics/keys";
import { readLivePanel } from "./live";
export const panel = internalQuery({
    args: { caller: mcpCallerValidator, id: v.string(), filters: analyticsFiltersValidator, range: resolvedRangeValidator }, returns: v.string(),
    handler: async (ctx, args) => {
        const me = await requireMcpAdmin(ctx, args.caller, { permission: "reports:view" });
        return JSON.stringify(await readLivePanel(ctx, me.tenantId, args.id, args.filters, args.range));
    },
});
