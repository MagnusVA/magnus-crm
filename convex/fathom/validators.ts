import { v } from "convex/values";
import { z } from "zod";

export const actionItem = v.object({
  description: v.string(),
  assigneeEmail: v.optional(v.string()),
  timestamp: v.optional(v.string()),
});
export const transcriptLine = v.object({
  speaker: v.string(),
  email: v.optional(v.string()),
  timestamp: v.string(),
  text: v.string(),
});
export type TranscriptLine = {
  speaker: string;
  email?: string;
  timestamp: string;
  text: string;
};
export const member = v.object({
  email: v.string(),
  name: v.optional(v.string()),
  viewAccessLevel: v.optional(v.string()),
  settingsAccessLevel: v.optional(v.string()),
});
export const recordingInput = v.object({
  fathomRecordingId: v.number(),
  recordedByEmail: v.string(),
  url: v.string(),
  shareUrl: v.string(),
  title: v.string(),
  meetingTitle: v.optional(v.string()),
  meetingUrl: v.optional(v.string()),
  scheduledStartAt: v.optional(v.number()),
  scheduledEndAt: v.optional(v.number()),
  recordingStartAt: v.number(),
  recordingEndAt: v.number(),
  inviteeEmails: v.array(v.string()),
  hasExternalInvitee: v.boolean(),
  summaryMarkdown: v.optional(v.string()),
  actionItems: v.array(actionItem),
  transcriptLanguage: v.optional(v.string()),
});

// Payload shapes: https://developers.fathom.ai/api-reference/meetings/list-meetings
// and https://developers.fathom.ai/api-reference/recordings/get-transcript.
const timestamp = z.string().datetime({ offset: true }).transform(Date.parse);
const speaker = z.object({
  display_name: z.string(),
  matched_calendar_invitee_email: z.string().nullish(),
});
const transcript = z.array(
  z.object({ speaker, timestamp: z.string(), text: z.string() }),
);
export const summarySchema = z.object({
  markdown_formatted: z.string().nullish(),
});
export const meetingSchema = z.object({
  recording_id: z.number().int().nonnegative(),
  recorded_by: z.object({ email: z.string() }),
  url: z.string().url(),
  share_url: z.string().url(),
  title: z.string(),
  meeting_title: z.string().nullish(),
  meeting_url: z.string().nullish(),
  scheduled_start_time: timestamp.nullish(),
  scheduled_end_time: timestamp.nullish(),
  recording_start_time: timestamp,
  recording_end_time: timestamp,
  calendar_invitees_domains_type: z.enum([
    "only_internal",
    "one_or_more_external",
  ]),
  calendar_invitees: z.array(
    z.object({ email: z.string().nullish(), is_external: z.boolean() }),
  ),
  transcript_language: z.string().nullish(),
  transcript: transcript.nullish(),
  default_summary: summarySchema.nullish(),
  action_items: z
    .array(
      z.object({
        description: z.string(),
        assignee: z.object({ email: z.string().nullish() }).nullish(),
        recording_timestamp: z.string().nullish(),
      }),
    )
    .nullish(),
});
export type FathomMeeting = z.infer<typeof meetingSchema>;
export function parseTranscript(input: unknown): TranscriptLine[] {
  return transcript.parse(input).map((line) => ({
    speaker: line.speaker.display_name,
    ...(line.speaker.matched_calendar_invitee_email
      ? { email: line.speaker.matched_calendar_invitee_email.toLowerCase() }
      : {}),
    timestamp: line.timestamp,
    text: line.text,
  }));
}
export function recordingFields(data: FathomMeeting) {
  return {
    fathomRecordingId: data.recording_id,
    recordedByEmail: data.recorded_by.email.trim().toLowerCase(),
    url: data.url,
    shareUrl: data.share_url,
    title: data.title,
    meetingTitle: data.meeting_title ?? undefined,
    meetingUrl: data.meeting_url ?? undefined,
    scheduledStartAt: data.scheduled_start_time ?? undefined,
    scheduledEndAt: data.scheduled_end_time ?? undefined,
    recordingStartAt: data.recording_start_time,
    recordingEndAt: data.recording_end_time,
    inviteeEmails: data.calendar_invitees.flatMap((i) =>
      i.email ? [i.email.trim().toLowerCase()] : [],
    ),
    hasExternalInvitee:
      data.calendar_invitees_domains_type === "one_or_more_external" &&
      data.calendar_invitees.some((i) => i.is_external),
    summaryMarkdown: data.default_summary?.markdown_formatted ?? undefined,
    actionItems: (data.action_items ?? []).map((i) => ({
      description: i.description,
      assigneeEmail: i.assignee?.email ?? undefined,
      timestamp: i.recording_timestamp ?? undefined,
    })),
    transcriptLanguage: data.transcript_language ?? undefined,
  };
}
