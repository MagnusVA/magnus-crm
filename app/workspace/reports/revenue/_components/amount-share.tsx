import type { ReactNode } from "react";

/** A whole-number share: "36%", "<1%" for a sliver, "—" for nothing. */
export function wholeShare(part: number, whole: number) {
  if (whole <= 0 || part <= 0) return "—";
  const percent = (part / whole) * 100;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

/** A bar row's measure with its share in a fixed slate column after it, so the row stays on one line. */
export function AmountShare({ amount, share }: { amount: ReactNode; share: string }) {
  return (
    <>
      {amount}
      <span className="ml-2 inline-block w-10 font-medium text-muted-foreground">{share}</span>
    </>
  );
}
