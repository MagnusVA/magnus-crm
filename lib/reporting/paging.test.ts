import { describe, expect, it } from "vitest";
import { pageWindow } from "./paging";

describe("a report card's page window", () => {
  it("shows ten of 43 rows at a time and a short last page", () => {
    expect(pageWindow(43, 10, 0)).toMatchObject({ page: 0, lastPage: 4, start: 0, end: 10, from: 1, to: 10 });
    expect(pageWindow(43, 10, 4)).toMatchObject({ page: 4, start: 40, end: 43, from: 41, to: 43 });
  });

  it("steps back when the rows no longer reach the page", () => {
    // A filter left 12 rows while page 4 was showing.
    expect(pageWindow(12, 10, 4)).toMatchObject({ page: 1, lastPage: 1, from: 11, to: 12 });
  });

  it("reads 0 and 0 for an empty list, and one page for an exact fit", () => {
    expect(pageWindow(0, 10, 0)).toMatchObject({ page: 0, lastPage: 0, from: 0, to: 0 });
    expect(pageWindow(10, 10, 3)).toMatchObject({ page: 0, lastPage: 0, from: 1, to: 10 });
  });
});
