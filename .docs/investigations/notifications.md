Great use case! Instead of using crons (which, as you noted, would be inefficient at scale), the best approach in Convex is to use **scheduled functions** (`ctx.scheduler.runAfter` or `ctx.scheduler.runAt`).

## How it works

When a meeting is **created or updated**, you schedule a function to run exactly 5 minutes before the meeting starts. This means you only schedule one function per meeting, rather than polling all meetings every 5 minutes. [[Scheduled Functions](https://docs.convex.dev/scheduling/scheduled-functions)]

Here's a rough example:

```ts
// convex/meetings.ts
import { mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

export const scheduleMeeting = mutation({
	args: {
		userId: v.id("users"),
		meetingTime: v.number(), // timestamp in ms since epoch
		title: v.string(),
	},
	handler: async (ctx, args) => {
		const meetingId = await ctx.db.insert("meetings", {
			userId: args.userId,
			meetingTime: args.meetingTime,
			title: args.title,
		});

		// Schedule a notification 5 minutes before the meeting
		const notifyAt = args.meetingTime - 5 * 60 * 1000;

		await ctx.scheduler.runAt(
			notifyAt,
			internal.meetings.sendMeetingReminder,
			{ meetingId },
		);
	},
});

export const sendMeetingReminder = internalMutation({
	args: { meetingId: v.id("meetings") },
	handler: async (ctx, args) => {
		const meeting = await ctx.db.get(args.meetingId);
		if (!meeting) return;

		// Write a notification record to the DB
		await ctx.db.insert("notifications", {
			userId: meeting.userId,
			message: `Your meeting "${meeting.title}" starts in 5 minutes!`,
			read: false,
		});
	},
});
```

## Why this is efficient

- **One scheduled function per meeting**, not a cron scanning all users every 5 minutes. This scales linearly with the number of meetings, not users. [[Scheduled Functions](https://docs.convex.dev/scheduling/scheduled-functions)]
- **Scheduled mutations are guaranteed to execute exactly once** and are automatically retried on transient errors. [[Scheduler Interface](https://docs.convex.dev/api/interfaces/server.Scheduler)]

## Surfacing the notification in the UI

Since Convex is **reactive by default**, your Next.js frontend can subscribe to the `notifications` table for the current user. When the scheduled mutation writes a notification record, the client will automatically receive it in real time via WebSocket — no polling needed. [[Presence with Convex](https://stack.convex.dev/presence-with-convex#how-convex-makes-it-easy)]

This is the recommended Convex pattern: write the event to the database, and let the sync engine push it to the client. [[SSE Notifications](https://discord.com/channels/1019350475847499849/1421520589797068840)]

## Optional: Mobile push notifications

If you also need to notify users who aren't actively on the dashboard (e.g., mobile), Convex has an **Expo Push Notifications component** that handles batching and retries. [[Expo Push Notifications](https://www.convex.dev/components/push-notifications)]
