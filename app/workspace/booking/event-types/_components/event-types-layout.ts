export const EVENT_TYPES_DESCRIPTION =
  "Every event type Calendly returns, by how it's sorted: which program it books, where coverage uses it, and whether its link works.";

/**
 * The table's columns by the card's width (`@container/et`): from `@5xl`
 * EVENT TYPE, PROGRAM, USED IN, LINK, PAYMENT and the menu; PAYMENT folds
 * away below `@5xl`, USED IN below `@4xl`, and below `@2xl` a row is two
 * lines (the name, then program and link in words) beside the menu.
 */
export const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-x-4 @2xl/et:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_9rem_2rem] @4xl/et:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.8fr)_9rem_2rem] @5xl/et:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.8fr)_9rem_6rem_2rem]";

export const COL_PROGRAM = "hidden @2xl/et:block";
export const COL_USED_IN = "hidden @4xl/et:block";
export const COL_LINK = "hidden @2xl/et:block";
export const COL_PAYMENT = "hidden @5xl/et:block";
