import type { AnyReportDefinition } from "./definition";
import { apiReports } from "./api/metrics";
import { attributionReports } from "./definitions/attribution";
import { callsReports } from "./definitions/calls";
import { leadGenReports } from "./definitions/leadGen";
import { operationsReports } from "./definitions/operations";
import { overviewReports } from "./definitions/overview";
import { peopleCloserReports } from "./definitions/people";
import { peopleRoleReports } from "./definitions/peopleRoles";
import { pipelineReports } from "./definitions/pipeline";
import { revenueReports } from "./definitions/revenue";
import { scorecardReports } from "./definitions/scorecard";

// Every report ClickHouse can answer. Add a page's definitions here.
const definitions: readonly AnyReportDefinition[] = [
  ...apiReports,
  ...attributionReports,
  ...callsReports,
  ...leadGenReports,
  ...operationsReports,
  ...overviewReports,
  ...peopleCloserReports,
  ...peopleRoleReports,
  ...pipelineReports,
  ...revenueReports,
  ...scorecardReports,
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
