import aggregate from "@convex-dev/aggregate/convex.config";
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workOSAuthKit);
app.use(aggregate, { name: "meetingsByStatus" });
app.use(aggregate, { name: "paymentSums" });
app.use(aggregate, { name: "opportunityByStatus" });
app.use(aggregate, { name: "leadTimeline" });
app.use(aggregate, { name: "customerConversions" });

export default app;
