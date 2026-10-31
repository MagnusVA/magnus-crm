import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

/** The deal modal's payload (`opportunities.detailQuery.getOpportunityDetail`), once loaded. */
export type DealModalDetail = NonNullable<
	FunctionReturnType<typeof api.opportunities.detailQuery.getOpportunityDetail>
>;
