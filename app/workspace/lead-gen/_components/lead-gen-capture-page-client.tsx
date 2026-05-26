"use client";

import {
  useMemo,
  useReducer,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation, useQuery } from "convex/react";
import {
  AtSignIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  FileTextIcon,
  LinkIcon,
  MessageCircleIcon,
  RotateCcwIcon,
  SparklesIcon,
  UsersIcon,
  VideoIcon,
} from "lucide-react";
import { useForm, type Control } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  detectInstagramOriginUrl,
  type DetectedInstagramOrigin,
} from "./instagram-origin-detection";

const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const BUSINESS_DAY_START_OFFSET_MS = 60 * 60 * 1000;

type CaptureSource = "instagram" | "meta_business";
type NonRankableInstagramOrigin = "story_poll" | "follower" | "application";

type InstagramOriginSession =
  | {
      kind: "post" | "reel";
      originUrl: string;
      shortcode: string;
      detectedFromUrl: true;
    }
  | {
      kind: NonRankableInstagramOrigin;
      detectedFromUrl: false;
    };

type CaptureSessionState =
  | {
      source: "meta_business";
      step: "enter_prospect";
    }
  | {
      source: "instagram";
      step: "choose_origin";
      postReelDraft: string;
    }
  | {
      source: "instagram";
      step: "enter_prospect";
      origin: InstagramOriginSession;
    };

type CaptureAction =
  | { type: "sourceChanged"; source: CaptureSource }
  | { type: "postReelDraftChanged"; value: string }
  | {
      type: "rankableOriginDetected";
      origin: Extract<InstagramOriginSession, { detectedFromUrl: true }>;
    }
  | { type: "nonRankableOriginSelected"; kind: NonRankableInstagramOrigin }
  | { type: "resetOrigin" };

type ProspectCaptureState = Extract<
  CaptureSessionState,
  { step: "enter_prospect" }
>;

const initialCaptureSessionState: CaptureSessionState = {
  source: "instagram",
  step: "choose_origin",
  postReelDraft: "",
};

const prospectSchema = z.object({
  rawHandleOrProfileUrl: z.string().trim().min(1, "Profile URL is required"),
});

type ProspectValues = z.infer<typeof prospectSchema>;

type LastResult = {
  duplicateProspect: boolean;
  duplicateRetry: boolean;
  submittedAt: number;
  prospectId: string;
};

const sourceOptions = [
  { value: "instagram", label: "Instagram" },
  { value: "meta_business", label: "Meta Business" },
] as const;

const nonRankableInstagramOrigins = [
  { value: "story_poll", label: "Story Poll", icon: MessageCircleIcon },
  { value: "follower", label: "Follower", icon: UsersIcon },
  { value: "application", label: "Application", icon: FileTextIcon },
] as const;

function captureSessionReducer(
  state: CaptureSessionState,
  action: CaptureAction,
): CaptureSessionState {
  switch (action.type) {
    case "sourceChanged":
      return action.source === "meta_business"
        ? { source: "meta_business", step: "enter_prospect" }
        : { source: "instagram", step: "choose_origin", postReelDraft: "" };
    case "postReelDraftChanged":
      if (state.source !== "instagram" || state.step !== "choose_origin") {
        return state;
      }
      return { ...state, postReelDraft: action.value };
    case "rankableOriginDetected":
      return {
        source: "instagram",
        step: "enter_prospect",
        origin: action.origin,
      };
    case "nonRankableOriginSelected":
      return {
        source: "instagram",
        step: "enter_prospect",
        origin: { kind: action.kind, detectedFromUrl: false },
      };
    case "resetOrigin":
      return { source: "instagram", step: "choose_origin", postReelDraft: "" };
  }
}

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

function isCaptureSource(value: string): value is CaptureSource {
  return value === "instagram" || value === "meta_business";
}

function rankableOriginFromDetection(
  detected: DetectedInstagramOrigin,
): Extract<InstagramOriginSession, { detectedFromUrl: true }> {
  return {
    kind: detected.originKind,
    originUrl: detected.originUrl,
    shortcode: detected.shortcode,
    detectedFromUrl: true,
  };
}

export function LeadGenCapturePageClient() {
  const submit = useMutation(api.leadGen.capture.submit);
  const todayKey = useMemo(() => businessDayKey(Date.now()), []);
  const daySummary = useQuery(api.leadGen.activity.getMyDaySummary, {
    dayKey: todayKey,
  });
  const [state, dispatch] = useReducer(
    captureSessionReducer,
    initialCaptureSessionState,
  );
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [postReelInputBlurred, setPostReelInputBlurred] = useState(false);

  const form = useForm({
    resolver: standardSchemaResolver(prospectSchema),
    defaultValues: {
      rawHandleOrProfileUrl: "",
    },
  });

  const showOriginInputError =
    state.source === "instagram" &&
    state.step === "choose_origin" &&
    postReelInputBlurred &&
    state.postReelDraft.trim().length > 0 &&
    !detectInstagramOriginUrl(state.postReelDraft);
  const prospectState = state.step === "enter_prospect" ? state : null;

  function resetProspectInput() {
    form.reset({ rawHandleOrProfileUrl: "" });
  }

  function focusProspectInput() {
    window.setTimeout(() => form.setFocus("rawHandleOrProfileUrl"), 0);
  }

  function handleSourceChange(source: CaptureSource) {
    dispatch({ type: "sourceChanged", source });
    setPostReelInputBlurred(false);
    resetProspectInput();

    if (source === "meta_business") {
      focusProspectInput();
    }
  }

  function handlePostReelInputChange(value: string) {
    dispatch({ type: "postReelDraftChanged", value });

    const detected = detectInstagramOriginUrl(value);
    if (!detected) return;

    dispatch({
      type: "rankableOriginDetected",
      origin: rankableOriginFromDetection(detected),
    });
    setPostReelInputBlurred(false);
    resetProspectInput();
    focusProspectInput();
  }

  function handleNonRankableOriginSelect(kind: NonRankableInstagramOrigin) {
    dispatch({ type: "nonRankableOriginSelected", kind });
    setPostReelInputBlurred(false);
    resetProspectInput();
    focusProspectInput();
  }

  function handleResetSession() {
    if (state.source === "instagram") {
      dispatch({ type: "resetOrigin" });
    } else {
      dispatch({ type: "sourceChanged", source: "instagram" });
    }

    setPostReelInputBlurred(false);
    resetProspectInput();
  }

  const onSubmit = async (values: ProspectValues) => {
    if (!prospectState) {
      toast.error("Choose an origin before capturing a prospect");
      return;
    }

    setIsSubmitting(true);

    try {
      const result =
        prospectState.source === "meta_business"
          ? await submit({
              source: "meta_business",
              rawHandleOrProfileUrl: values.rawHandleOrProfileUrl,
              originKind: "source_only",
              originUrlOrLabel: undefined,
              clientSubmissionKey: makeClientSubmissionKey(),
            })
          : await submit({
              source: "instagram",
              rawHandleOrProfileUrl: values.rawHandleOrProfileUrl,
              originKind: prospectState.origin.kind,
              originUrlOrLabel: prospectState.origin.detectedFromUrl
                ? prospectState.origin.originUrl
                : undefined,
              clientSubmissionKey: makeClientSubmissionKey(),
            });

      setLastResult({
        duplicateProspect: result.duplicateProspect,
        duplicateRetry: result.duplicateRetry,
        submittedAt: Date.now(),
        prospectId: result.prospectId,
      });

      resetProspectInput();
      focusProspectInput();

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
          High-volume social prospect capture for active lead-gen sessions.
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

      <SourceSelector
        disabled={isSubmitting}
        onChange={handleSourceChange}
        value={state.source}
      />

      {state.source === "instagram" && state.step === "choose_origin" ? (
        <InstagramOriginStep
          draft={state.postReelDraft}
          disabled={isSubmitting}
          onBlur={() => setPostReelInputBlurred(true)}
          onDraftChange={handlePostReelInputChange}
          onSelectNonRankable={handleNonRankableOriginSelect}
          showInputError={showOriginInputError}
        />
      ) : null}

      {prospectState ? (
        <Form {...form}>
          <form
            className="flex flex-col gap-5"
            onSubmit={form.handleSubmit(onSubmit)}
          >
            <ActiveSessionSummary
              disabled={isSubmitting}
              onReset={handleResetSession}
              state={prospectState}
            />

            <ProspectInput
              control={form.control}
              disabled={isSubmitting}
              source={prospectState.source}
            />

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

            {lastResult ? <LastCaptureResult result={lastResult} /> : null}
          </form>
        </Form>
      ) : null}
    </div>
  );
}

function SourceSelector({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (value: CaptureSource) => void;
  value: CaptureSource;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Source</Label>
      <ToggleGroup
        aria-label="Source"
        className="grid w-full grid-cols-2"
        disabled={disabled}
        onValueChange={(nextValue) => {
          if (!nextValue || !isCaptureSource(nextValue) || nextValue === value) {
            return;
          }
          onChange(nextValue);
        }}
        type="single"
        value={value}
        variant="outline"
      >
        {sourceOptions.map((option) => (
          <ToggleGroupItem
            className="w-full min-w-0"
            key={option.value}
            value={option.value}
          >
            <span className="truncate">{option.label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function InstagramOriginStep({
  disabled,
  draft,
  onBlur,
  onDraftChange,
  onSelectNonRankable,
  showInputError,
}: {
  disabled: boolean;
  draft: string;
  onBlur: () => void;
  onDraftChange: (value: string) => void;
  onSelectNonRankable: (value: NonRankableInstagramOrigin) => void;
  showInputError: boolean;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-normal">
          Instagram Origin
        </h2>
        <p className="text-sm text-muted-foreground">
          Post, reel, story poll, follower, or application batch.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="lead-gen-origin-url">Post or Reel URL</Label>
        <InputGroup className="h-11">
          <InputGroupAddon>
            <LinkIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-invalid={showInputError}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={disabled}
            id="lead-gen-origin-url"
            inputMode="url"
            onBlur={onBlur}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="https://instagram.com/reel/..."
            spellCheck={false}
            type="text"
            value={draft}
          />
        </InputGroup>
        {showInputError ? (
          <p className="text-sm font-medium text-destructive">
            Enter an Instagram post or reel URL.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {nonRankableInstagramOrigins.map((option) => {
          const Icon = option.icon;

          return (
            <Button
              className="h-10 justify-start"
              disabled={disabled}
              key={option.value}
              onClick={() => onSelectNonRankable(option.value)}
              type="button"
              variant="outline"
            >
              <Icon data-icon="inline-start" />
              <span className="truncate">{option.label}</span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

function ActiveSessionSummary({
  disabled,
  onReset,
  state,
}: {
  disabled: boolean;
  onReset: () => void;
  state: ProspectCaptureState;
}) {
  const summary = getSessionSummary(state);
  const Icon = summary.icon;

  return (
    <section className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
          <Icon aria-hidden="true" className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline">{summary.badge}</Badge>
            <span className="truncate text-sm font-medium">
              {summary.title}
            </span>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {summary.detail}
          </p>
        </div>
      </div>
      <Button
        className="shrink-0"
        disabled={disabled}
        onClick={onReset}
        size="sm"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon data-icon="inline-start" />
        {state.source === "meta_business" ? "Change" : "Reset"}
      </Button>
    </section>
  );
}

function ProspectInput({
  control,
  disabled,
  source,
}: {
  control: Control<ProspectValues>;
  disabled: boolean;
  source: CaptureSource;
}) {
  const isMetaBusinessSource = source === "meta_business";
  const ProspectInputIcon = isMetaBusinessSource ? AtSignIcon : LinkIcon;
  const prospectInputLabel = isMetaBusinessSource ? "Handle" : "Profile URL";
  const prospectInputMode = isMetaBusinessSource ? "text" : "url";
  const prospectInputPlaceholder = isMetaBusinessSource
    ? "@prospect"
    : "https://instagram.com/prospect";

  return (
    <FormField
      control={control}
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
                disabled={disabled}
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
  );
}

function getSessionSummary(state: ProspectCaptureState): {
  badge: string;
  detail: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
} {
  if (state.source === "meta_business") {
    return {
      badge: "Meta Business",
      detail: "Source-only capture",
      icon: AtSignIcon,
      title: "Active source",
    };
  }

  const { origin } = state;
  if (origin.detectedFromUrl) {
    const isReel = origin.kind === "reel";

    return {
      badge: isReel ? "Reel" : "Post",
      detail: origin.originUrl,
      icon: isReel ? VideoIcon : FileTextIcon,
      title: origin.shortcode,
    };
  }

  const option = nonRankableInstagramOrigins.find(
    (item) => item.value === origin.kind,
  );

  return {
    badge: "Instagram",
    detail: "Non-rankable origin",
    icon: option?.icon ?? MessageCircleIcon,
    title: option?.label ?? "Origin",
  };
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
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
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
