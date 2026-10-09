import { ConvexError } from "convex/values";
export function blockBooking(reason: string): never {
  throw new ConvexError({ kind: "booking_blocked", reason });
}
export function blockedReason(error: unknown): string | undefined {
  if (!(error instanceof ConvexError)) return;
  const data: unknown = error.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "kind" in data &&
    data.kind === "booking_blocked" &&
    "reason" in data &&
    typeof data.reason === "string"
  )
    return data.reason;
}
