"use client";

import { useMemo, useState, type ComponentType, type SVGProps } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation, useQuery } from "convex/react";
import {
  AtSignIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  LinkIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const BUSINESS_DAY_START_OFFSET_MS = 60 * 60 * 1000;

const captureSchema = z
  .object({
    source: z.enum(["instagram", "meta_business"]),
    rawHandleOrProfileUrl: z.string().trim(),
    originKind: z.enum([
      "post",
      "reel",
      "story_poll",
      "follower",
      "application",
    ]),
    originUrlOrLabel: z.string().trim().optional(),
  })
  .superRefine((values, ctx) => {
    if (values.rawHandleOrProfileUrl.length > 0) return;

    ctx.addIssue({
      code: "custom",
      message:
        values.source === "meta_business"
          ? "Handle is required"
          : "Profile URL is required",
      path: ["rawHandleOrProfileUrl"],
    });
  });

type CaptureValues = z.infer<typeof captureSchema>;

type LastResult = {
  duplicateProspect: boolean;
  duplicateRetry: boolean;
  submittedAt: number;
  prospectId: string;
};

const originOptions = [
  { value: "post", label: "Post" },
  { value: "reel", label: "Reel" },
  { value: "story_poll", label: "Story Poll" },
  { value: "follower", label: "Follower" },
  { value: "application", label: "Application" },
] as const;

const META_BUSINESS_ORIGIN_KIND = "source_only";

function makeClientSubmissionKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function businessDayKey(timestamp: number) {
  const shifted = new Date(timestamp - BUSINESS_DAY_START_OFFSET_MS);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HONDURAS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function formatSubmittedAt(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(timestamp);
}

export function LeadGenCapturePageClient() {
  const submit = useMutation(api.leadGen.capture.submit);
  const todayKey = useMemo(() => businessDayKey(Date.now()), []);
  const daySummary = useQuery(api.leadGen.activity.getMyDaySummary, {
    dayKey: todayKey,
  });
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm({
    resolver: standardSchemaResolver(captureSchema),
    defaultValues: {
      source: "instagram",
      rawHandleOrProfileUrl: "",
      originKind: "post",
      originUrlOrLabel: "",
    },
  });

  const source = form.watch("source");
  const originKind = form.watch("originKind");
  const isMetaBusinessSource = source === "meta_business";
  const originNeedsUrl = originKind === "post" || originKind === "reel";
  const ProspectInputIcon = isMetaBusinessSource ? AtSignIcon : LinkIcon;
  const prospectInputLabel = isMetaBusinessSource ? "Handle" : "Profile URL";
  const prospectInputMode = isMetaBusinessSource ? "text" : "url";
  const prospectInputPlaceholder = isMetaBusinessSource
    ? "@prospect"
    : "https://instagram.com/prospect...";

  const onSubmit = async (values: CaptureValues) => {
    setIsSubmitting(true);

    try {
      const result = await submit({
        source: values.source,
        rawHandleOrProfileUrl: values.rawHandleOrProfileUrl,
        originKind:
          values.source === "meta_business"
            ? META_BUSINESS_ORIGIN_KIND
            : values.originKind,
        originUrlOrLabel:
          values.source === "meta_business"
            ? undefined
            : values.originUrlOrLabel?.trim() || undefined,
        clientSubmissionKey: makeClientSubmissionKey(),
      });

      setLastResult({
        duplicateProspect: result.duplicateProspect,
        duplicateRetry: result.duplicateRetry,
        submittedAt: Date.now(),
        prospectId: result.prospectId,
      });

      form.reset({
        source: values.source,
        rawHandleOrProfileUrl: "",
        originKind:
          values.source === "meta_business" ? "post" : values.originKind,
        originUrlOrLabel:
          values.source === "meta_business"
            ? ""
            : values.originUrlOrLabel ?? "",
      });

      toast.success(
        result.duplicateProspect
          ? "Duplicate prospect attempt captured"
          : "New prospect captured",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Capture failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal text-pretty">
          Capture Prospect
        </h1>
        <p className="text-sm text-muted-foreground">
          Submit Instagram and Meta Business prospects without entering worker
          identity.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <CaptureMetric
          label="Today"
          value={daySummary?.submissions}
          icon={ClipboardCheckIcon}
        />
        <CaptureMetric
          label="Unique"
          value={daySummary?.uniqueProspects}
          icon={SparklesIcon}
        />
        <CaptureMetric
          label="Dupes"
          value={daySummary?.duplicates}
          icon={RotateCcwIcon}
        />
      </div>

      {lastResult ? <LastCaptureResult result={lastResult} /> : null}

      <Form {...form}>
        <form
          className="flex flex-col gap-5"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <FormField
            control={form.control}
            name="source"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Source</FormLabel>
                <FormControl>
                  <ToggleGroup
                    type="single"
                    value={field.value}
                    onValueChange={(value) => {
                      if (!value) return;
                      field.onChange(value);
                      if (value === "meta_business") {
                        form.setValue("originUrlOrLabel", "");
                      }
                    }}
                    className="grid w-full grid-cols-2"
                    variant="outline"
                  >
                    <ToggleGroupItem className="w-full" value="instagram">
                      Instagram
                    </ToggleGroupItem>
                    <ToggleGroupItem className="w-full" value="meta_business">
                      Meta Business
                    </ToggleGroupItem>
                  </ToggleGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="rawHandleOrProfileUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{prospectInputLabel}</FormLabel>
                <FormControl>
                  <InputGroup className="h-11">
                    <InputGroupAddon>
                      <ProspectInputIcon aria-hidden="true" />
                    </InputGroupAddon>
                    <InputGroupInput
                      {...field}
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      disabled={isSubmitting}
                      inputMode={prospectInputMode}
                      name="rawHandleOrProfileUrl"
                      placeholder={prospectInputPlaceholder}
                      spellCheck={false}
                      type="text"
                    />
                  </InputGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {isMetaBusinessSource ? null : (
            <>
              <FormField
                control={form.control}
                name="originKind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Origin</FormLabel>
                    <FormControl>
                      <ToggleGroup
                        type="single"
                        value={field.value}
                        onValueChange={(value) => {
                          if (!value) return;
                          field.onChange(value);
                          if (value !== "post" && value !== "reel") {
                            form.setValue("originUrlOrLabel", "");
                          }
                        }}
                        className="grid w-full grid-cols-2 sm:grid-cols-3"
                        variant="outline"
                      >
                        {originOptions.map((option) => (
                          <ToggleGroupItem
                            className="w-full min-w-0"
                            key={option.value}
                            value={option.value}
                          >
                            <span className="truncate">{option.label}</span>
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {originNeedsUrl ? (
                <FormField
                  control={form.control}
                  name="originUrlOrLabel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Post or Reel URL</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          autoCapitalize="none"
                          autoComplete="off"
                          autoCorrect="off"
                          disabled={isSubmitting}
                          inputMode="url"
                          name="originUrlOrLabel"
                          placeholder="https://instagram.com/p/..."
                          spellCheck={false}
                          type="url"
                        />
                      </FormControl>
                      <FormDescription>
                        Posts and reels are ranked in reports; other origins stay
                        audit-only.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
            </>
          )}

          <Button
            className="h-11 w-full touch-manipulation"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <CheckCircle2Icon data-icon="inline-start" />
            )}
            {isSubmitting ? "Capturing..." : "Capture Prospect"}
          </Button>
        </form>
      </Form>
    </div>
  );
}

function CaptureMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | undefined;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}) {
  return (
    <div className="flex min-h-20 min-w-0 flex-col justify-between rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <Icon aria-hidden="true" className="text-muted-foreground" />
      </div>
      <span className="text-2xl font-semibold tabular-nums">
        {value ?? "-"}
      </span>
    </div>
  );
}

function LastCaptureResult({ result }: { result: LastResult }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.duplicateProspect ? "outline" : "secondary"}>
          {result.duplicateProspect ? "Duplicate Prospect" : "New Prospect"}
        </Badge>
        {result.duplicateRetry ? (
          <Badge variant="outline">Retry Ignored</Badge>
        ) : null}
      </div>
      <p className="min-w-0 truncate text-sm text-muted-foreground">
        Last submission {formatSubmittedAt(result.submittedAt)}
      </p>
    </div>
  );
}
