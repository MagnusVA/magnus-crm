export const MATCH_LABELS = {
  email: "email",
  phone: "phone",
  social_handle: "Instagram handle",
} as const;

export const RESOLUTION_LABELS = {
  merged: "Merged into one person",
  kept_separate: "Kept as different people",
  booking_applied: "Booking added after a retry",
} as const;

export const IDENTIFIER_SOURCE_LABELS: Record<string, string> = {
  calendly_booking: "Calendly booking",
  manual_entry: "Entered by hand",
  merge: "Merge",
  side_deal: "Side deal",
  slack_qualified: "Slack qualification",
  lead_gen: "Lead gen capture",
  dm_portal: "DM portal",
};
