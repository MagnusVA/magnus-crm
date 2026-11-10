export type PeoplePanel = "closers" | "setters" | "dm_closers" | "lead_gen";
type Build = "aggregate" | "raw";

/**
 * Which build answers each People panel from ClickHouse. "aggregate" returns
 * per-person totals; "raw" returns every row and stops near a month, so it
 * stays only as the rollback. Rolling a panel back is one line here and a
 * deploy. The build not serving keeps its own id (`.next` for the aggregate,
 * `.raw` for the row build) so parity can still compare the two.
 */
export const PEOPLE_SERVING: Record<PeoplePanel, Build> = {
  closers: "aggregate",
  setters: "aggregate",
  dm_closers: "aggregate",
  lead_gen: "aggregate",
};

export function peopleSlot(panel: PeoplePanel, build: Build, serving = PEOPLE_SERVING) {
  return serving[panel] === build
    ? { id: `people.${panel}`, page: "people" as const }
    : { id: `people.${panel}.${build === "aggregate" ? "next" : "raw"}`, page: null };
}
