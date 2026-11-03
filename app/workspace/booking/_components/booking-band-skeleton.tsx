import { PageBand } from "@/app/workspace/_components/page-band";
import { cn } from "@/lib/utils";

const SECTION_LABELS = ["Coverage", "Inbox", "Event types", "DM teams", "Link portal"] as const;

/** The booking setup band before the client loads: the title, the line and the section tabs. */
export function BookingBandSkeleton({
  active,
  description,
  children,
}: {
  active: (typeof SECTION_LABELS)[number];
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <PageBand title="Booking setup" description={description}>
      <div className="-mx-4 border-t border-board-line px-4 @lg:-mx-[18px] @lg:px-[18px]">
        <div aria-hidden="true" className="flex min-w-0 gap-4 overflow-hidden @xl:gap-[22px]">
          {SECTION_LABELS.map((label) => (
            <span
              key={label}
              className={cn(
                "flex h-10 shrink-0 items-center border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase",
                label === active ? "border-primary text-board-foreground" : "border-transparent text-board-muted",
              )}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
      {children}
    </PageBand>
  );
}
