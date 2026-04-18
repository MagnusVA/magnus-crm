export const MAX_MEETING_DURATION_MS = 8 * 60 * 60 * 1000;
export const MIN_START_BEFORE_SCHEDULED_MS = 60 * 60 * 1000;

type ValidateManualTimesParams = {
  scheduledAt: number;
  manualStartedAt: number;
  manualStoppedAt: number;
  now: number;
};

/**
 * Validation helper for admin-entered meeting times during review resolution.
 * The client mirrors these rules, but the backend stays authoritative.
 */
export function validateManualTimes({
  scheduledAt,
  manualStartedAt,
  manualStoppedAt,
  now,
}: ValidateManualTimesParams): void {
  if (manualStartedAt >= manualStoppedAt) {
    throw new Error("Start time must be before end time.");
  }

  if (manualStartedAt < scheduledAt - MIN_START_BEFORE_SCHEDULED_MS) {
    throw new Error(
      "Start time cannot be more than 60 minutes before the scheduled time.",
    );
  }

  if (manualStoppedAt > now) {
    throw new Error("End time cannot be in the future.");
  }

  if (manualStoppedAt - manualStartedAt > MAX_MEETING_DURATION_MS) {
    throw new Error("Meeting duration cannot exceed 8 hours.");
  }
}
