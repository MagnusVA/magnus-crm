export const INBOX_DESCRIPTION =
  "Sort each new Calendly event type into a program, or set it aside as not a sales call.";

/**
 * The inbox desk: one card, the queue on the left and the focused event type
 * on the right from `@4xl`, filling the viewport under the band. Narrower,
 * the focused card comes first and the queue follows.
 */
export const INBOX_DESK =
  "gap-0 overflow-hidden py-0 @4xl:grid @4xl:h-[clamp(32rem,calc(100dvh-16rem),60rem)] @4xl:grid-cols-[minmax(16rem,22.5rem)_minmax(0,1fr)]";
