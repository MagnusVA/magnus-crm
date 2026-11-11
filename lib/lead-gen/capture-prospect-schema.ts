import { z } from "zod";
import { INVALID_INSTAGRAM_HANDLE_MESSAGE, normalizeInstagramHandle } from "./instagram-handle";

/**
 * The capture form's prospect field. It lives here, not beside the form, so
 * a test can hold it to the handles the capture mutation accepts.
 */
export const captureProspectSchema = z.object({
  rawHandleOrProfileUrl: z
    .string()
    .trim()
    .min(1, "Paste a profile URL or handle first.")
    // An empty field already has its own message above.
    .refine(
      (value) => value.length === 0 || normalizeInstagramHandle(value) !== undefined,
      INVALID_INSTAGRAM_HANDLE_MESSAGE,
    ),
});

export type CaptureProspectValues = z.infer<typeof captureProspectSchema>;
