"use client";

import * as XLSX from "xlsx-js-style";

type LeadGenSource = "instagram" | "meta_business";

export type LeadGenExcelReportData = {
	generatedAt: number;
	reportTitle: string;
	filters: {
		startDayKey: string;
		endDayKey: string;
		source: LeadGenSource | null;
		teamName: string | null;
		workerName: string | null;
	};
	sheets: Array<{
		sheetKey: string;
		sheetName: string;
		scopeKind: "team" | "worker";
		scopeLabel: string;
		summary: {
			submissions: number;
			uniqueProspects: number;
			duplicates: number;
			scheduledHours: number;
			leadsPerHour: number | null;
		};
		topLeadGenerators: WorkerPerformanceRow[];
		topPosts: OriginRow[];
		workerPerformance: WorkerPerformanceRow[];
		sourcePerformance: SourcePerformanceRow[];
		postDetail: OriginRow[];
	}>;
};

type WorkerPerformanceRow = {
	displayName: string;
	email: string | null;
	teamName: string | null;
	isActive: boolean;
	submissions: number;
	uniqueProspects: number;
	duplicates: number;
	scheduledHours: number;
	leadsPerHour: number | null;
};

type SourcePerformanceRow = {
	source: LeadGenSource;
	submissions: number;
	uniqueProspects: number;
	duplicates: number;
	scheduledHours: number;
	leadsPerHour: number | null;
};

type OriginRow = {
	originKind: "post" | "reel";
	originValue: string;
	source: LeadGenSource;
	uniqueProspects: number;
	submissions: number;
	dayCount: number;
};

type CellValue = string | number | boolean | null;
type CellStyle = Record<string, unknown>;

const TITLE_COLUMN_COUNT = 10;
const LIGHT_BORDER = { style: "thin", color: { rgb: "D6DEE8" } };
const MEDIUM_BORDER = { style: "medium", color: { rgb: "1F2937" } };

const STYLES = {
	title: {
		font: { bold: true, sz: 18, color: { rgb: "FFFFFF" } },
		fill: { patternType: "solid", fgColor: { rgb: "111827" } },
		alignment: { horizontal: "left", vertical: "center" },
	},
	subtitle: {
		font: { bold: true, sz: 11, color: { rgb: "1F2937" } },
		fill: { patternType: "solid", fgColor: { rgb: "F8FAFC" } },
		alignment: { horizontal: "left", vertical: "center" },
		border: { bottom: LIGHT_BORDER },
	},
	metadata: {
		font: { sz: 10, color: { rgb: "64748B" } },
		fill: { patternType: "solid", fgColor: { rgb: "F8FAFC" } },
		alignment: { horizontal: "left", vertical: "center" },
	},
	section: {
		font: { bold: true, sz: 12, color: { rgb: "FFFFFF" } },
		fill: { patternType: "solid", fgColor: { rgb: "334155" } },
		alignment: { horizontal: "left", vertical: "center" },
		border: { top: MEDIUM_BORDER, bottom: LIGHT_BORDER },
	},
	header: {
		font: { bold: true, color: { rgb: "FFFFFF" } },
		fill: { patternType: "solid", fgColor: { rgb: "2563EB" } },
		alignment: { horizontal: "center", vertical: "center", wrapText: true },
		border: {
			top: LIGHT_BORDER,
			right: LIGHT_BORDER,
			bottom: LIGHT_BORDER,
			left: LIGHT_BORDER,
		},
	},
	body: {
		font: { color: { rgb: "0F172A" } },
		alignment: { vertical: "center", wrapText: false },
		border: {
			top: LIGHT_BORDER,
			right: LIGHT_BORDER,
			bottom: LIGHT_BORDER,
			left: LIGHT_BORDER,
		},
	},
	zebra: {
		fill: { patternType: "solid", fgColor: { rgb: "F8FAFC" } },
	},
	empty: {
		font: { italic: true, color: { rgb: "64748B" } },
		fill: { patternType: "solid", fgColor: { rgb: "F8FAFC" } },
		alignment: { horizontal: "left", vertical: "center" },
		border: {
			top: LIGHT_BORDER,
			right: LIGHT_BORDER,
			bottom: LIGHT_BORDER,
			left: LIGHT_BORDER,
		},
	},
	hyperlink: {
		font: { color: { rgb: "2563EB" }, underline: true },
	},
	kpiLabel: {
		font: { bold: true, sz: 9, color: { rgb: "475569" } },
		fill: { patternType: "solid", fgColor: { rgb: "EFF6FF" } },
		alignment: { horizontal: "left", vertical: "center" },
		border: {
			top: LIGHT_BORDER,
			right: LIGHT_BORDER,
			left: LIGHT_BORDER,
		},
	},
	kpiValue: {
		font: { bold: true, sz: 18, color: { rgb: "0F172A" } },
		fill: { patternType: "solid", fgColor: { rgb: "EFF6FF" } },
		alignment: { horizontal: "left", vertical: "center" },
		border: {
			right: LIGHT_BORDER,
			bottom: LIGHT_BORDER,
			left: LIGHT_BORDER,
		},
	},
} satisfies Record<string, CellStyle>;

export function downloadLeadGenExcelReport(data: LeadGenExcelReportData) {
	const workbook = XLSX.utils.book_new();
	const usedSheetNames = new Set<string>();

	for (const sheet of data.sheets) {
		XLSX.utils.book_append_sheet(
			workbook,
			buildReportWorksheet(data, sheet),
			sanitizeSheetName(sheet.sheetName, usedSheetNames),
		);
	}

	XLSX.writeFile(workbook, buildFilename(data), {
		bookType: "xlsx",
		cellStyles: true,
		compression: true,
	});
}

function buildReportWorksheet(
	data: LeadGenExcelReportData,
	sheet: LeadGenExcelReportData["sheets"][number],
) {
	const worksheet = XLSX.utils.aoa_to_sheet([]);
	const cursor = { row: 0 };
	const merges: XLSX.Range[] = [];

	addTitleBlock(worksheet, merges, cursor, data, sheet);
	addSummaryKpiSection(worksheet, merges, cursor, sheet.summary);

	addTableSection(worksheet, merges, cursor, {
		title: "Top 3 Lead Gen Specialists",
		headers: [
			"Rank",
			"Lead Gen Specialist",
			"Team",
			"Submissions",
			"Scheduled Hours",
			"Leads/Hr",
		],
		rows: sheet.topLeadGenerators.map((row, index) => [
			index + 1,
			row.displayName,
			row.teamName ?? "No Team",
			row.submissions,
			roundTwo(row.scheduledHours),
			nullableRoundTwo(row.leadsPerHour),
		]),
		emptyText: "No lead gen specialist activity in this scope.",
		numberFormats: {
			0: "0",
			3: "#,##0",
			4: "#,##0.00",
			5: "#,##0.00",
		},
	});

	addTableSection(worksheet, merges, cursor, {
		title: "Top 3 Posts/Reels",
		headers: [
			"Rank",
			"Origin",
			"Kind",
			"Source",
			"Unique Prospects",
			"Submissions",
			"Days",
		],
		rows: sheet.topPosts.map((row, index) => [
			index + 1,
			formatOriginForCell(row.originValue),
			formatOriginKind(row.originKind),
			formatSource(row.source),
			row.uniqueProspects,
			row.submissions,
			row.dayCount,
		]),
		emptyText: "No rankable post or reel activity in this scope.",
		hyperlinkColumn: 1,
		numberFormats: {
			0: "0",
			4: "#,##0",
			5: "#,##0",
			6: "#,##0",
		},
	});

	const workerPerformanceRange = addTableSection(worksheet, merges, cursor, {
		title: "Specialist Performance",
		headers: [
			"Lead Gen Specialist",
			"Email",
			"Team",
			"Status",
			"Submissions",
			"Scheduled Hours",
			"Leads/Hr",
		],
		rows: sheet.workerPerformance.map((row) => [
			row.displayName,
			row.email ?? "",
			row.teamName ?? "No Team",
			row.isActive ? "Active" : "Inactive",
			row.submissions,
			roundTwo(row.scheduledHours),
			nullableRoundTwo(row.leadsPerHour),
		]),
		emptyText: "No lead gen specialist activity in this scope.",
		numberFormats: {
			4: "#,##0",
			5: "#,##0.00",
			6: "#,##0.00",
		},
	});

	addTableSection(worksheet, merges, cursor, {
		title: "Source Split",
		headers: [
			"Source",
			"Submissions",
			"Scheduled Hours",
			"Leads/Hr",
		],
		rows: sheet.sourcePerformance.map((row) => [
			formatSource(row.source),
			row.submissions,
			roundTwo(row.scheduledHours),
			nullableRoundTwo(row.leadsPerHour),
		]),
		emptyText: "No source activity in this scope.",
		numberFormats: {
			1: "#,##0",
			2: "#,##0.00",
			3: "#,##0.00",
		},
	});

	const postDetailRange = addTableSection(worksheet, merges, cursor, {
		title: "Posts/Reels Detail",
		headers: [
			"Origin",
			"Kind",
			"Source",
			"Unique Prospects",
			"Submissions",
			"Days",
		],
		rows: sheet.postDetail.map((row) => [
			formatOriginForCell(row.originValue),
			formatOriginKind(row.originKind),
			formatSource(row.source),
			row.uniqueProspects,
			row.submissions,
			row.dayCount,
		]),
		emptyText: "No rankable post or reel activity in this scope.",
		hyperlinkColumn: 0,
		numberFormats: {
			3: "#,##0",
			4: "#,##0",
			5: "#,##0",
		},
	});

	worksheet["!cols"] = [
		{ wch: 20 },
		{ wch: 38 },
		{ wch: 22 },
		{ wch: 18 },
		{ wch: 16 },
		{ wch: 18 },
		{ wch: 14 },
		{ wch: 18 },
		{ wch: 14 },
		{ wch: 14 },
	];
	worksheet["!merges"] = merges;
	worksheet["!margins"] = {
		left: 0.35,
		right: 0.35,
		top: 0.5,
		bottom: 0.5,
		header: 0.2,
		footer: 0.2,
	};
	if (postDetailRange) {
		worksheet["!autofilter"] = { ref: XLSX.utils.encode_range(postDetailRange) };
	} else if (workerPerformanceRange) {
		worksheet["!autofilter"] = {
			ref: XLSX.utils.encode_range(workerPerformanceRange),
		};
	}

	return worksheet;
}

function addTitleBlock(
	worksheet: XLSX.WorkSheet,
	merges: XLSX.Range[],
	cursor: { row: number },
	data: LeadGenExcelReportData,
	sheet: LeadGenExcelReportData["sheets"][number],
) {
	addMergedTextRow(
		worksheet,
		merges,
		cursor.row,
		`${data.reportTitle} - ${sheet.scopeLabel}`,
		TITLE_COLUMN_COUNT,
		STYLES.title,
	);
	setRowHeight(worksheet, cursor.row, 24);
	cursor.row += 1;

	const metadataRows = [
		`Period: ${data.filters.startDayKey} to ${data.filters.endDayKey}    |    Generated: ${new Date(
			data.generatedAt,
		).toLocaleString()}`,
		`Scope: ${sheet.scopeKind === "worker" ? "Lead Gen Specialist" : "Team"} = ${
			sheet.scopeLabel
		}`,
		`Filters: ${formatFilters(data.filters)}`,
	];

	for (const [index, row] of metadataRows.entries()) {
		addMergedTextRow(
			worksheet,
			merges,
			cursor.row,
			row,
			TITLE_COLUMN_COUNT,
			index === 0 ? STYLES.subtitle : STYLES.metadata,
		);
		setRowHeight(worksheet, cursor.row, 18);
		cursor.row += 1;
	}

	cursor.row += 1;
}

function addSummaryKpiSection(
	worksheet: XLSX.WorkSheet,
	merges: XLSX.Range[],
	cursor: { row: number },
	summary: LeadGenExcelReportData["sheets"][number]["summary"],
) {
	addMergedTextRow(
		worksheet,
		merges,
		cursor.row,
		"Summary",
		TITLE_COLUMN_COUNT,
		STYLES.section,
	);
	setRowHeight(worksheet, cursor.row, 20);
	cursor.row += 1;

	const cards = [
		{ label: "SUBMISSIONS", value: summary.submissions, format: "#,##0" },
		{
			label: "SCHEDULED HOURS",
			value: roundTwo(summary.scheduledHours),
			format: "#,##0.00",
		},
		{
			label: "LEADS / HR",
			value: nullableRoundTwo(summary.leadsPerHour),
			format: "#,##0.00",
		},
	];

	for (const [index, card] of cards.entries()) {
		const startColumn = index * 2;
		const endColumn = startColumn + 1;
		addMergedValue(
			worksheet,
			merges,
			cursor.row,
			startColumn,
			endColumn,
			card.label,
			STYLES.kpiLabel,
		);
		addMergedValue(
			worksheet,
			merges,
			cursor.row + 1,
			startColumn,
			endColumn,
			card.value,
			STYLES.kpiValue,
		);
		const valueCell = worksheet[
			XLSX.utils.encode_cell({ r: cursor.row + 1, c: startColumn })
		];
		if (valueCell && typeof valueCell.v === "number") {
			valueCell.z = card.format;
		}
	}

	setRowHeight(worksheet, cursor.row, 18);
	setRowHeight(worksheet, cursor.row + 1, 28);
	cursor.row += 4;
}

function addTableSection(
	worksheet: XLSX.WorkSheet,
	merges: XLSX.Range[],
	cursor: { row: number },
	args: {
		title: string;
		headers: string[];
		rows: CellValue[][];
		emptyText?: string;
		hyperlinkColumn?: number;
		numberFormats?: Record<number, string>;
	},
) {
	const columnCount = args.headers.length;
	addMergedTextRow(
		worksheet,
		merges,
		cursor.row,
		args.title,
		columnCount,
		STYLES.section,
	);
	setRowHeight(worksheet, cursor.row, 18);
	cursor.row += 1;

	const headerRow = cursor.row;
	XLSX.utils.sheet_add_aoa(worksheet, [args.headers], {
		origin: { r: headerRow, c: 0 },
	});
	applyStyleToRange(
		worksheet,
		headerRow,
		headerRow,
		0,
		columnCount - 1,
		STYLES.header,
	);
	setRowHeight(worksheet, headerRow, 18);
	cursor.row += 1;

	if (args.rows.length === 0) {
		addMergedTextRow(
			worksheet,
			merges,
			cursor.row,
			args.emptyText ?? "No rows in this scope.",
			columnCount,
			STYLES.empty,
		);
		cursor.row += 3;
		return null;
	}

	const firstDataRow = cursor.row;
	XLSX.utils.sheet_add_aoa(worksheet, args.rows, {
		origin: { r: firstDataRow, c: 0 },
	});
	const lastDataRow = firstDataRow + args.rows.length - 1;
	for (let row = firstDataRow; row <= lastDataRow; row += 1) {
		applyStyleToRange(
			worksheet,
			row,
			row,
			0,
			columnCount - 1,
			row % 2 === 0 ? { ...STYLES.body, ...STYLES.zebra } : STYLES.body,
		);
	}

	for (const [columnIndex, format] of Object.entries(args.numberFormats ?? {})) {
		applyNumberFormat(
			worksheet,
			firstDataRow,
			lastDataRow,
			Number(columnIndex),
			format,
		);
	}

	if (args.hyperlinkColumn !== undefined) {
		applyHyperlinks(
			worksheet,
			firstDataRow,
			lastDataRow,
			args.hyperlinkColumn,
		);
	}

	cursor.row = lastDataRow + 3;
	return {
		s: { r: headerRow, c: 0 },
		e: { r: lastDataRow, c: columnCount - 1 },
	};
}

function addMergedTextRow(
	worksheet: XLSX.WorkSheet,
	merges: XLSX.Range[],
	row: number,
	text: string,
	columnCount: number,
	style: CellStyle,
) {
	XLSX.utils.sheet_add_aoa(worksheet, [[text]], {
		origin: { r: row, c: 0 },
	});
	merges.push({ s: { r: row, c: 0 }, e: { r: row, c: columnCount - 1 } });
	applyStyleToRange(worksheet, row, row, 0, columnCount - 1, style);
}

function addMergedValue(
	worksheet: XLSX.WorkSheet,
	merges: XLSX.Range[],
	row: number,
	startColumn: number,
	endColumn: number,
	value: CellValue,
	style: CellStyle,
) {
	XLSX.utils.sheet_add_aoa(worksheet, [[value]], {
		origin: { r: row, c: startColumn },
	});
	merges.push({ s: { r: row, c: startColumn }, e: { r: row, c: endColumn } });
	applyStyleToRange(worksheet, row, row, startColumn, endColumn, style);
}

function applyStyleToRange(
	worksheet: XLSX.WorkSheet,
	startRow: number,
	endRow: number,
	startColumn: number,
	endColumn: number,
	style: CellStyle,
) {
	for (let row = startRow; row <= endRow; row += 1) {
		for (let column = startColumn; column <= endColumn; column += 1) {
			const cell = ensureCell(worksheet, row, column);
			cell.s = { ...(cell.s ?? {}), ...style };
		}
	}
}

function applyNumberFormat(
	worksheet: XLSX.WorkSheet,
	startRow: number,
	endRow: number,
	column: number,
	format: string,
) {
	for (let row = startRow; row <= endRow; row += 1) {
		const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
		if (cell && typeof cell.v === "number") {
			cell.z = format;
			cell.s = {
				...(cell.s ?? {}),
				alignment: { horizontal: "right", vertical: "center" },
			};
		}
	}
}

function applyHyperlinks(
	worksheet: XLSX.WorkSheet,
	startRow: number,
	endRow: number,
	column: number,
) {
	for (let row = startRow; row <= endRow; row += 1) {
		const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
		if (!cell || typeof cell.v !== "string") continue;

		const target = getHyperlinkTarget(cell.v);
		if (!target) continue;

		cell.l = { Target: target };
		cell.s = { ...(cell.s ?? {}), ...STYLES.hyperlink };
	}
}

function ensureCell(worksheet: XLSX.WorkSheet, row: number, column: number) {
	const address = XLSX.utils.encode_cell({ r: row, c: column });
	worksheet[address] ??= { t: "s", v: "" };
	return worksheet[address];
}

function setRowHeight(worksheet: XLSX.WorkSheet, row: number, hpt: number) {
	worksheet["!rows"] ??= [];
	worksheet["!rows"][row] = { hpt };
}

function sanitizeSheetName(name: string, used: Set<string>) {
	const base =
		name.replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) ||
		"Sheet";
	let candidate = base;
	let suffix = 2;

	while (used.has(candidate)) {
		const suffixText = ` ${suffix}`;
		candidate = `${base.slice(0, 31 - suffixText.length)}${suffixText}`;
		suffix += 1;
	}

	used.add(candidate);
	return candidate;
}

function buildFilename(data: LeadGenExcelReportData) {
	return `lead-gen-report-${data.filters.startDayKey}-${data.filters.endDayKey}.xlsx`;
}

function formatFilters(filters: LeadGenExcelReportData["filters"]) {
	return [
		`Source = ${filters.source ? formatSource(filters.source) : "All"}`,
		`Team = ${filters.teamName ?? "All"}`,
		`Lead Gen Specialist = ${filters.workerName ?? "All"}`,
	].join(", ");
}

function formatSource(source: LeadGenSource) {
	return source === "meta_business" ? "Meta Business" : "Instagram";
}

function formatOriginKind(originKind: "post" | "reel") {
	return originKind === "post" ? "Post" : "Reel";
}

function nullableRoundTwo(value: number | null) {
	return value == null ? "N/A" : roundTwo(value);
}

function roundTwo(value: number) {
	return Math.round(value * 100) / 100;
}

function getHyperlinkTarget(value: string) {
	try {
		return new URL(value).toString();
	} catch {
		try {
			return new URL(`https://${value}`).toString();
		} catch {
			return null;
		}
	}
}

function formatOriginForCell(value: string) {
	try {
		const url = new URL(value);
		const pathname = url.pathname.replace(/\/$/, "");
		return `${url.hostname.replace(/^www\./, "")}${pathname}`;
	} catch {
		return value;
	}
}
