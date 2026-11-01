// A person row's layout, shared with its skeleton (a server component, so it
// lives outside the client row). The page root is the container (DESIGN.md,
// Responsive rules): four columns from @4xl; from @xl the person and money on
// one line with the deal and next step side by side under them; below that
// the deal and the next step stack under the person.

/** The row's grid at each container step. */
export const ROW_GRID =
	"grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 @xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem] @xl:gap-x-5 @4xl:h-[60px] @4xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_10rem] @4xl:gap-y-0 @4xl:px-[18px] @4xl:py-0";

/** Where each cell sits in `ROW_GRID`. */
export const CELL = {
	person: "col-start-1 row-start-1 min-w-0 @xl:col-span-2 @4xl:col-span-1",
	money: "col-start-2 row-start-1 min-w-0 text-right @xl:col-start-3 @4xl:col-start-4",
	deal: "col-span-2 min-w-0 @xl:col-span-1",
	next: "col-span-2 min-w-0 @4xl:col-span-1",
} as const;
