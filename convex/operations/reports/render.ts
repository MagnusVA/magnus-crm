"use node";

import { createHash, randomUUID } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction, type ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { renderCsv } from "../../../lib/operations-reports/csv";
import { renderReportPdf } from "../../../lib/operations-reports/pdf";
import { renderReportWorkbook } from "../../../lib/operations-reports/xlsx";
import { renderLeadGenExport } from "../../../lib/operations-reports/lead-gen-export";
import { exportSectionDefinition, exportSections, reportTitles } from "../../../lib/operations-reports/presentation";
import { MAX_ARTIFACT_BYTES, MAX_PDF_ROWS, MAX_XLSX_ROWS, type ReportColumn, type ReportDocument, type ReportTable } from "../../../lib/operations-reports/document";
import { summaryCards } from "../../../lib/operations-reports/summary";
import type { ScalarRecord } from "./contracts";

type RenderPosition = { sectionIndex: number; cursor: string | null; partNumber: number };
const jobs = internal.operations.reports.jobs;

function decodePosition(cursor?: string): RenderPosition {
  if (!cursor) return { sectionIndex: 0, cursor: null, partNumber: 1 };
  const position: unknown = JSON.parse(cursor);
  if (!position || typeof position !== "object" || !("sectionIndex" in position) || !("cursor" in position) || !("partNumber" in position) ||
    !Number.isSafeInteger(position.sectionIndex) || !Number.isSafeInteger(position.partNumber) ||
    typeof position.sectionIndex !== "number" || position.sectionIndex < 0 || typeof position.partNumber !== "number" || position.partNumber < 1 ||
    (position.cursor !== null && typeof position.cursor !== "string")) throw new Error("Invalid export checkpoint.");
  return { sectionIndex: position.sectionIndex, cursor: position.cursor, partNumber: position.partNumber };
}

async function summaryForReport(ctx: ActionCtx, jobId: Id<"operationsReportJobs">, kind: string) {
  const result = await ctx.runQuery(jobs.listResultRowsInternal, { jobId, section: `${kind.replaceAll("-", "_")}_summary`, rowType: "result", paginationOpts: { cursor: null, numItems: 1, maximumRowsRead: 1, maximumBytesRead: 256 * 1024 } });
  return result.page[0]?.payload ?? {};
}

export const run = internalAction({
  args: { jobId: v.id("operationsReportJobs"), workerId: v.string(), leaseGeneration: v.number() },
  returns: v.null(),
  handler: async (ctx, fence): Promise<null> => {
    const job = await ctx.runQuery(jobs.getJobState, { jobId: fence.jobId });
    if (!job || job.status !== "rendering" || !job.format) return null;
    if (!(await ctx.runMutation(jobs.heartbeatLease, fence)).renewed) return null;
    let sequence = job.checkpointSequence;
    const checkpoint = await ctx.runQuery(jobs.getCheckpoint, { jobId: job.jobId, sourceKey: "render" });
    const position = decodePosition(checkpoint?.cursor);
    const partNumber = position.partNumber;
    const sections = exportSections(job.reportKind, job.format);
    const maxRows = job.format === "pdf" ? MAX_PDF_ROWS : job.format === "xlsx" ? MAX_XLSX_ROWS : 5_000;
    const tables: ReportTable[] = [];
    const rowKinds: string[] = [];
    let rowCount = 0;
    let inputBytes = 0;
    const leadGenWorkbook = job.reportKind === "lead-gen" && job.format === "xlsx";
    const teamKeys = new Set<string>();
    const workbookRows: { section: string; payload: ScalarRecord }[] = [];
    while (position.sectionIndex < sections.length && rowCount < maxRows) {
      const section = sections[position.sectionIndex];
      const definition = exportSectionDefinition(section, job.format);
      if (!definition) throw new Error(`Missing report section definition: ${section}`);
      const page = await ctx.runQuery(jobs.listResultRowsInternal, {
        jobId: job.jobId, section, rowType: "result",
        paginationOpts: { cursor: position.cursor, numItems: Math.min(leadGenWorkbook ? 10 : 50, maxRows - rowCount), maximumRowsRead: 50, maximumBytesRead: 256 * 1024 },
      });
      if (leadGenWorkbook) {
        const nextTeams = new Set(teamKeys);
        for (const row of page.page) nextTeams.add(section === "lead_gen_team" ? row.rowKey : String(row.payload.teamId ?? "unassigned"));
        if (nextTeams.size > 20 && rowCount > 0) break;
        for (const key of nextTeams) teamKeys.add(key);
      }
      const pageBytes = Buffer.byteLength(JSON.stringify(page.page));
      if (inputBytes + pageBytes > 3 * 1024 * 1024) {
        if (rowCount === 0) throw new Error("A report row exceeds the export input budget.");
        break;
      }
      inputBytes += pageBytes;
      let table = tables[tables.length - 1];
      if (!table || table.title !== definition.title) {
        table = { ...definition, rows: [] };
        tables.push(table);
        rowKinds.push(section);
      }
      table.rows.push(...page.page.map((row) => row.payload));
      if (leadGenWorkbook) workbookRows.push(...page.page.map(row => ({ section, payload: row.payload })));
      rowCount += page.page.length;
      position.cursor = page.continueCursor;
      if (page.isDone) { position.sectionIndex += 1; position.cursor = null; }
      if (!(await ctx.runMutation(jobs.heartbeatLease, fence)).renewed) return null;
    }
    const summary = await summaryForReport(ctx, job.jobId, job.reportKind);
    const document: ReportDocument = {
      title: reportTitles[job.reportKind], period: job.range.label, generatedAt: job.startedAt ?? job.createdAt,
      boundary: job.range.boundary === "utc_day" ? "UTC days (00:00)" : "Honduras business days (01:00)",
      filters: job.sourceFilter === "all" ? "All sources" : `Source: ${job.sourceFilter}`,
      part: partNumber, summary: summaryCards(job.reportKind, summary), tables,
    };
    const artifact = await ctx.runQuery(jobs.getArtifactForRender, { jobId: job.jobId, partNumber });
    if (artifact?.state === "reserved") throw new Error("An interrupted upload is being cleaned up. Request a fresh export.");
    if (!artifact?.storageId) {
      let bytes: Uint8Array;
      let mimeType: string;
      let extension: string;
      if (job.format === "pdf") {
        bytes = await renderReportPdf(document); mimeType = "application/pdf"; extension = "pdf";
      } else if (job.format === "xlsx") {
        if (leadGenWorkbook) {
          const teams = [];
          for (const teamKey of teamKeys) {
            teams.push({ teamKey, ...await ctx.runQuery(internal.operations.reports.workbookContext.readTeam, { jobId: job.jobId, teamKey }) });
            if (!(await ctx.runMutation(jobs.heartbeatLease, fence)).renewed) return null;
          }
          bytes = renderLeadGenExport({ generatedAt: document.generatedAt, startDate: job.range.startBusinessDate, endDate: job.range.endBusinessDateInclusive, sourceFilter: job.sourceFilter, part: partNumber, rows: workbookRows, teams });
        } else bytes = renderReportWorkbook(document);
        mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; extension = "xlsx";
      } else {
        const columns: ReportColumn[] = [
          { key: "report", label: "Report" }, { key: "rowKind", label: "RowKind" }, { key: "rangeStart", label: "RangeStart" }, { key: "rangeEnd", label: "RangeEndInclusive" },
          { key: "boundary", label: "DateBoundary" }, { key: "sourceFilter", label: "SourceFilter" }, { key: "generatedAt", label: "GeneratedAt", format: "timestamp" }, { key: "definitionVersion", label: "DefinitionVersion" },
        ];
        const seen = new Set(columns.map((column) => column.key));
        for (const table of tables) for (const column of table.columns) if (!seen.has(column.key)) { seen.add(column.key); columns.push(column); }
        bytes = renderCsv(columns, tables.flatMap((table, index) => table.rows.map((row) => ({ ...row, report: job.reportKind, rowKind: rowKinds[index], rangeStart: job.range.startBusinessDate, rangeEnd: job.range.endBusinessDateInclusive, boundary: job.range.boundary, sourceFilter: job.sourceFilter, generatedAt: document.generatedAt, definitionVersion: job.definitionVersion }))));
        mimeType = "text/csv;charset=utf-8"; extension = "csv";
      }
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("Export part exceeds the 16 MiB output budget.");
      if (!(await ctx.runMutation(jobs.heartbeatLease, fence)).renewed) return null;
      const filename = `${job.reportKind}-${job.format}-${job.range.startBusinessDate}-${job.range.endBusinessDateInclusive}-part-${String(partNumber).padStart(3, "0")}.${extension}`;
      const reservation = await ctx.runMutation(jobs.reserveArtifact, { ...fence, expectedSequence: sequence, commitKey: `reserve:${partNumber}`, partNumber, filename, mimeType, expectedSha256: createHash("sha256").update(bytes).digest("base64"), expectedByteSize: bytes.byteLength, rowCount, ownershipToken: randomUUID().replaceAll("-", "") });
      if (reservation.kind === "stale") return null;
      sequence = reservation.sequence;
      const storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: reservation.ownershipContentType }));
      const attached = await ctx.runMutation(jobs.attachArtifact, { ...fence, expectedSequence: sequence, commitKey: `attach:${partNumber}`, artifactId: reservation.artifactId, storageId });
      if (attached.kind === "stale") { await ctx.storage.delete(storageId); return null; }
      sequence = attached.sequence;
    }
    position.partNumber += 1;
    const done = position.sectionIndex >= sections.length;
    const committed = await ctx.runMutation(jobs.commitCheckpoint, { ...fence, expectedSequence: sequence, commitKey: `rendered:${partNumber}`, sourceKey: "render", cursor: JSON.stringify(position), completed: done, rowsProcessed: 0, contributions: [], scheduleNext: !done });
    if (committed.kind === "stale") return null;
    if (done) await ctx.runMutation(jobs.completeJob, { ...fence, expectedSequence: committed.sequence, commitKey: `complete:${committed.sequence}`, expectedArtifactCount: partNumber });
    return null;
  },
});
