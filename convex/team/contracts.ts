import { v, type Infer } from "convex/values";

export const weekValidator = v.union(v.object({
  monday: v.number(), tuesday: v.number(), wednesday: v.number(), thursday: v.number(),
  friday: v.number(), saturday: v.number(), sunday: v.number(),
}), v.null());
const nullableString = v.union(v.string(), v.null());
export const nullableTeam = v.union(v.id("attributionTeams"), v.null());
export const directoryMemberValidator = v.object({
  key: v.string(), teamMemberId: v.union(v.id("teamMembers"), v.null()), name: v.string(),
  login: v.union(v.object({
    userId: v.id("users"), name: v.string(), email: v.string(),
    role: v.union(v.literal("tenant_master"), v.literal("tenant_admin"), v.literal("closer"), v.literal("lead_generator")),
    isActive: v.boolean(), removed: v.boolean(), calendlyLinked: v.boolean(), invitationPending: v.boolean(), profilePictureUrl: nullableString,
  }), v.null()),
  leadGen: v.array(v.object({ workerId: v.id("leadGenWorkers"), name: v.string(), email: v.string(), teamId: nullableTeam,
    isActive: v.boolean(), week: weekValidator, weekChangedOn: nullableString })),
  slack: v.array(v.object({ slackUserId: v.string(), name: v.string(), handle: nullableString, isDeleted: v.boolean(),
    week: weekValidator, weekChangedOn: nullableString })),
  dmClosers: v.array(v.object({ dmCloserId: v.id("dmClosers"), name: v.string(), teamId: v.id("attributionTeams"),
    utmMedium: v.string(), isActive: v.boolean(), week: weekValidator, weekChangedOn: nullableString })),
});
export const directoryValidator = v.object({
  today: v.string(), members: v.array(directoryMemberValidator),
  teams: v.array(v.object({ teamId: v.id("attributionTeams"), name: v.string(), utmSource: v.string(), isActive: v.boolean(), bookingDailyQuota: v.union(v.number(), v.null()) })),
  capped: v.boolean(),
});
export type DirectoryMember = Infer<typeof directoryMemberValidator>;
export type Directory = Infer<typeof directoryValidator>;

export const reviewItemValidator = v.union(
  v.object({ kind: v.literal("same_human"), key: v.string(), members: v.array(v.id("teamMembers")),
    reasons: v.array(v.union(v.literal("same_email"), v.literal("same_name"), v.literal("same_team"))),
    into: v.id("teamMembers"), canJoin: v.boolean(), blockedReason: nullableString }),
  v.object({ kind: v.literal("slack_unlinked"), key: v.string(), slackUserId: v.string(), teamMemberId: v.id("teamMembers") }),
  v.object({ kind: v.literal("teams_disagree"), key: v.string(), teamMemberId: v.id("teamMembers"),
    leadGenTeamIds: v.array(nullableTeam), dmCloserTeamIds: v.array(v.id("attributionTeams")) }),
);
export type ReviewItem = Infer<typeof reviewItemValidator>;
export const previousTeamsValidator = v.object({
  leadGen: v.array(v.object({ workerId: v.id("leadGenWorkers"), teamId: nullableTeam })),
  dmClosers: v.array(v.object({ dmCloserId: v.id("dmClosers"), teamId: v.id("attributionTeams") })),
});
export type PreviousTeams = Infer<typeof previousTeamsValidator>;
export const slackPreviousValidator = v.object({ links: v.array(v.object({
  slackUserId: v.string(), teamMemberId: v.union(v.id("teamMembers"), v.null()),
  memberName: v.string(), crmUserId: v.union(v.id("users"), v.null()),
})) });
export type SlackPrevious = Infer<typeof slackPreviousValidator>;
