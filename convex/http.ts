import { httpRouter } from "convex/server";
import { authKit } from "./auth";
import { handleCalendlyWebhook } from "./webhooks/calendly";
import { slashCommand } from "./slack/commands";
import { slackEventsStub } from "./slack/inboundStubs";
import { interactivity } from "./slack/interactivity";
import { oauthRedirect } from "./slack/oauth";

const http = httpRouter();
authKit.registerRoutes(http);

http.route({
  path: "/webhooks/calendly",
  method: "POST",
  handler: handleCalendlyWebhook,
});

http.route({
  path: "/slack/oauth_redirect",
  method: "GET",
  handler: oauthRedirect,
});

http.route({
  path: "/slack/commands",
  method: "POST",
  handler: slashCommand,
});

http.route({
  path: "/slack/interactivity",
  method: "POST",
  handler: interactivity,
});

http.route({
  path: "/slack/events",
  method: "POST",
  handler: slackEventsStub,
});

export default http;
