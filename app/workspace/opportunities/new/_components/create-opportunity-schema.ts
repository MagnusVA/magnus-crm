import { z } from "zod";

const socialPlatformSchema = z.enum([
	"instagram",
	"tiktok",
	"twitter",
	"facebook",
	"linkedin",
	"other_social",
]);

export function createOpportunitySchema({
	requireAssignedCloser,
}: {
	requireAssignedCloser: boolean;
}) {
	return z
		.object({
			leadMode: z.enum(["existing", "new"]),
			existingLeadId: z.string().optional(),
			newFullName: z.string().optional(),
			newEmail: z
				.string()
				.email("Enter a valid email")
				.optional()
				.or(z.literal("")),
			newPhone: z.string().max(50, "Phone is too long").optional().or(z.literal("")),
			newSocialPlatform: socialPlatformSchema.optional(),
			newSocialHandle: z
				.string()
				.max(100, "Social handle is too long")
				.optional()
				.or(z.literal("")),
			assignedCloserId: z.string().optional(),
			notes: z
				.string()
				.max(2000, "Notes must be 2,000 characters or fewer")
				.optional()
				.or(z.literal("")),
		})
		.superRefine((data, ctx) => {
			if (data.leadMode === "existing" && !data.existingLeadId) {
				ctx.addIssue({
					code: "custom",
					message: "Select a lead",
					path: ["existingLeadId"],
				});
			}

			if (data.leadMode === "new") {
				if (!data.newFullName?.trim()) {
					ctx.addIssue({
						code: "custom",
						message: "Full name is required",
						path: ["newFullName"],
					});
				}

				if (!data.newEmail?.trim()) {
					ctx.addIssue({
						code: "custom",
						message: "Email is required for new leads in MVP",
						path: ["newEmail"],
					});
				}

				if (data.newSocialPlatform && !data.newSocialHandle?.trim()) {
					ctx.addIssue({
						code: "custom",
						message: "Enter the handle",
						path: ["newSocialHandle"],
					});
				}

				if (!data.newSocialPlatform && data.newSocialHandle?.trim()) {
					ctx.addIssue({
						code: "custom",
						message: "Pick a platform",
						path: ["newSocialPlatform"],
					});
				}
			}

			if (requireAssignedCloser && !data.assignedCloserId) {
				ctx.addIssue({
					code: "custom",
					message: "Pick an active closer",
					path: ["assignedCloserId"],
				});
			}
		});
}

export type CreateOpportunityFormValues = z.infer<
	ReturnType<typeof createOpportunitySchema>
>;

export type SocialPlatform = z.infer<typeof socialPlatformSchema>;
