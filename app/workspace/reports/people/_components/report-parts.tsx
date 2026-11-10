"use client";

import Link from "next/link";
import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { FreshnessWords, type FreshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { PageBand } from "@/app/workspace/_components/page-band";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { MemberRole } from "@/convex/reports/member";
import { REPORT_TERMS, type ReportTermKey } from "@/lib/reporting/definitions";
import { cn } from "@/lib/utils";
import { BAND_SELECT, COLUMN_HEAD, FIGURE_15 } from "../../_components/report-ui";

// Pieces the Calls page, the People roster and the member report share, kept
// in this folder so the shared report shell stays untouched.

export const ROLE_LABEL: Record<MemberRole, string> = {
  closer: "Phone closer",
  setter: "Setter",
  dm_closer: "DM closer",
  lead_gen: "Lead gen",
};

/** A role as a 20px condensed chip on the muted fill (the stage chip's shape, no stage colour). */
export function RoleChip({ role, className }: { role: MemberRole; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-[4px] bg-muted px-1.5 font-condensed text-[11px] font-bold tracking-[0.1em] whitespace-nowrap text-muted-foreground uppercase",
        className,
      )}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

/** The same chip on the navy band. */
export function BandRoleChip({ role }: { role: MemberRole }) {
  return (
    <span className="inline-flex h-5 items-center rounded-[4px] bg-board-raised px-1.5 font-condensed text-[11px] font-bold tracking-[0.1em] whitespace-nowrap text-board-foreground uppercase">
      {ROLE_LABEL[role]}
    </span>
  );
}

/** INACTIVE beside a name, 11px condensed bold in slate. */
export function InactiveMark() {
  return (
    <span className="ml-1.5 font-condensed text-[11px] font-bold tracking-[0.1em] text-muted-foreground uppercase">Inactive</span>
  );
}

/** A name that opens somewhere: underlined on hover, with the inset focus ring. */
export function RowLink({ href, children, className }: { href: string | null; children: ReactNode; className?: string }) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <Link
      href={href}
      className={cn(
        "rounded-sm underline-offset-[3px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/**
 * "How these are counted": every term the page uses, from the dictionary, in
 * words. It sits folded at the foot of the page (the Folded Audit Card's
 * grammar), since it is read once and the figures above it every day.
 */
export function DefinitionsCard({ terms }: { terms: readonly ReportTermKey[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <DetailCard
      title="How these are counted"
      meta={
        <>
          <span className="hidden @xl:inline">
            {terms.length} {terms.length === 1 ? "term" : "terms"}, each with its formula
          </span>
          <Button size="xs" variant="outline" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
            {open ? "Hide" : "Show"}
            <ChevronDownIcon
              data-icon="inline-end"
              aria-hidden="true"
              className={cn("transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
            />
          </Button>
        </>
      }
      className={cn("@container min-w-0", !open && "[&>div:first-child]:border-b-0")}
    >
      <dl id={panelId} hidden={!open} className="flex flex-col">
        {open
          ? terms.map((key) => (
              <div key={key} className="grid gap-x-4 gap-y-0.5 border-b px-4 py-2 last:border-b-0 @3xl:grid-cols-[10rem_minmax(0,1fr)]">
                <dt className="text-[13px] font-semibold">{REPORT_TERMS[key].label}</dt>
                <dd className="max-w-[75ch] text-[13px] text-muted-foreground">
                  {REPORT_TERMS[key].definition} <span className="@3xl:whitespace-nowrap">({REPORT_TERMS[key].formula})</span>
                </dd>
              </div>
            ))
          : null}
      </dl>
    </DetailCard>
  );
}

/** The band's currency select, shown only when the range has more than one currency. */
export function CurrencySelect({
  currencies,
  value,
  onChange,
  label,
}: {
  currencies: readonly string[];
  value: string;
  onChange: (next: string) => void;
  label: string;
}) {
  if (currencies.length < 2) return null;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={cn(BAND_SELECT, "w-[92px] font-condensed text-[14px] font-semibold tracking-[0.02em]")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {currencies.map((currency) => (
          <SelectItem key={currency} value={currency}>
            {currency}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A report band with a way back and a row under the title (tabs or chips):
 * `ReportBand`'s range line on `PageBand`, which takes both.
 */
export function ReportBandWithRow({
  title,
  back,
  range,
  freshness,
  dayLine,
  actions,
  row,
  figures,
}: {
  title: string;
  back?: { href: string; label: string };
  range: ReactNode;
  freshness: FreshnessSummary | null;
  dayLine: ReactNode;
  actions: ReactNode;
  row?: ReactNode;
  figures?: ReactNode;
}) {
  return (
    <PageBand
      title={title}
      back={back}
      description={
        <>
          <span className="font-medium text-board-foreground">{range}</span>
          {freshness && freshness.kind === "line" ? (
            <>
              {" · "}
              <FreshnessWords summary={freshness} />
            </>
          ) : null}
          <span className="hidden @3xl:inline"> · {dayLine}</span>
        </>
      }
      actions={<div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    >
      {row || figures ? (
        <div className="flex flex-col">
          {row}
          {figures}
        </div>
      ) : null}
    </PageBand>
  );
}

export type TableColumn<Row> = {
  key: string;
  head: ReactNode;
  /** The head as text, for the narrow fold. */
  label: string;
  value: (row: Row) => ReactNode;
  /** A 13px slate line under the figure. */
  sub?: (row: Row) => ReactNode;
  quiet?: (row: Row) => boolean;
  /** Amber ink: something still owed. */
  owed?: (row: Row) => boolean;
  /** Left-aligned text rather than a figure. */
  text?: boolean;
};

/**
 * A ruled table of people (The Phone Closers Table's grammar): label heads,
 * the name over a 13px proof line, 15px condensed figures on the right. From
 * `wideAt` of the card's container every column shows; narrower, each row
 * becomes the name over its figures in words.
 */
export function PeopleTable<Row>({
  caption,
  rows,
  rowKey,
  first,
  columns,
  total,
  wide = "@4xl/people",
}: {
  caption: string;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  first: { head: string; cell: (row: Row) => ReactNode };
  columns: ReadonlyArray<TableColumn<Row>>;
  total?: { cell: ReactNode; row: Row };
  /** The container width the full table needs; written out for Tailwind. */
  wide?: "@4xl/people" | "@3xl/people" | "@5xl/people";
}) {
  const tableShown = { "@3xl/people": "@3xl/people:table", "@4xl/people": "@4xl/people:table", "@5xl/people": "@5xl/people:table" }[wide];
  const listHidden = { "@3xl/people": "@3xl/people:hidden", "@4xl/people": "@4xl/people:hidden", "@5xl/people": "@5xl/people:hidden" }[wide];
  const cells = (row: Row, isTotal: boolean) =>
    columns.map((column, index) => (
      <td
        key={column.key}
        className={cn(
          "px-2.5 py-2 align-top",
          column.text ? "text-left text-[13px]" : cn("text-right whitespace-nowrap", FIGURE_15),
          index === columns.length - 1 && "pr-4",
          !isTotal && column.quiet?.(row) && "text-muted-foreground",
          !isTotal && column.owed?.(row) && "text-warning-ink",
        )}
      >
        {column.value(row)}
        {column.sub ? <span className="block font-sans text-[12px] font-normal text-muted-foreground">{column.sub(row)}</span> : null}
      </td>
    ));
  const fold = (row: Row) =>
    columns.map((column, index) => (
      // The separator sits outside the unbroken pair, so the line can wrap there.
      <Fragment key={column.key}>
        {index > 0 ? " · " : null}
        <span className="whitespace-nowrap">
          <span className="text-muted-foreground">{column.label} </span>
          <span className={cn(FIGURE_15, column.owed?.(row) && "text-warning-ink")}>{column.value(row)}</span>
        </span>
      </Fragment>
    ));
  return (
    <>
      <table className={cn("hidden w-full border-collapse", tableShown)}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
              {first.head}
            </th>
            {columns.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={cn(COLUMN_HEAD, column.text ? "text-left" : "text-right", index === columns.length - 1 && "pr-4")}
              >
                {column.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b last:border-b-0">
              <th scope="row" className="py-2 pr-3 pl-4 text-left align-top font-normal">
                {first.cell(row)}
              </th>
              {cells(row, false)}
            </tr>
          ))}
          {total ? (
            <tr className="bg-muted/40 font-semibold">
              <th scope="row" className="py-2 pr-3 pl-4 text-left align-top">
                {total.cell}
              </th>
              {cells(total.row, true)}
            </tr>
          ) : null}
        </tbody>
      </table>
      <ul aria-label={caption} className={cn("flex flex-col", listHidden)}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="border-b px-4 py-2.5 last:border-b-0">
            {first.cell(row)}
            <p className="mt-1 text-[13px] leading-relaxed">{fold(row)}</p>
          </li>
        ))}
        {total ? (
          <li className="bg-muted/40 px-4 py-2.5">
            <div className="font-semibold">{total.cell}</div>
            <p className="mt-1 text-[13px] leading-relaxed">{fold(total.row)}</p>
          </li>
        ) : null}
      </ul>
    </>
  );
}

/** A label-style group head on the rule above the rows it heads. */
export function GroupHead({ children }: { children: ReactNode }) {
  return <p className={cn(COLUMN_HEAD, "flex min-h-7 items-end border-b bg-muted/40 px-4")}>{children}</p>;
}
