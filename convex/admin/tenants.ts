"use node";

import { WorkOS } from "@workos-inc/node";
import { internalAction } from "../_generated/server";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

// Internal diagnostic for Phase 1 environment validation.
export const testWorkosConnection = internalAction({
  args: {},
  handler: async () => {
    const orgs = await workos.organizations.listOrganizations({ limit: 1 });

    return {
      ok: true,
      orgCount: orgs.data.length,
    };
  },
});
