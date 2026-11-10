import { v } from "convex/values";
import { internalQuery } from "../../../_generated/server";
import { listProgramsForTenant } from "../../../tenantPrograms/shared";
import { buildCoverage } from "../../../bookingSetup/queriesCore";
import { buildSlackInstallationStatus } from "../../../slack/channelsCore";
import { buildFathomSettings } from "../../../fathom/connectionCore";
import { getTenantBusinessDay } from "../../../lib/tenantBusinessDay";
import {
  resolveSharedCell,
  resolveTeamCell,
  SCHEDULING_MODES,
} from "../../../lib/bookingSetup/coverage";
import {
  portalReadiness,
  isCalendlyBookable,
} from "../../../lib/eventTypeBookability";
import { readLiveQueryRows } from "../../../lib/liveQueryBounds";
import { mcpCallerValidator, requireMcpAdmin } from "../../guard";
import { text, textValidator, partialReason, fitRows } from "./common";
import { appLink } from "../prepare";

export const setupArea = v.union(
  v.literal("programs"),
  v.literal("event_types"),
  v.literal("coverage"),
  v.literal("slack_channels"),
  v.literal("business_day"),
  v.literal("goals"),
  v.literal("fathom_recorders"),
);
export const setupArgs = { area: setupArea };
const scalar = v.union(v.string(), v.number(), v.boolean(), v.null());
const entryValidator = v.object({
  id: v.string(),
  title: textValidator,
  state: v.string(),
  values: v.record(v.string(), scalar),
  allowedActions: v.array(v.string()),
  openInMagnus: v.string(),
});
type Entry = {
  id: string;
  title: ReturnType<typeof text>;
  state: string;
  values: Record<string, string | number | boolean | null>;
  allowedActions: string[];
  openInMagnus: string;
};
export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...setupArgs },
  returns: v.object({
    area: setupArea,
    items: v.array(entryValidator),
    isPartial: v.boolean(),
    reason: v.union(v.string(), v.null()),
    openInMagnus: v.string(),
  }),
  handler: async (ctx, { caller, area }) => {
    const me = await requireMcpAdmin(ctx, caller);
    let items: Entry[] = [],
      isPartial = false,
      editor = "/workspace/settings";
    const entry = (
      id: string,
      title: string,
      state: string,
      values: Entry["values"],
      path: string,
      by: Parameters<typeof text>[1] = "admin",
      allowedActions = ["magnus_setup"],
    ): Entry => ({
      id,
      title: text(title, by),
      state,
      values,
      allowedActions,
      openInMagnus: appLink(path),
    });
    if (area === "business_day") {
      const day = await getTenantBusinessDay(ctx, me.tenantId);
      items = [
        entry(
          "business_day",
          "Business day",
          "configured",
          { timeZone: day.timeZone, startHour: day.dayStartHour },
          editor,
        ),
      ];
    } else if (area === "programs") {
      editor = "/workspace/booking";
      const programs = await listProgramsForTenant(ctx, me.tenantId);
      items = programs.map((p) =>
        entry(
          p._id,
          p.name,
          p.archivedAt === undefined ? "active" : "archived",
          { currency: p.defaultCurrency ?? null },
          editor,
        ),
      );
      isPartial = programs.length >= 200;
    } else if (area === "event_types") {
      editor = "/workspace/booking/event-types";
      const scan = await readLiveQueryRows(
        ctx.db
          .query("eventTypeConfigs")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", me.tenantId)),
        500,
      );
      // Unsorted first, with the same filing inputs as the booking inbox.
      const status = (c: (typeof scan.rows)[number]) =>
        c.notSalesCallAt !== undefined
          ? "not_sales_call"
          : c.bookingProgramId && c.bookingProgramMappingStatus === "mapped"
            ? "sorted"
            : isCalendlyBookable(c)
              ? "unsorted"
              : "gone";
      items = scan.rows
        .sort(
          (a, b) =>
            Number(status(b) === "unsorted") - Number(status(a) === "unsorted"),
        )
        .map((c) =>
          entry(
            c._id,
            c.displayName,
            status(c),
            {
              readiness: portalReadiness(c),
              programId: c.bookingProgramId ?? null,
              durationMinutes: c.calendlyDurationMinutes ?? null,
              synced: c.calendlySyncStatus ?? null,
            },
            editor,
            "integration",
          ),
        );
      isPartial = scan.capped;
    } else if (area === "coverage") {
      editor = "/workspace/booking";
      const c = await buildCoverage(ctx, me.tenantId);
      isPartial =
        c.programs.length >= 200 ||
        c.teams.length >= 200 ||
        c.eventTypes.length >= 500 ||
        c.teamRoutes.length >= 2000 ||
        c.sharedRoutes.length >= 400;
      const activePrograms = c.programs.filter(
        (p) => p.archivedAt === undefined,
      );
      const eventTypes = new Map(c.eventTypes.map((e) => [String(e._id), e]));
      cells: for (const program of activePrograms) {
        for (const mode of SCHEDULING_MODES) {
          const shared = c.sharedRoutes.find(
            (r) => r.programId === program._id && r.mode === mode,
          );
          const resolved = resolveSharedCell(shared, eventTypes);
          const sharedIssue =
            resolved.kind === "none" ? resolved.reason : resolved.issue;
          items.push(
            entry(
              `shared:${program._id}:${mode}`,
              program.name,
              sharedIssue ? "gap" : "configured",
              {
                programId: program._id,
                mode,
                issue: sharedIssue,
                eventTypeId:
                  resolved.kind === "none" ? null : resolved.eventTypeConfigId,
              },
              editor,
            ),
          );
          for (const team of c.teams.filter((t) => t.isActive)) {
            const own = c.teamRoutes.find(
              (r) =>
                r.teamId === team._id &&
                r.programId === program._id &&
                r.mode === mode,
            );
            const cell = resolveTeamCell({
              usesShared: team.usesShared,
              ownRoute: own,
              sharedRoute: shared,
              eventTypesById: eventTypes,
            });
            const issue = cell.kind === "none" ? cell.reason : cell.issue;
            items.push(
              entry(
                `${team._id}:${program._id}:${mode}`,
                `${team.displayName}: ${program.name}`,
                issue === "not_offered"
                  ? "not_offered"
                  : issue
                    ? "gap"
                    : "configured",
                {
                  teamId: team._id,
                  programId: program._id,
                  mode,
                  issue,
                  source: cell.kind,
                  eventTypeId:
                    cell.kind === "none" ? null : cell.eventTypeConfigId,
                },
                editor,
              ),
            );
            if (items.length >= 500) {
              isPartial = true;
              break cells;
            }
          }
        }
      }
      items.sort(
        (a, b) => Number(b.state === "gap") - Number(a.state === "gap"),
      );
    } else if (area === "slack_channels") {
      const s = await buildSlackInstallationStatus(ctx, me.tenantId);
      if (s.kind === "connected") {
        for (const [key, id, name, error] of [
          [
            "sales",
            s.notifyChannelId,
            s.notifyChannelName,
            s.notifyChannelError,
          ],
          [
            "stale_reminders",
            s.staleReminderChannelId,
            s.staleReminderChannelName,
            s.staleReminderChannelError,
          ],
          [
            "lead_gen",
            s.leadGenNotifyChannelId,
            s.leadGenNotifyChannelName,
            s.leadGenNotifyChannelError,
          ],
          [
            "booking_reviews",
            s.bookingReviewChannelId,
            s.bookingReviewChannelName,
            s.bookingReviewChannelError,
          ],
          [
            "end_of_day",
            s.eodReportChannelId,
            s.eodReportChannelName,
            s.eodReportChannelError,
          ],
        ] as const)
          items.push(
            entry(
              key,
              name ?? "No channel selected",
              error ? "delivery_error" : id ? "configured" : "not_configured",
              {
                purpose: key,
                channelId: id ?? null,
                installationStatus: s.status,
              },
              editor,
              "integration",
            ),
          );
      } else items = [entry("slack", "Slack", "not_connected", {}, editor)];
    } else if (area === "goals") {
      editor = "/workspace/team/goals";
      const actions = [
        "magnus_setup",
        ...(me.writeFamilies.includes("goals") ? ["magnus_set_goal"] : []),
      ];
      items.push(
        entry(
          "qualifications",
          "Daily qualifications goal",
          me.tenant.slackQualificationDailyTeamQuota === undefined
            ? "not_configured"
            : "configured",
          { value: me.tenant.slackQualificationDailyTeamQuota ?? null },
          editor,
          "admin",
          actions,
        ),
      );
      const teams = await readLiveQueryRows(
        ctx.db
          .query("attributionTeams")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", me.tenantId)),
        200,
      );
      isPartial = teams.capped;
      items.push(
        ...teams.rows
          .filter((t) => t.isActive)
          .map((t) =>
            entry(
              t._id,
              t.displayName,
              t.bookingDailyQuota === undefined
                ? "not_configured"
                : "configured",
              { value: t.bookingDailyQuota ?? null },
              editor,
              "admin",
              actions,
            ),
          ),
      );
    } else {
      editor = "/workspace/settings/fathom";
      const f = await buildFathomSettings(ctx, me.tenantId);
      isPartial = f.capped;
      items = f.members
        .sort(
          (a, b) =>
            Number(!b.userId && !b.ignored) - Number(!a.userId && !a.ignored),
        )
        .map((m) =>
          entry(
            m.memberId,
            m.name ?? "Unnamed recorder",
            m.ignored ? "ignored" : m.userId ? "linked" : "unlinked",
            { userId: m.userId ?? null, ignored: m.ignored },
            editor,
            "integration",
            [
              "magnus_setup",
              ...(!m.ignored &&
              !m.userId &&
              me.writeFamilies.includes("repairs")
                ? ["magnus_repair"]
                : []),
            ],
          ),
        );
    }
    isPartial ||= items.length > 25;
    const fitted = fitRows(items.slice(0, 25));
    isPartial ||= fitted.capped;
    return {
      area,
      items: fitted.rows,
      isPartial,
      reason: partialReason(isPartial),
      openInMagnus: appLink(editor),
    };
  },
});
