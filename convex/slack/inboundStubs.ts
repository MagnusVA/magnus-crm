import { httpAction } from "../_generated/server";
import { verifySlackSignature } from "../lib/slackSignature";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";

async function verifyInboundSlackRequest(
  req: Request,
  rawBody: string,
): Promise<boolean> {
  return await verifySlackSignature({
    rawBody,
    timestamp: req.headers.get(TS_HEADER) ?? "",
    signature: req.headers.get(SIG_HEADER) ?? "",
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    previousSigningSecret: process.env.SLACK_SIGNING_SECRET_PREVIOUS,
  });
}

export const slackCommandStub = httpAction(async (_ctx, req) => {
  const rawBody = await req.text();
  if (!(await verifyInboundSlackRequest(req, rawBody))) {
    return new Response("Bad signature", { status: 401 });
  }

  return new Response(
    JSON.stringify({
      response_type: "ephemeral",
      text: "Slack lead qualification is still being deployed. Please try again later.",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});

export const slackInteractivityStub = httpAction(async (_ctx, req) => {
  const rawBody = await req.text();
  if (!(await verifyInboundSlackRequest(req, rawBody))) {
    return new Response("Bad signature", { status: 401 });
  }

  return new Response("", { status: 200 });
});

export const slackEventsStub = httpAction(async (_ctx, req) => {
  const rawBody = await req.text();
  if (!(await verifyInboundSlackRequest(req, rawBody))) {
    return new Response("Bad signature", { status: 401 });
  }

  let body: { type?: string; challenge?: string } | null = null;
  try {
    body = JSON.parse(rawBody) as { type?: string; challenge?: string };
  } catch {
    return new Response("", { status: 200 });
  }

  if (body?.type === "url_verification") {
    return new Response(body.challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response("", { status: 200 });
});
