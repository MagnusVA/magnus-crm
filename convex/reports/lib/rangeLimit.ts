import { expectedError } from "../../lib/observability/errors";

/**
 * A range holding more than one live read may load. The person picked the
 * range and can pick a shorter one, so it's a rejection with a code: the
 * report page shows the sentence, and the assistant's report tool answers
 * `range_too_large` (convex/mcp/reports/tools.ts).
 *
 * It's `expectedError`, not `rejectRequest`: these throw inside queries,
 * which don't log.
 */
export const RANGE_TOO_LARGE_CODE = "reports.range_too_large";
export const rangeTooLarge = () => expectedError(RANGE_TOO_LARGE_CODE, "Choose a shorter range");
