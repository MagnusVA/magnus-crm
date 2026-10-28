import { httpRouter } from "convex/server";
import { apiDimensions, apiFreshness, apiFunnel, apiMetrics, apiToday } from "./analytics/api/http";
import { fivetranWebhook } from "./analytics/sync";
import { authKit } from "./auth";
import { handleCalendlyWebhook } from "./webhooks/calendly";
import { slashCommand } from "./slack/commands";
import { handleEvent } from "./slack/events";
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
  handler: handleEvent,
});

// Fivetran `sync_end`: starts the post-sync report batch.
http.route({
  path: "/analytics/fivetran",
  method: "POST",
  handler: fivetranWebhook,
});

// External API v1 (docs/api/openapi.yaml). Keys come from Settings › Integrations.
http.route({ path: "/api/v1/metrics", method: "GET", handler: apiMetrics });
http.route({ path: "/api/v1/funnel", method: "GET", handler: apiFunnel });
http.route({ path: "/api/v1/today", method: "GET", handler: apiToday });
http.route({ path: "/api/v1/freshness", method: "GET", handler: apiFreshness });
http.route({ pathPrefix: "/api/v1/dimensions/", method: "GET", handler: apiDimensions });

export default http;
