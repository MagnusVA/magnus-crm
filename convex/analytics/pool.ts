import { Workpool } from "@convex-dev/workpool";
import { components } from "../_generated/api";

// The runs pages and API callers start. A page opens one per panel, up to 8
// at once on Lead Gen. With the post-sync batch's 2, at most 4 queries reach
// ClickHouse at a time, magnus_app's limit (clickhouse/admin/magnus_app.sql).
export const analyticsPool = new Workpool(components.analyticsWorkpool, {
  maxParallelism: 2,
});
