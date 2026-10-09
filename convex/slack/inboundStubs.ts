import { httpAction } from "../_generated/server";
import { verifyInboundSlackRequest } from "../lib/slackSignature";

export const slackCommandStub = httpAction(async (_ctx, req) => {
  const rawBody = await req.text();
  if (await verifyInboundSlackRequest(req, rawBody, "commands_stub")) {
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
  if (await verifyInboundSlackRequest(req, rawBody, "interactivity_stub")) {
    return new Response("Bad signature", { status: 401 });
  }

  return new Response("", { status: 200 });
});

export const slackEventsStub = httpAction(async (_ctx, req) => {
  const rawBody = await req.text();
  if (await verifyInboundSlackRequest(req, rawBody, "events_stub")) {
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
