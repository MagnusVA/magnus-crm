"use client";

import Link from "next/link";
import { Fragment, useContext, useMemo, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  BreadcrumbTrailContext,
  useBreadcrumbs,
  type BreadcrumbSegment,
} from "@/hooks/use-breadcrumbs";

/** Holds the trail a page sets with `useBreadcrumbTrail`, for the shell's header. */
export function BreadcrumbTrailProvider({ children }: { children: React.ReactNode }) {
  const [trail, setTrail] = useState<BreadcrumbSegment[] | null>(null);
  const store = useMemo(() => ({ trail, setTrail }), [trail]);
  return <BreadcrumbTrailContext value={store}>{children}</BreadcrumbTrailContext>;
}

interface WorkspaceBreadcrumbsProps {
  /**
   * Override the label for a specific segment by href.
   * Used for dynamic routes like /meetings/[id] where
   * the label should be the lead name, not the raw ID.
   */
  overrides?: Record<string, string>;
}

export function WorkspaceBreadcrumbs({ overrides }: WorkspaceBreadcrumbsProps) {
  const derived = useBreadcrumbs();
  const segments = useContext(BreadcrumbTrailContext)?.trail ?? derived;

  if (segments.length <= 1) return null;

  const resolvedSegments = segments.map((seg) => ({
    ...seg,
    label: overrides?.[seg.href] ?? seg.label,
  }));

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {resolvedSegments.map((segment, idx) => {
          const isLast = idx === resolvedSegments.length - 1;
          return (
            <Fragment key={segment.href}>
              {idx > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{segment.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={segment.href}>{segment.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
