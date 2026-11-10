import type { ReaderArgs } from "../../analytics/assistantTypes";
import { buildDirectory } from "../../team/directoryCore";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { getDirectory } from "../../team/directory";
// Trusted tenant readers. Copied load steps preserve page semantics; builders stay shared.
export async function readGetDirectory(ctx: QueryCtx, tenantId: Id<"tenants">, _args: ReaderArgs<typeof getDirectory>) {
    return await buildDirectory(ctx, tenantId);
}
