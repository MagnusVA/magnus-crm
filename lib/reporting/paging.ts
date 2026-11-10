// The arithmetic of a report card's pager (DESIGN.md, The Report Pager):
// which rows a page shows, and what "1–10 of 43" should say.

export type PageWindow = {
  /** The page shown, after stepping back from a page the rows no longer reach. */
  page: number;
  /** The last page there is; 0 for an empty list. */
  lastPage: number;
  /** Slice bounds into the rows: [start, end). */
  start: number;
  end: number;
  /** 1-based positions for the count line; 0 and 0 when there are no rows. */
  from: number;
  to: number;
};

/** The window `page` shows of `total` rows, `pageSize` at a time. */
export function pageWindow(total: number, pageSize: number, page: number): PageWindow {
  const size = Math.max(1, Math.floor(pageSize));
  const rows = Math.max(0, Math.floor(total));
  const lastPage = Math.max(0, Math.ceil(rows / size) - 1);
  const current = Math.min(Math.max(0, Math.floor(page)), lastPage);
  const start = current * size;
  const end = Math.min(start + size, rows);
  return { page: current, lastPage, start, end, from: end > start ? start + 1 : 0, to: end };
}
