import { v, type Infer } from "convex/values";

// Respark (docs/plans/respark.md §3.1). The newest touch of any kind, wider
// than `latestTouch`, and the part of the pool a person's stage,
// disposition and deals put them in, before any time rule.

export const lastTouchValidator = v.object({
  eventId: v.id("domainEvents"),
  eventType: v.string(),
  occurredAt: v.number(),
});

export type LastTouch = Infer<typeof lastTouchValidator>;

export const RESPARK_GROUPS = [
  "qualified",
  "never_qualified",
  "had_call",
  "not_a_fit",
  "out",
] as const;

export type ResparkGroup = (typeof RESPARK_GROUPS)[number];

export const resparkGroupValidator = v.union(
  v.literal("qualified"),
  v.literal("never_qualified"),
  v.literal("had_call"),
  v.literal("not_a_fit"),
  v.literal("out"),
);

// What a lead generator did with a held person (plan §5.3). An item with no
// result is unworked; while its batch is unexpired, it holds the person.
export const resparkResultValidator = v.union(
  v.literal("resparked"),
  v.literal("not_a_fit"),
  v.literal("skipped"),
);

export type ResparkResult = Infer<typeof resparkResultValidator>;

// The pool's buckets, in claim order (plan §4.4).
export const RESPARK_BUCKETS = [1, 2, 3, 4, 5] as const;
export type ResparkBucket = (typeof RESPARK_BUCKETS)[number];
