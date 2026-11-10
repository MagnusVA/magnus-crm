import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { expectedError } from "../lib/observability/errors";
import { isActiveLogin } from "../lib/teamMembers";
import type { ReviewItem } from "./contracts";
import { readTeamRecords } from "./data";
import { normalizedName } from "./review";
export async function buildTeamReview(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const [data, decisions] = await Promise.all([
    readTeamRecords(ctx, tenantId),
    ctx.db
      .query("teamReviewDecisions")
      .withIndex("by_tenantId_and_key", (q) => q.eq("tenantId", tenantId))
      .take(2001),
  ]);
  if (data.capped || decisions.length > 2000)
    throw expectedError(
      "team.rejected",
      "This team is too large to review at once.",
    );
  const dismissed = new Set(decisions.map((row) => row.key));
  const groups = data.members
    .map((member) => {
      const users = data.users.filter((row) => row.teamMemberId === member._id);
      const leadGen = data.leadGen.filter(
        (row) => row.teamMemberId === member._id,
      );
      const slack = data.slack.filter((row) => row.teamMemberId === member._id);
      const dmClosers = data.dmClosers.filter(
        (row) => row.teamMemberId === member._id,
      );
      return {
        member,
        users,
        leadGen,
        slack,
        dmClosers,
        activeLogin: users.some(isActiveLogin),
        records:
          users.length + leadGen.length + slack.length + dmClosers.length,
        emails: new Set(
          [...users, ...leadGen]
            .map((row) => row.email.trim().toLowerCase())
            .filter(Boolean),
        ),
        names: new Set(
          [
            member.displayName,
            ...users.map((row) => row.fullName ?? ""),
            ...leadGen.map((row) => row.displayName ?? ""),
            ...dmClosers.map((row) => row.displayName),
            ...slack.flatMap((row) => [
              row.realName ?? "",
              row.displayName ?? "",
            ]),
          ]
            .map(normalizedName)
            .filter(Boolean),
        ),
        teams: new Set([
          ...leadGen.flatMap((row) => (row.teamId ? [row.teamId] : [])),
          ...dmClosers.map((row) => row.teamId),
        ]),
      };
    })
    .filter((group) => group.records > 0)
    .sort((a, b) => a.member._id.localeCompare(b.member._id));
  const items: ReviewItem[] = [];
  for (let i = 0; i < groups.length; i++) {
    const a = groups[i];
    for (const b of groups.slice(i + 1)) {
      const sameEmail = [...a.emails].some((email) => b.emails.has(email));
      const sameName = [...a.names].some((name) => b.names.has(name));
      if (!sameEmail && !sameName) continue;
      const reasons: Array<"same_email" | "same_name" | "same_team"> = [];
      if (sameEmail) reasons.push("same_email");
      if (sameName) reasons.push("same_name");
      if ([...a.teams].some((team) => b.teams.has(team)))
        reasons.push("same_team");
      // Keep the active login; then the member with more than Slack (a Slack
      // user is the easiest record to move); then more records.
      const beyondSlack = (group: typeof a) =>
        group.records - group.slack.length;
      const into =
        a.activeLogin !== b.activeLogin
          ? a.activeLogin
            ? a
            : b
          : beyondSlack(a) !== beyondSlack(b)
            ? beyondSlack(a) > beyondSlack(b)
              ? a
              : b
            : a.records >= b.records
              ? a
              : b;
      const blocked = a.activeLogin && b.activeLogin;
      items.push({
        kind: "same_human",
        key: `same_human:${a.member._id}:${b.member._id}`,
        members: [a.member._id, b.member._id],
        reasons,
        into: into.member._id,
        canJoin: !blocked,
        blockedReason: blocked
          ? "Both members have an active login. Remove one login before joining them."
          : null,
      });
    }
    if (!a.users.length && !a.leadGen.length && !a.dmClosers.length) {
      for (const slack of a.slack)
        if (!slack.isBot && !slack.isDeleted)
          items.push({
            kind: "slack_unlinked",
            key: `slack_only:${slack.slackUserId}`,
            slackUserId: slack.slackUserId,
            teamMemberId: a.member._id,
          });
    }
    const leadGenTeamIds = [
      ...new Set(a.leadGen.map((row) => row.teamId ?? null)),
    ];
    const dmCloserTeamIds = [...new Set(a.dmClosers.map((row) => row.teamId))];
    const all = [
      ...new Set(
        [...leadGenTeamIds, ...dmCloserTeamIds].map((id) => id ?? "none"),
      ),
    ].sort();
    if (leadGenTeamIds.length && dmCloserTeamIds.length && all.length > 1)
      items.push({
        kind: "teams_disagree",
        key: `teams:${a.member._id}:${all.join(":")}`,
        teamMemberId: a.member._id,
        leadGenTeamIds,
        dmCloserTeamIds,
      });
  }
  const visible = items.filter((item) => !dismissed.has(item.key));
  if (visible.length > 2000)
    throw expectedError("team.rejected", "Too many matches to review at once.");
  return { items: visible, count: visible.length };
}
