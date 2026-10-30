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
  markVariant?: "auto" | "color" | "white" | "lime";
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
  variant: "auto" | "color" | "white" | "lime";
}) {
  if (variant === "lime") {
    // The bare M in brand lime, for the navy shell in both themes.
    return (
      <svg
        viewBox="200 255 390 340"
        aria-hidden="true"
        className={cn("shrink-0 fill-primary", className)}
      >
        <path d="M394.1 566.9c0 13.9 19.1 18 24.7 5.2L473 449.8h-78.9V566.9zM370.4 320.2l-42.1 64.7c-5.6 8.6-18.2 8.5-23.6-.2L235.3 273c-6.8-11-23.9-6.2-23.9 6.8v154c0 8.8 7.2 16 16 16h140.1h26.5V327.2c0-12.8-16.7-17.8-23.6-7zM550.3 275.2L473 449.8h86c8.8 0 16-7.2 16-16V280.4c0-14-19.1-18-24.7-5.2z" />
      </svg>
    );
  }

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
