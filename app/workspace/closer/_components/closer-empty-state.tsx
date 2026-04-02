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
};

/**
 * Reusable empty‑state component for closer dashboard surfaces.
 *
 * Wraps the shadcn `Empty` compound component with a consistent icon treatment
 * and typography style. Pass a custom `icon` to override the default calendar.
 */
export function CloserEmptyState({
  title,
  description,
  icon: Icon = CalendarIcon,
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
    </Empty>
  );
}
