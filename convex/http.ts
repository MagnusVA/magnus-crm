import { httpRouter } from "convex/server";
import { authKit } from "./auth";
import { handleCalendlyWebhook } from "./webhooks/calendly";

const http = httpRouter();
authKit.registerRoutes(http);

http.route({
  path: "/webhooks/calendly",
  method: "POST",
  handler: handleCalendlyWebhook,
});

export default http;
