"use node";

import { createHash, randomUUID } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";
import { ReportAggregate, ReportSizeLimit } from "./aggregate";
import type { ReportSourcePage } from "./model";
import { sourcesForReport } from "./sources";
import { reduceReportSourcePage } from "./reducers";
import {
  exportSections,
  exportSectionDefinition,
  reportTitles,
} from "../../../lib/operations-reports/presentation";
import {
  MAX_ARTIFACT_BYTES,
  assertRenderBudget,
  type ReportColumn,
  type ReportDocument,
} from "../../../lib/operations-reports/document";
import { renderCsv } from "../../../lib/operations-reports/csv";
import { renderReportPdf } from "../../../lib/operations-reports/pdf";
import { renderReportWorkbook } from "../../../lib/operations-reports/xlsx";
import { renderLeadGenExport } from "../../../lib/operations-reports/lead-gen-export";
import { summaryCards } from "../../../lib/operations-reports/summary";

const jobs = internal.operations.reports.jobs;
const MAX_WORK_MS = 8 * 60_000;

export const run = internalAction({
  args: { jobId: v.id("operationsReportJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const workerId = randomUUID();
    const claim = await ctx.runMutation(jobs.claimJob, { jobId, workerId });
    if (claim.kind !== "claimed") return null;
    const fence = { jobId, workerId, leaseGeneration: claim.leaseGeneration };
    const started = Date.now();
    try {
      const job = await ctx.runQuery(jobs.getJobState, { jobId });
      if (!job?.format) return null;
      let sequence = job.checkpointSequence;
      const existing = await ctx.runQuery(jobs.getArtifactForRender, {
        jobId,
        partNumber: 1,
      });
      // Recovery may have attached a completed upload after the original worker died.
      if (existing?.storageId) {
        await ctx.runMutation(jobs.completeJob, {
          ...fence,
          expectedSequence: sequence,
          commitKey: `complete:${sequence}`,
          expectedArtifactCount: 1,
        });
        return null;
      }
      const sections = exportSections(job.reportKind, job.format);
      const csv = job.format.endsWith("csv");
      const raw = job.format === "raw_csv" || job.format === "payments_csv";
      const columns: ReportColumn[] = [
        { key: "report", label: "Report" },
        { key: "rowKind", label: "RowKind" },
        { key: "rangeStart", label: "RangeStart" },
        { key: "rangeEnd", label: "RangeEndInclusive" },
        { key: "boundary", label: "DateBoundary" },
        { key: "sourceFilter", label: "SourceFilter" },
        { key: "generatedAt", label: "GeneratedAt", format: "timestamp" },
        { key: "definitionVersion", label: "DefinitionVersion" },
      ];
      const seen = new Set(columns.map((c) => c.key));
      for (const section of sections)
        for (const column of exportSectionDefinition(section, job.format)!
          .columns)
          if (!seen.has(column.key)) {
            seen.add(column.key);
            columns.push(column);
          }
      const generatedAt = job.startedAt ?? job.createdAt;
      const chunks: Uint8Array[] = csv ? [renderCsv(columns, [])] : [];
      let csvBytes = chunks[0]?.byteLength ?? 0;
      let rowCount = 0;
      const appendCsv = (
        section: string,
        rows: Record<string, string | number | boolean | null>[],
      ) => {
        const encoded = renderCsv(
          columns,
          rows.map((row) => ({
            ...row,
            report: job.reportKind,
            rowKind: section,
            rangeStart: job.range.startBusinessDate,
            rangeEnd: job.range.endBusinessDateInclusive,
            boundary: job.range.boundary,
            sourceFilter: job.sourceFilter,
            generatedAt,
            definitionVersion: job.definitionVersion,
          })),
          false,
        );
        csvBytes += encoded.byteLength;
        if (csvBytes > MAX_ARTIFACT_BYTES) throw new ReportSizeLimit();
        chunks.push(encoded);
        rowCount += rows.length;
      };
      const aggregate = new ReportAggregate();
      let rowsProcessed = 0;
      let pagesProcessed = 0;
      let lastProgress = started;
      for (const sourceKey of sourcesForReport(job)) {
        let cursor: string | null = null;
        for (;;) {
          if (
            Date.now() - started > MAX_WORK_MS ||
            process.memoryUsage().rss > 400 * 1024 * 1024
          )
            throw new ReportSizeLimit();
          const page: ReportSourcePage = await ctx.runQuery(
            internal.operations.reports.readers.readReportSourcePage,
            {
              tenantId: job.tenantId,
              reportKind: job.reportKind,
              sourceKey,
              startTimestamp: job.range.startTimestamp,
              endTimestampExclusive: job.range.endTimestampExclusive,
              startDayKey: job.range.startDayKey,
              endDayKeyExclusive: job.range.endDayKeyExclusive,
              sourceFilter: job.sourceFilter,
              teamId: null,
              workerId: null,
              cursor,
            },
          );
          const contributions = reduceReportSourcePage({
            sourceKey,
            range: job.range,
            rows: page.page,
          });
          if (raw) {
            aggregate.apply(
              contributions.filter((c) => c.section.endsWith("_dimension")),
            );
            const ledger = new ReportAggregate();
            for (const [name, rows] of aggregate.sections)
              ledger.sections.set(name, rows);
            ledger.apply(
              contributions.filter((c) => sections.includes(c.section)),
            );
            const pageRows = await ledger.finalize(
              job.reportKind,
              job.range,
              sections,
            );
            for (const section of sections) {
              const rows = pageRows
                .filter((row) => row.section === section)
                .map((row) => row.payload);
              if (rows.length) appendCsv(section, rows);
            }
          } else
            aggregate.apply(
              contributions.filter((c) => !c.section.startsWith("raw_")),
            );
          rowsProcessed += page.rowsRead;
          pagesProcessed++;
          if (Date.now() - lastProgress >= 10_000 || page.isDone) {
            if (
              !(
                await ctx.runMutation(jobs.updateExportProgress, {
                  ...fence,
                  rowsProcessed,
                  pagesProcessed,
                })
              ).updated
            )
              return null;
            lastProgress = Date.now();
          }
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
      }
      const results = raw
        ? []
        : await aggregate.finalize(job.reportKind, job.range);
      // Finalized rows own their payloads; discard dimensions and dedupe state
      // before allocating the renderer and its output buffer.
      aggregate.release();
      const tables = sections.map((section) => ({
        ...exportSectionDefinition(section, job.format!)!,
        rows: results
          .filter((row) => row.section === section)
          .sort(
            (a, b) =>
              (b.sortValue ?? 0) - (a.sortValue ?? 0) ||
              a.rowKey.localeCompare(b.rowKey),
          )
          .map((row) => row.payload),
      }));
      const document: ReportDocument = {
        title: reportTitles[job.reportKind],
        period: job.range.label,
        generatedAt,
        boundary:
          job.range.boundary === "utc_day"
            ? "UTC days (00:00)"
            : "Honduras business days (01:00)",
        filters:
          job.sourceFilter === "all"
            ? "All sources"
            : `Source: ${job.sourceFilter}`,
        summary: summaryCards(
          job.reportKind,
          results.find(
            (row) =>
              row.section === `${job.reportKind.replaceAll("-", "_")}_summary`,
          )?.payload ?? {},
        ),
        tables,
      };
      const transition = await ctx.runMutation(jobs.beginRendering, {
        ...fence,
        expectedSequence: sequence,
        commitKey: `render:${sequence}`,
      });
      if (transition.kind === "stale") return null;
      sequence = transition.sequence;
      let bytes: Uint8Array;
      let mimeType: string;
      let extension: string;
      if (csv) {
        if (!raw)
          for (let i = 0; i < sections.length; i++)
            appendCsv(sections[i], tables[i].rows);
        bytes = new Uint8Array(Buffer.concat(chunks));
        mimeType = "text/csv;charset=utf-8";
        extension = "csv";
      } else {
        rowCount = tables.reduce((n, table) => n + table.rows.length, 0);
        assertRenderBudget(document, job.format === "pdf" ? "pdf" : "xlsx");
        if (job.format === "pdf") {
          bytes = await renderReportPdf(document);
          mimeType = "application/pdf";
          extension = "pdf";
        } else {
          if (job.reportKind === "lead-gen") {
            const teams = results
              .filter((row) => row.section === "lead_gen_team")
              .map((team) => {
                const top = (section: string, count: number) =>
                  results
                    .filter(
                      (row) =>
                        row.section === section && row.groupKey === team.rowKey,
                    )
                    .sort((a, b) => (b.sortValue ?? 0) - (a.sortValue ?? 0))
                    .slice(0, count)
                    .map((row) => row.payload);
                return {
                  teamKey: team.rowKey,
                  summary: team.payload,
                  workers: top("lead_gen_team_worker", 3),
                  origins: top("lead_gen_team_origin", 3),
                  sources: top("lead_gen_team_source", 2),
                };
              });
            bytes = renderLeadGenExport({
              generatedAt,
              startDate: job.range.startBusinessDate,
              endDate: job.range.endBusinessDateInclusive,
              sourceFilter: job.sourceFilter,
              rows: results.filter((row) => sections.includes(row.section)),
              teams,
            });
          } else bytes = renderReportWorkbook(document);
          mimeType =
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
          extension = "xlsx";
        }
      }
      if (
        bytes.byteLength > MAX_ARTIFACT_BYTES ||
        Date.now() - started > 9 * 60_000
      )
        throw new ReportSizeLimit();
      const filename = `${job.reportKind}-${job.format}-${job.range.startBusinessDate}-${job.range.endBusinessDateInclusive}.${extension}`;
      const reservation = await ctx.runMutation(jobs.reserveArtifact, {
        ...fence,
        expectedSequence: sequence,
        commitKey: `reserve:${sequence}`,
        partNumber: 1,
        filename,
        mimeType,
        expectedSha256: createHash("sha256").update(bytes).digest("base64"),
        expectedByteSize: bytes.byteLength,
        rowCount,
        ownershipToken: randomUUID().replaceAll("-", ""),
      });
      if (reservation.kind === "stale") return null;
      const storageId = await ctx.storage.store(
        new Blob([new Uint8Array(bytes)], {
          type: reservation.ownershipContentType,
        }),
      );
      const attached = await ctx.runMutation(jobs.attachArtifact, {
        ...fence,
        expectedSequence: reservation.sequence,
        commitKey: `attach:${reservation.sequence}`,
        artifactId: reservation.artifactId,
        storageId,
      });
      if (attached.kind === "stale") {
        await ctx.storage.delete(storageId);
        return null;
      }
      await ctx.runMutation(jobs.completeJob, {
        ...fence,
        expectedSequence: attached.sequence,
        commitKey: `complete:${attached.sequence}`,
        expectedArtifactCount: 1,
      });
      console.log("[Operations:Reports] export completed", {
        jobId,
        rowsProcessed,
        pagesProcessed,
        outputRows: rowCount,
        outputBytes: bytes.byteLength,
        durationMs: Date.now() - started,
        maxRssMb: process.resourceUsage().maxRSS / 1024,
      });
    } catch (error) {
      console.error("[Operations:Reports] export failed", {
        jobId,
        message: error instanceof Error ? error.message : String(error),
      });
      await ctx.runMutation(jobs.failJob, {
        ...fence,
        category:
          error instanceof ReportSizeLimit
            ? "resource_limit"
            : "processing_error",
        message:
          error instanceof ReportSizeLimit
            ? error.message
            : "The export could not be completed. Please retry.",
        retryable: !(error instanceof ReportSizeLimit),
      });
    }
    return null;
  },
});
