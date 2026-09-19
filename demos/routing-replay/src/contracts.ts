import { z } from "zod";

const ProfileSchema = z
  .object({ profileId: z.string().min(1), role: z.string().min(1), eligible: z.boolean() })
  .strict();

export const ReplayDataSchema = z
  .object({
    schemaVersion: z.literal("jev-routing-replay-v1"),
    label: z.literal("ILLUSTRATIVE OFFLINE REPLAY"),
    task: z
      .object({
        title: z.string().min(1),
        briefing: z.string().min(1),
        requiredCapability: z.string().min(1),
      })
      .strict(),
    profiles: z.array(ProfileSchema).min(2),
    selection: z.object({ status: z.literal("selected"), profileId: z.string().min(1) }).strict(),
    simulatedResult: z
      .object({
        status: z.literal("returned"),
        summary: z.string().min(1),
      })
      .strict(),
    notice: z.literal("Illustrative replay • host owns execution"),
  })
  .strict()
  .superRefine((data, context) => {
    const selected = data.profiles.find(
      (profile) => profile.profileId === data.selection.profileId,
    );
    if (!selected?.eligible) {
      context.addIssue({
        code: "custom",
        message: "selected profile must exist and be eligible",
        path: ["selection", "profileId"],
      });
    }
  });

export type ReplayData = z.infer<typeof ReplayDataSchema>;
