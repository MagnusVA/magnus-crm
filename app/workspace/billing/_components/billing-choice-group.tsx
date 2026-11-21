"use client";

import { useId, type ReactNode } from "react";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

export type ChoiceOption<T extends string> = {
  value: T;
  label: ReactNode;
  description?: ReactNode;
};

/**
 * A required single choice as a real radio group: a fieldset whose legend
 * names the question, one ruled row per option.
 */
export function ChoiceGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
  disabled,
  invalid,
  className,
}: {
  legend: ReactNode;
  options: ReadonlyArray<ChoiceOption<T>>;
  value: T | "";
  onChange: (value: T) => void;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const ids = useId();
  const legendId = `${ids}-legend`;
  return (
    <FieldSet className={cn("min-w-0 gap-0", className)}>
      <FieldLegend id={legendId} variant="label" className="mb-1.5 text-[13px]">
        {legend}
      </FieldLegend>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate.value === next);
          if (option) onChange(option.value);
        }}
        aria-labelledby={legendId}
        aria-required
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className="gap-0 overflow-hidden rounded-[7px] border"
      >
        {options.map((option) => {
          const id = `${ids}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className="flex min-h-11 cursor-pointer items-start gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/60 has-[[data-state=checked]]:bg-muted/60"
            >
              <RadioGroupItem value={option.value} id={id} className="mt-0.5" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[14px] font-medium">{option.label}</span>
                {option.description ? (
                  <span className="text-[13px] text-muted-foreground">{option.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </FieldSet>
  );
}
