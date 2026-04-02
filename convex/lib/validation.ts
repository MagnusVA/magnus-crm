/** Minimum company name length after trimming. */
const MIN_COMPANY_NAME_LENGTH = 2;
/** Maximum company name length. */
const MAX_COMPANY_NAME_LENGTH = 256;
/** Default maximum length for generic identifier-like strings. */
const MAX_REQUIRED_STRING_LENGTH = 256;
/** Maximum email length (RFC 5321). */
const MAX_EMAIL_LENGTH = 254;

/**
 * RFC 5322-ish email regex — catches the vast majority of invalid emails
 * without being overly strict. Rejects empty strings, missing @, etc.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ValidationResult =
  | {
      valid: true;
    }
  | {
      valid: false;
      error: string;
    };

export function validateRequiredString(
  value: string,
  {
    fieldName,
    maxLength = MAX_REQUIRED_STRING_LENGTH,
  }: {
    fieldName: string;
    maxLength?: number;
  },
): ValidationResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} is required.` };
  }
  if (trimmed.length > maxLength) {
    return {
      valid: false,
      error: `${fieldName} must not exceed ${maxLength} characters.`,
    };
  }
  return { valid: true };
}

export function validateCompanyName(name: string): ValidationResult {
  const trimmed = name.trim();
  if (trimmed.length < MIN_COMPANY_NAME_LENGTH) {
    return {
      valid: false,
      error: `Company name must be at least ${MIN_COMPANY_NAME_LENGTH} characters.`,
    };
  }
  if (trimmed.length > MAX_COMPANY_NAME_LENGTH) {
    return {
      valid: false,
      error: `Company name must not exceed ${MAX_COMPANY_NAME_LENGTH} characters.`,
    };
  }
  return { valid: true };
}

export function validateEmail(email: string): ValidationResult {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0) {
    return { valid: false, error: "Email is required." };
  }
  if (trimmed.length > MAX_EMAIL_LENGTH) {
    return {
      valid: false,
      error: `Email must not exceed ${MAX_EMAIL_LENGTH} characters.`,
    };
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    return { valid: false, error: "Invalid email format." };
  }
  return { valid: true };
}
