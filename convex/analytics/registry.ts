import type { AnyReportDefinition } from "./definition";
import { apiReports } from "./api/metrics";
import { activityReports } from "./definitions/activity";
import { leadGenReports } from "./definitions/leadGen";
import { leadsReports } from "./definitions/leads";
import { operationsReports } from "./definitions/operations";
import { pipelineReports } from "./definitions/pipeline";
import { remindersReports } from "./definitions/reminders";
import { revenueReports } from "./definitions/revenue";
import { slackQualificationReports } from "./definitions/slackQualifications";
import { teamReports } from "./definitions/team";

// Every report ClickHouse can answer. Add a page's definitions here.
const definitions: readonly AnyReportDefinition[] = [
  ...apiReports,
  ...activityReports,
  ...leadGenReports,
  ...leadsReports,
  ...operationsReports,
  ...pipelineReports,
  ...remindersReports,
  ...revenueReports,
  ...slackQualificationReports,
  ...teamReports,
];

const byId = new Map(definitions.map((definition) => [definition.id, definition]));
if (byId.size !== definitions.length) {
  throw new Error("Two analytics reports share an id.");
}

export function findReportDefinition(reportId: string): AnyReportDefinition | null {
  return byId.get(reportId) ?? null;
}

export function getReportDefinition(reportId: string): AnyReportDefinition {
  const definition = byId.get(reportId);
  if (!definition) throw new Error(`Unknown analytics report ${reportId}.`);
  return definition;
}

export function listReportDefinitions(): readonly AnyReportDefinition[] {
  return definitions;
}
