"use client";

import * as XLSX from "xlsx-js-style";
import { buildLeadGenFilename, buildLeadGenWorkbook, type LeadGenExcelReportData } from "@/lib/operations-reports/lead-gen-workbook";

export type { LeadGenExcelReportData } from "@/lib/operations-reports/lead-gen-workbook";

export function downloadLeadGenExcelReport(data: LeadGenExcelReportData) {
  XLSX.writeFile(buildLeadGenWorkbook(data), buildLeadGenFilename(data), {
    bookType: "xlsx", cellStyles: true, compression: true,
  });
}
