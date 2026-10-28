import type { AnyReportDefinition } from "./definition";
import { apiReports } from "./api/metrics";
import { operationsReports } from "./definitions/operations";
import { revenueReports } from "./definitions/revenue";

// Every report ClickHouse can answer. Add a page's definitions here.
const definitions: readonly AnyReportDefinition[] = [
  ...apiReports,
  ...operationsReports,
  ...revenueReports,
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
