"use client";

import Link from "next/link";
import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useBreadcrumbs } from "@/hooks/use-breadcrumbs";

interface WorkspaceBreadcrumbsProps {
  /**
   * Override the label for a specific segment by href.
   * Used for dynamic routes like /meetings/[id] where
   * the label should be the lead name, not the raw ID.
   */
  overrides?: Record<string, string>;
}

export function WorkspaceBreadcrumbs({ overrides }: WorkspaceBreadcrumbsProps) {
  const segments = useBreadcrumbs();

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
