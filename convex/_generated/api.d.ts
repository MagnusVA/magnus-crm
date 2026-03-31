/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_tenants from "../admin/tenants.js";
import type * as admin_tenantsMutations from "../admin/tenantsMutations.js";
import type * as admin_tenantsQueries from "../admin/tenantsQueries.js";
import type * as auth from "../auth.js";
import type * as calendly_oauth from "../calendly/oauth.js";
import type * as calendly_orgMembers from "../calendly/orgMembers.js";
import type * as calendly_tokens from "../calendly/tokens.js";
import type * as calendly_webhookSetup from "../calendly/webhookSetup.js";
import type * as http from "../http.js";
import type * as lib_inviteToken from "../lib/inviteToken.js";
import type * as onboarding_complete from "../onboarding/complete.js";
import type * as onboarding_invite from "../onboarding/invite.js";
import type * as requireSystemAdmin from "../requireSystemAdmin.js";
import type * as tenants from "../tenants.js";
import type * as webhooks_calendly from "../webhooks/calendly.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/tenants": typeof admin_tenants;
  "admin/tenantsMutations": typeof admin_tenantsMutations;
  "admin/tenantsQueries": typeof admin_tenantsQueries;
  auth: typeof auth;
  "calendly/oauth": typeof calendly_oauth;
  "calendly/orgMembers": typeof calendly_orgMembers;
  "calendly/tokens": typeof calendly_tokens;
  "calendly/webhookSetup": typeof calendly_webhookSetup;
  http: typeof http;
  "lib/inviteToken": typeof lib_inviteToken;
  "onboarding/complete": typeof onboarding_complete;
  "onboarding/invite": typeof onboarding_invite;
  requireSystemAdmin: typeof requireSystemAdmin;
  tenants: typeof tenants;
  "webhooks/calendly": typeof webhooks_calendly;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workOSAuthKit: {
    lib: {
      enqueueWebhookEvent: FunctionReference<
        "mutation",
        "internal",
        {
          apiKey: string;
          event: string;
          eventId: string;
          eventTypes?: Array<string>;
          logLevel?: "DEBUG";
          onEventHandle?: string;
          updatedAt?: string;
        },
        any
      >;
      getAuthUser: FunctionReference<
        "query",
        "internal",
        { id: string },
        {
          createdAt: string;
          email: string;
          emailVerified: boolean;
          externalId?: null | string;
          firstName?: null | string;
          id: string;
          lastName?: null | string;
          lastSignInAt?: null | string;
          locale?: null | string;
          metadata: Record<string, any>;
          profilePictureUrl?: null | string;
          updatedAt: string;
        } | null
      >;
    };
  };
};
