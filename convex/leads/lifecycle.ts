import { v, type Infer } from "convex/values";

// How far a person has ever got (CONTEXT.md, "Lifecycle stage"), in order.
// docs/plans/phase-1-foundations.md §4 has the rules.
export const LIFECYCLE_STAGES = [
  "prospect",
  "in_conversation",
  "qualified",
  "booked",
  "showed",
  "customer",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const lifecycleStageValidator = v.union(
  v.literal("prospect"),
  v.literal("in_conversation"),
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("showed"),
  v.literal("customer"),
);

// The first time the person reached each stage or a later one. A stage the
// person skipped takes the time of the jump, so every stage up to the current
// one has a time.
export const lifecycleStageEnteredAtValidator = v.object({
  prospect: v.optional(v.number()),
  in_conversation: v.optional(v.number()),
  qualified: v.optional(v.number()),
  booked: v.optional(v.number()),
  showed: v.optional(v.number()),
  customer: v.optional(v.number()),
});

export type LifecycleStageEnteredAt = Infer<
  typeof lifecycleStageEnteredAtValidator
>;

// Whether the team should keep working a person, separate from their stage.
export const dispositionValidator = v.union(
  v.literal("open"),
  v.literal("nurture"),
  v.literal("not_a_fit"),
  v.literal("unresponsive"),
  v.literal("do_not_contact"),
);

export type Disposition = Infer<typeof dispositionValidator>;

// Who set the disposition. The system only ever changes a value it set.
export const dispositionSourceValidator = v.union(
  v.literal("system"),
  v.literal("admin"),
);

export type LifecycleState = {
  stage: LifecycleStage;
  enteredAt: LifecycleStageEnteredAt;
};

export type LifecycleEvidence = { stage: LifecycleStage; at: number };

export function stageIndex(stage: LifecycleStage): number {
  return LIFECYCLE_STAGES.indexOf(stage);
}

/** Below Qualified: a prospect, whom lead counts and the default list leave out. */
export function isProspectStage(stage: LifecycleStage): boolean {
  return stageIndex(stage) < stageIndex("qualified");
}

/**
 * The person reached `stage` at `at`. The stage only moves forward, and each
 * entry time at or below `stage` becomes the earlier of the two, so a late
 * event can move times earlier but never moves the stage back.
 */
export function advanceLifecycle(
  state: LifecycleState | null,
  stage: LifecycleStage,
  at: number,
): LifecycleState {
  const enteredAt: LifecycleStageEnteredAt = { ...state?.enteredAt };
  const top = stageIndex(stage);
  for (const reached of LIFECYCLE_STAGES.slice(0, top + 1)) {
    const current = enteredAt[reached];
    if (current === undefined || at < current) {
      enteredAt[reached] = at;
    }
  }
  const current = state ? stageIndex(state.stage) : -1;
  return { stage: LIFECYCLE_STAGES[Math.max(current, top)], enteredAt };
}

/** A person's lifecycle from dated evidence, in any order. */
export function deriveLifecycle(
  evidence: readonly LifecycleEvidence[],
): LifecycleState | null {
  return evidence.reduce<LifecycleState | null>(
    (state, item) => advanceLifecycle(state, item.stage, item.at),
    null,
  );
}

/** Two records of one person, as a merge joins them. */
export function combineLifecycles(
  a: LifecycleState | null,
  b: LifecycleState | null,
): LifecycleState | null {
  return deriveLifecycle([...lifecycleEvidence(a), ...lifecycleEvidence(b)]);
}

function lifecycleEvidence(state: LifecycleState | null): LifecycleEvidence[] {
  if (!state) {
    return [];
  }
  return LIFECYCLE_STAGES.flatMap((stage) => {
    const at = state.enteredAt[stage];
    return at === undefined ? [] : [{ stage, at }];
  });
}
