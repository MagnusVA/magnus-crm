/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_inviteCleanup from "../admin/inviteCleanup.js";
import type * as admin_inviteCleanupMutations from "../admin/inviteCleanupMutations.js";
import type * as admin_tenants from "../admin/tenants.js";
import type * as admin_tenantsMutations from "../admin/tenantsMutations.js";
import type * as admin_tenantsQueries from "../admin/tenantsQueries.js";
import type * as auth from "../auth.js";
import type * as calendly_healthCheck from "../calendly/healthCheck.js";
import type * as calendly_healthCheckMutations from "../calendly/healthCheckMutations.js";
import type * as calendly_oauth from "../calendly/oauth.js";
import type * as calendly_oauthMutations from "../calendly/oauthMutations.js";
import type * as calendly_oauthQueries from "../calendly/oauthQueries.js";
import type * as calendly_orgMembers from "../calendly/orgMembers.js";
import type * as calendly_orgMembersMutations from "../calendly/orgMembersMutations.js";
import type * as calendly_orgMembersQueries from "../calendly/orgMembersQueries.js";
import type * as calendly_tokenMutations from "../calendly/tokenMutations.js";
import type * as calendly_tokens from "../calendly/tokens.js";
import type * as calendly_webhookSetup from "../calendly/webhookSetup.js";
import type * as calendly_webhookSetupMutations from "../calendly/webhookSetupMutations.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_inviteToken from "../lib/inviteToken.js";
import type * as lib_roleMapping from "../lib/roleMapping.js";
import type * as lib_statusTransitions from "../lib/statusTransitions.js";
import type * as lib_validation from "../lib/validation.js";
import type * as onboarding_complete from "../onboarding/complete.js";
import type * as onboarding_invite from "../onboarding/invite.js";
import type * as pipeline_inviteeCanceled from "../pipeline/inviteeCanceled.js";
import type * as pipeline_inviteeCreated from "../pipeline/inviteeCreated.js";
import type * as pipeline_inviteeNoShow from "../pipeline/inviteeNoShow.js";
import type * as pipeline_mutations from "../pipeline/mutations.js";
import type * as pipeline_processor from "../pipeline/processor.js";
import type * as pipeline_queries from "../pipeline/queries.js";
import type * as requireSystemAdmin from "../requireSystemAdmin.js";
import type * as requireTenantUser from "../requireTenantUser.js";
import type * as tenants from "../tenants.js";
import type * as users_linkCalendlyMember from "../users/linkCalendlyMember.js";
import type * as users_queries from "../users/queries.js";
import type * as webhooks_calendly from "../webhooks/calendly.js";
import type * as webhooks_calendlyMutations from "../webhooks/calendlyMutations.js";
import type * as webhooks_calendlyQueries from "../webhooks/calendlyQueries.js";
import type * as webhooks_cleanup from "../webhooks/cleanup.js";
import type * as webhooks_cleanupMutations from "../webhooks/cleanupMutations.js";
import type * as workos_roles from "../workos/roles.js";
import type * as workos_userManagement from "../workos/userManagement.js";
import type * as workos_userMutations from "../workos/userMutations.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/inviteCleanup": typeof admin_inviteCleanup;
  "admin/inviteCleanupMutations": typeof admin_inviteCleanupMutations;
  "admin/tenants": typeof admin_tenants;
  "admin/tenantsMutations": typeof admin_tenantsMutations;
  "admin/tenantsQueries": typeof admin_tenantsQueries;
  auth: typeof auth;
  "calendly/healthCheck": typeof calendly_healthCheck;
  "calendly/healthCheckMutations": typeof calendly_healthCheckMutations;
  "calendly/oauth": typeof calendly_oauth;
  "calendly/oauthMutations": typeof calendly_oauthMutations;
  "calendly/oauthQueries": typeof calendly_oauthQueries;
  "calendly/orgMembers": typeof calendly_orgMembers;
  "calendly/orgMembersMutations": typeof calendly_orgMembersMutations;
  "calendly/orgMembersQueries": typeof calendly_orgMembersQueries;
  "calendly/tokenMutations": typeof calendly_tokenMutations;
  "calendly/tokens": typeof calendly_tokens;
  "calendly/webhookSetup": typeof calendly_webhookSetup;
  "calendly/webhookSetupMutations": typeof calendly_webhookSetupMutations;
  crons: typeof crons;
  http: typeof http;
  "lib/constants": typeof lib_constants;
  "lib/identity": typeof lib_identity;
  "lib/inviteToken": typeof lib_inviteToken;
  "lib/roleMapping": typeof lib_roleMapping;
  "lib/statusTransitions": typeof lib_statusTransitions;
  "lib/validation": typeof lib_validation;
  "onboarding/complete": typeof onboarding_complete;
  "onboarding/invite": typeof onboarding_invite;
  "pipeline/inviteeCanceled": typeof pipeline_inviteeCanceled;
  "pipeline/inviteeCreated": typeof pipeline_inviteeCreated;
  "pipeline/inviteeNoShow": typeof pipeline_inviteeNoShow;
  "pipeline/mutations": typeof pipeline_mutations;
  "pipeline/processor": typeof pipeline_processor;
  "pipeline/queries": typeof pipeline_queries;
  requireSystemAdmin: typeof requireSystemAdmin;
  requireTenantUser: typeof requireTenantUser;
  tenants: typeof tenants;
  "users/linkCalendlyMember": typeof users_linkCalendlyMember;
  "users/queries": typeof users_queries;
  "webhooks/calendly": typeof webhooks_calendly;
  "webhooks/calendlyMutations": typeof webhooks_calendlyMutations;
  "webhooks/calendlyQueries": typeof webhooks_calendlyQueries;
  "webhooks/cleanup": typeof webhooks_cleanup;
  "webhooks/cleanupMutations": typeof webhooks_cleanupMutations;
  "workos/roles": typeof workos_roles;
  "workos/userManagement": typeof workos_userManagement;
  "workos/userMutations": typeof workos_userMutations;
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
