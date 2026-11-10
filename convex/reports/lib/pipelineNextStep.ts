export function pipelineNextStep(
  deal: {
    nextMeetingAt: number | null | undefined;
    task: { at: number | null } | null;
  },
  now: number,
): { kind: "call" | "task"; at: number | null } | null {
  const callAt = deal.nextMeetingAt;
  const taskAt = deal.task?.at ?? null;
  if (
    callAt !== undefined &&
    callAt !== null &&
    callAt >= now &&
    (taskAt === null || callAt <= taskAt)
  )
    return { kind: "call", at: callAt };
  return deal.task ? { kind: "task", at: taskAt } : null;
}
