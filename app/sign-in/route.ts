import { redirect } from "next/navigation";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";

export async function GET() {
  const authorizationUrl = await getSignInUrl({
    organizationId: SYSTEM_ADMIN_ORG_ID,
  });
  redirect(authorizationUrl);
}
