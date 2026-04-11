export type ReminderUrgency = "normal" | "amber" | "red";

/**
 * Determine the visual urgency level of a reminder based on current time.
 *
 * - normal: reminderScheduledAt is more than 0ms in the future
 * - amber:  reminderScheduledAt has been reached (within the first 60 seconds)
 * - red:    reminderScheduledAt is more than 60 seconds in the past (overdue)
 *
 * The caller runs this on a client-side interval (e.g., every 30 seconds)
 * so the UI escalates in real time without any server-side scheduling.
 */
export function getReminderUrgency(
  reminderScheduledAt: number,
  now: number
): ReminderUrgency {
  if (now < reminderScheduledAt) return "normal";
  if (now >= reminderScheduledAt && now < reminderScheduledAt + 60_000)
    return "amber";
  return "red";
}

/**
 * Returns Tailwind classes for the urgency level.
 * Uses border + subtle background tint for visual escalation.
 * Does NOT rely on color alone — the urgency Badge label also changes.
 */
export function getUrgencyStyles(urgency: ReminderUrgency): string {
  switch (urgency) {
    case "normal":
      return "border-border";
    case "amber":
      return "border-amber-500 bg-amber-50 dark:bg-amber-950/20";
    case "red":
      return "border-red-500 bg-red-50 dark:bg-red-950/20";
  }
}
