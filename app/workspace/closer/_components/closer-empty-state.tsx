import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { CalendarIcon } from "lucide-react";

type CloserEmptyStateProps = {
  title: string;
  description: string;
  icon?: React.ComponentType;
  children?: React.ReactNode;
};

/**
 * Reusable empty‑state component for closer dashboard surfaces.
 *
 * Wraps the shadcn `Empty` compound component with a consistent icon treatment
 * and typography style. Pass a custom `icon` to override the default calendar.
 * Optional `children` can be used for extra content (CTAs, guidance, etc.).
 */
export function CloserEmptyState({
  title,
  description,
  icon: Icon = CalendarIcon,
  children,
}: CloserEmptyStateProps) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children}
    </Empty>
  );
}
