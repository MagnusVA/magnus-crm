import Image from "next/image";

import { cn } from "@/lib/utils";

const sizeConfig = {
  xs: {
    markSize: 20,
    markClassName: "size-5",
    textClassName: "text-base",
  },
  sm: {
    markSize: 28,
    markClassName: "size-7",
    textClassName: "text-xl",
  },
  md: {
    markSize: 36,
    markClassName: "size-9",
    textClassName: "text-2xl",
  },
  lg: {
    markSize: 52,
    markClassName: "size-[52px]",
    textClassName: "text-4xl",
  },
} as const;

type MagnusBrandProps = {
  label?: string;
  size?: keyof typeof sizeConfig;
  markVariant?: "auto" | "color" | "white";
  showText?: boolean;
  priority?: boolean;
  className?: string;
  markClassName?: string;
  textClassName?: string;
};

export function MagnusBrand({
  label = "MAGNUS CRM",
  size = "sm",
  markVariant = "auto",
  showText = true,
  priority = false,
  className,
  markClassName,
  textClassName,
}: MagnusBrandProps) {
  const config = sizeConfig[size];

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <MagnusMark
        className={cn(config.markClassName, markClassName)}
        priority={priority}
        size={config.markSize}
        variant={markVariant}
      />
      {showText ? (
        <span
          className={cn(
            "min-w-0 truncate font-brand font-light leading-none tracking-normal text-foreground",
            config.textClassName,
            textClassName,
          )}
        >
          {label}
        </span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  );
}

function MagnusMark({
  className,
  priority,
  size,
  variant,
}: {
  className?: string;
  priority: boolean;
  size: number;
  variant: "auto" | "color" | "white";
}) {
  if (variant === "auto") {
    return (
      <span
        aria-hidden="true"
        className={cn("relative shrink-0", className)}
      >
        <Image
          src="/magnus-icon.svg"
          alt=""
          fill
          sizes={`${size}px`}
          priority={priority}
          className="object-contain dark:hidden"
        />
        <Image
          src="/magnus-white.svg"
          alt=""
          fill
          sizes={`${size}px`}
          priority={priority}
          className="hidden object-contain dark:block"
        />
      </span>
    );
  }

  return (
    <Image
      src={variant === "white" ? "/magnus-white.svg" : "/magnus-icon.svg"}
      alt=""
      width={size}
      height={size}
      priority={priority}
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
