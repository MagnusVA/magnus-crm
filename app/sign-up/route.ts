import { redirect } from "next/navigation";
import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { NextRequest } from "next/server";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";

export async function GET(request: NextRequest) {
  const organizationId =
    request.nextUrl.searchParams.get("organization_id") ?? SYSTEM_ADMIN_ORG_ID;
  const returnTo =
    request.nextUrl.searchParams.get("returnTo") ?? undefined;

  const authorizationUrl = await getSignUpUrl({
    organizationId,
    returnTo,
  });
  redirect(authorizationUrl);
}
