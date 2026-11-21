import type { WithoutSystemFields } from "convex/server";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { validateAmountMinor, validateCurrency } from "./formatMoney";

export async function addPinnedLine(
  ctx: MutationCtx,
  line: WithoutSystemFields<Doc<"closerPinnedLines">>,
) {
  const { amountMinor, currency } = line;
  if (amountMinor === undefined && currency === undefined) {
    return await ctx.db.insert("closerPinnedLines", line);
  }
  if (amountMinor === undefined || currency === undefined) {
    throw new Error("Pinned line amount and currency must be provided together");
  }
  return await ctx.db.insert("closerPinnedLines", {
    ...line,
    amountMinor: validateAmountMinor(amountMinor),
    currency: validateCurrency(currency),
  });
}
