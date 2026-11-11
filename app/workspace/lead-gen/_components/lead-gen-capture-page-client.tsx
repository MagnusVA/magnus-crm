"use client";

import { useReducer, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation, useQuery } from "convex/react";
import { AtSignIcon, LinkIcon } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { CAPTURE_PANEL_ID, CaptureBand, sourceTabId, type CaptureSource } from "./capture-band";
import { captureConfirmation, type CaptureConfirmation, type CaptureKind } from "@/lib/lead-gen/capture-confirmation";
import { captureProspectSchema, type CaptureProspectValues } from "@/lib/lead-gen/capture-prospect-schema";
import {
  ORIGIN_URL_INPUT_ID,
  OriginChooser,
  OriginChosen,
  type ChosenOrigin,
  type NonRankableInstagramOrigin,
} from "./capture-origin-card";
import { detectInstagramOriginUrl } from "./instagram-origin-detection";
import { CAPTURE_ROOT, ROW_TIME, STATUS_WORD, timeOfDay } from "./setter-ui";

type CaptureSessionState =
  | { source: "meta_business"; step: "enter_prospect" }
  | { source: "instagram"; step: "choose_origin"; postReelDraft: string }
  | { source: "instagram"; step: "enter_prospect"; origin: ChosenOrigin };

type CaptureAction =
  | { type: "sourceChanged"; source: CaptureSource }
  | { type: "postReelDraftChanged"; value: string }
  | { type: "rankableOriginDetected"; origin: Extract<ChosenOrigin, { detectedFromUrl: true }> }
  | { type: "nonRankableOriginSelected"; kind: NonRankableInstagramOrigin }
  | { type: "resetOrigin" };

const initialCaptureSessionState: CaptureSessionState = {
  source: "instagram",
  step: "choose_origin",
  postReelDraft: "",
};

type LastCapture = {
  confirmation: CaptureConfirmation;
  /** What was pasted, as the setter typed it. */
  entered: string;
  submittedAt: number;
};

const PROSPECT_INPUT_ID = "lead-gen-prospect";

/** The last capture's status word: what happened, coloured by meaning. */
const KIND_WORD: Record<CaptureKind, { word: string; ink: string }> = {
  new: { word: "New", ink: "text-foreground" },
  known: { word: "Known", ink: "text-foreground" },
  dupe: { word: "Dupe", ink: "text-muted-foreground" },
  already_saved: { word: "Already saved", ink: "text-muted-foreground" },
  not_a_fit: { word: "Not a fit", ink: "text-muted-foreground" },
  do_not_contact: { word: "Don't contact", ink: "text-danger-ink" },
};

function captureSessionReducer(state: CaptureSessionState, action: CaptureAction): CaptureSessionState {
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
      return { source: "instagram", step: "enter_prospect", origin: action.origin };
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

/** "https://instagram.com/ana.lead/?hl=en" -> "@ana.lead"; a typed handle keeps its own spelling. */
function enteredHandle(raw: string) {
  const value = raw.trim();
  const fromUrl = value.match(/instagram\.com\/([^/?#\s]+)/i)?.[1];
  return `@${(fromUrl ?? value).replace(/^@+/, "")}`;
}

export function LeadGenCapturePageClient() {
  usePageTitle("Capture");
  const submit = useMutation(api.leadGen.capture.submit);
  const { setting, rebuilding, loaded } = useBusinessDay("lead-gen");
  const now = useNow();
  const todayKey = businessDateForInstant(now, setting);
  const daySummary = useQuery(
    api.leadGen.activity.getMyDaySummary,
    rebuilding || !loaded ? "skip" : { dayKey: todayKey },
  );
  const [state, dispatch] = useReducer(captureSessionReducer, initialCaptureSessionState);
  const [lastCapture, setLastCapture] = useState<LastCapture | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [postReelInputBlurred, setPostReelInputBlurred] = useState(false);

  const form = useForm({
    resolver: standardSchemaResolver(captureProspectSchema),
    defaultValues: { rawHandleOrProfileUrl: "" },
  });

  const showOriginInputError =
    state.source === "instagram" &&
    state.step === "choose_origin" &&
    postReelInputBlurred &&
    state.postReelDraft.trim().length > 0 &&
    !detectInstagramOriginUrl(state.postReelDraft);
  const prospectState = state.step === "enter_prospect" ? state : null;
  const isMetaBusiness = state.source === "meta_business";

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
      origin: {
        kind: detected.originKind,
        originUrl: detected.originUrl,
        shortcode: detected.shortcode,
        detectedFromUrl: true,
      },
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

  function handleChangeOrigin() {
    dispatch({ type: "resetOrigin" });
    setPostReelInputBlurred(false);
    resetProspectInput();
    window.setTimeout(() => document.getElementById(ORIGIN_URL_INPUT_ID)?.focus(), 0);
  }

  const onSubmit = async (values: CaptureProspectValues) => {
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
              originUrlOrLabel: prospectState.origin.detectedFromUrl ? prospectState.origin.originUrl : undefined,
              clientSubmissionKey: makeClientSubmissionKey(),
            });

      // eslint-disable-next-line react-hooks/purity -- runs on submit; the compiler can't see past form.handleSubmit
      const submittedAt = Date.now();
      const confirmation = captureConfirmation(result, submittedAt, setting.timeZone);
      setLastCapture({ confirmation, entered: values.rawHandleOrProfileUrl, submittedAt });

      resetProspectInput();
      focusProspectInput();

      // A known person's title doesn't say it was a duplicate, so the detail does.
      const countsAsDupe = result.duplicateProspect && result.person !== undefined;
      const description = [confirmation.detail, countsAsDupe ? "Counts as a dupe." : undefined]
        .filter(Boolean)
        .join(" ");
      toast.success(confirmation.title, description ? { description } : undefined);
    } catch (error) {
      toast.error(getErrorMessage(error, "Capture failed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const ready = prospectState !== null;
  const ProspectIcon = isMetaBusiness ? AtSignIcon : LinkIcon;

  return (
    <div className={CAPTURE_ROOT}>
      <CaptureBand
        day={daySummary}
        dayTip={businessDayDisclosure(setting)}
        rebuilding={rebuilding}
        source={state.source}
        disabled={isSubmitting}
        onSourceChange={handleSourceChange}
      />

      <div
        id={CAPTURE_PANEL_ID}
        role="tabpanel"
        aria-labelledby={sourceTabId(state.source)}
        className="flex min-w-0 flex-col gap-3.5 short:gap-3"
      >
        {state.source === "instagram" ? (
          state.step === "choose_origin" ? (
            <OriginChooser
              draft={state.postReelDraft}
              disabled={isSubmitting}
              showError={showOriginInputError}
              onDraftChange={handlePostReelInputChange}
              onBlur={() => setPostReelInputBlurred(true)}
              onPick={handleNonRankableOriginSelect}
            />
          ) : (
            <OriginChosen origin={state.origin} disabled={isSubmitting} onChange={handleChangeOrigin} />
          )
        ) : null}

        <section aria-label="Capture a prospect" className={cn(CARD, "@container/capture")}>
          <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="px-4 py-3.5">
            <Controller
              control={form.control}
              name="rawHandleOrProfileUrl"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid} className="gap-1.5">
                  <FieldLabel htmlFor={PROSPECT_INPUT_ID} className="text-[13px] font-normal text-muted-foreground">
                    {isMetaBusiness ? "Handle" : "Profile URL"}
                  </FieldLabel>
                  <div className="grid gap-2 @md/capture:grid-cols-[minmax(0,1fr)_auto]">
                    <InputGroup className="h-11">
                      <InputGroupAddon>
                        <ProspectIcon aria-hidden="true" />
                      </InputGroupAddon>
                      <InputGroupInput
                        {...field}
                        id={PROSPECT_INPUT_ID}
                        aria-invalid={fieldState.invalid}
                        aria-describedby={
                          fieldState.error ? `${PROSPECT_INPUT_ID}-error` : ready ? undefined : `${PROSPECT_INPUT_ID}-hint`
                        }
                        autoCapitalize="none"
                        autoComplete="off"
                        autoCorrect="off"
                        disabled={!ready || isSubmitting}
                        inputMode={isMetaBusiness ? "text" : "url"}
                        placeholder={isMetaBusiness ? "@prospect" : "https://instagram.com/prospect"}
                        spellCheck={false}
                        type="text"
                        className="text-[15px]"
                      />
                    </InputGroup>
                    <Button
                      type="submit"
                      disabled={!ready || isSubmitting}
                      className="h-11 w-full touch-manipulation px-5 text-[15px] font-semibold @md/capture:w-auto"
                    >
                      {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                      {isSubmitting ? "Capturing…" : "Capture"}
                    </Button>
                  </div>
                  {fieldState.error ? (
                    <FieldError id={`${PROSPECT_INPUT_ID}-error`} className="text-[13px] text-danger-ink">
                      {fieldState.error.message}
                    </FieldError>
                  ) : null}
                  {ready ? null : (
                    <p id={`${PROSPECT_INPUT_ID}-hint`} className="text-[13px] text-muted-foreground">
                      Pick an origin first.
                    </p>
                  )}
                </Field>
              )}
            />
          </form>
          {lastCapture ? <LastCaptureLine capture={lastCapture} timeZone={setting.timeZone} /> : null}
        </section>
      </div>

    </div>
  );
}

/** The last paste as one ruled line: the status word, the handle, what the CRM knew, the time. */
function LastCaptureLine({ capture, timeZone }: { capture: LastCapture; timeZone: string }) {
  const { word, ink } = KIND_WORD[capture.confirmation.kind];
  const handle = enteredHandle(capture.entered);
  return (
    <div
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-t border-border px-4 py-2.5"
    >
      <span className={cn(STATUS_WORD, ink)}>
        <span className="sr-only">Last capture: </span>
        {word}
      </span>
      <span className="truncate text-sm font-medium" title={capture.entered} translate="no">
        {handle}
      </span>
      <time dateTime={new Date(capture.submittedAt).toISOString()} className={cn(ROW_TIME, "text-muted-foreground")}>
        {timeOfDay(capture.submittedAt, timeZone)}
      </time>
      <p className="col-span-3 text-[13px] text-muted-foreground">
        <span className="font-medium text-foreground">{capture.confirmation.title}</span>
        {capture.confirmation.detail ? <>. {capture.confirmation.detail}</> : null}
      </p>
    </div>
  );
}
