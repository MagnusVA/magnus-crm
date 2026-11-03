import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageBand } from "@/app/workspace/_components/page-band";

// The Qualifications desk's first load, at the page's real layout and heights.

function Bone({ className }: { className: string }) {
  return <span aria-hidden="true" className={`inline-block animate-pulse rounded-md bg-board-foreground/10 align-middle ${className}`} />;
}

export function QualificationsPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading qualified leads"
      className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3"
    >
      <PageBand
        title="Qualified Leads"
        description={<Bone className="h-3.5 w-72 max-w-full" />}
        actions={<Bone className="h-[34px] w-[26rem] max-w-full rounded-[7px]" />}
      >
        <div className="-mx-4 flex items-center gap-5 border-t border-board-line px-4 pt-3 pb-3.5 @lg:-mx-[18px] @lg:px-[18px] @lg:pb-4">
          <div className="flex flex-col gap-1.5">
            <Bone className="h-2.5 w-16" />
            <Bone className="h-8 w-24" />
          </div>
          <Bone className="h-3.5 flex-1 rounded-[3px]" />
          <Bone className="hidden h-3.5 w-48 @3xl:inline-block" />
        </div>
      </PageBand>
      <Card className="min-w-0 gap-0 overflow-hidden py-0 @4xl:grid @4xl:h-[clamp(30rem,calc(100dvh-18rem),60rem)] @4xl:grid-cols-[minmax(16rem,22.5rem)_minmax(0,1fr)]">
        <div className="border-b @4xl:border-r @4xl:border-b-0">
          <div className="flex min-h-11 items-center border-b px-4">
            <Skeleton className="h-4 w-16" />
          </div>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex h-[62px] flex-col justify-center gap-2 border-b px-4">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-6 rounded-full" />
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="ml-auto h-5 w-6" />
              </div>
              <Skeleton className="ml-[34px] h-2 w-1/2" />
            </div>
          ))}
        </div>
        <div>
          <div className="flex min-h-11 items-center gap-3 border-b px-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="ml-auto h-[30px] w-64 rounded-[7px]" />
            <Skeleton className="h-[30px] w-40 rounded-[7px]" />
          </div>
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="flex h-12 items-center gap-4 border-b px-4">
              <Skeleton className="h-4 w-16" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-40 max-w-full" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
              <Skeleton className="h-3.5 w-16" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
