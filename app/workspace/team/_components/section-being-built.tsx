import type { ReactNode } from "react";
import { CARD } from "./team-ui";

/** A Team hub section that hasn't shipped yet: says so, and where to go meanwhile. */
export function SectionBeingBuilt({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={CARD} aria-labelledby="being-built-title">
      <div className="flex min-h-11 items-center border-b border-border px-4 py-2">
        <h2 id="being-built-title" className="text-[15px] font-semibold">
          {title} is being built
        </h2>
      </div>
      <p className="max-w-[640px] px-4 py-3 text-[13.5px] text-muted-foreground">{children}</p>
    </section>
  );
}
