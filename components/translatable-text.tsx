/**
 * Wraps text that changes, or that sits next to an element React adds and
 * removes (a spinner before a button label).
 *
 * Chrome's page translation replaces a text node with a `<font>` element.
 * React still holds the old node. Inserting a spinner before it then throws
 * `NotFoundError` from `insertBefore`, removing it throws from `removeChild`,
 * and a changed label never shows. A `<span>` stays where React put it, and
 * React rewrites a span's whole content when its one string changes.
 */
export function TranslatableText({ children }: { children: string }) {
  return <span>{children}</span>;
}
