import * as XLSX from "xlsx-js-style";
import type { ScalarRecord } from "../../convex/operations/reports/contracts";
import { buildLeadGenWorkbook, type LeadGenExcelReportData } from "./lead-gen-workbook";

type TeamContext = { teamKey: string; summary: ScalarRecord; workers: ScalarRecord[]; origins: ScalarRecord[]; sources: ScalarRecord[] };
const number = (row: ScalarRecord, key: string) => typeof row[key] === "number" ? row[key] : 0;
const nullableNumber = (row: ScalarRecord, key: string) => typeof row[key] === "number" ? row[key] : null;
const label = (row: ScalarRecord, key: string, fallback = "") => typeof row[key] === "string" ? row[key] : fallback;
const metrics = (row: ScalarRecord) => ({ submissions: number(row, "submissions"), uniqueProspects: number(row, "uniqueProspects"), duplicates: number(row, "duplicates"), scheduledHours: number(row, "scheduledHours"), leadsPerHour: nullableNumber(row, "leadsPerHour") });
const worker = (row: ScalarRecord) => ({ ...metrics(row), displayName: label(row, "workerLabel", "Unknown specialist"), email: label(row, "workerEmail"), teamName: label(row, "teamLabel", "No Team"), isActive: row.isActive === true });
const source = (row: ScalarRecord): "instagram" | "meta_business" => row.source === "meta_business" ? "meta_business" : "instagram";
const origin = (row: ScalarRecord) => ({ originKind: row.originKind === "reel" ? "reel" as const : "post" as const, originValue: label(row, "originValue"), source: source(row), uniqueProspects: number(row, "uniqueProspects"), submissions: number(row, "submissions"), dayCount: number(row, "dayCount") });

export function renderLeadGenExport(args: {
  generatedAt: number; startDate: string; endDate: string; sourceFilter: "all" | "instagram" | "meta_business"; part?: number;
  rows: { section: string; payload: ScalarRecord }[]; teams: TeamContext[];
}): Uint8Array {
  const data: LeadGenExcelReportData = {
    generatedAt: args.generatedAt, reportTitle: `Lead Gen Performance${args.part ? ` · Part ${args.part}` : ""}`,
    filters: { startDayKey: args.startDate, endDayKey: args.endDate, source: args.sourceFilter === "all" ? null : args.sourceFilter, teamName: null, workerName: null },
    sheets: args.teams.map(team => {
      const rows = args.rows.filter(row => String(row.payload.teamId ?? "unassigned") === team.teamKey);
      const teamLabel = label(team.summary, "label", rows.map(row => label(row.payload, "teamLabel")).find(Boolean) ?? "No Team");
      return { sheetKey: team.teamKey, sheetName: teamLabel, scopeKind: "team", scopeLabel: teamLabel,
        summary: metrics(team.summary), topLeadGenerators: team.workers.map(worker), topPosts: team.origins.map(origin),
        workerPerformance: rows.filter(row => row.section === "lead_gen_team_worker").map(row => worker(row.payload)),
        sourcePerformance: team.sources.map(row => ({ ...metrics(row), source: source(row) })),
        postDetail: rows.filter(row => row.section === "lead_gen_team_origin").map(row => origin(row.payload)),
      };
    }),
  };
  if (data.sheets.length === 0) data.sheets.push({ sheetKey: "empty", sheetName: "No Activity", scopeKind: "team", scopeLabel: "No activity", summary: metrics({}), topLeadGenerators: [], topPosts: [], workerPerformance: [], sourcePerformance: [], postDetail: [] });
  const workbook = buildLeadGenWorkbook(data);
  workbook.Props = { CreatedDate: new Date(args.generatedAt) };
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellStyles: true, compression: true }));
}
