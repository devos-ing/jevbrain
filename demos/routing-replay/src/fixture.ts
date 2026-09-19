import { type ReplayData, ReplayDataSchema } from "./contracts.ts";

export const illustrativeReplay: ReplayData = ReplayDataSchema.parse({
  schemaVersion: "jev-routing-replay-v1",
  label: "ILLUSTRATIVE OFFLINE REPLAY",
  task: {
    title: "Make the settings UI responsive",
    briefing: "Make settings responsive while preserving keyboard access and the existing data flow.",
    requiredCapability: "responsive-ui",
  },
  profiles: [
    { profileId: "general-medium", role: "General implementation", eligible: true },
    { profileId: "ui-medium", role: "Responsive UI implementation", eligible: true },
    { profileId: "review-low", role: "Read-only review", eligible: false },
  ],
  selection: { status: "selected", profileId: "ui-medium" },
  simulatedResult: {
    status: "returned",
    summary: "Host verifies and integrates the result.",
  },
  notice: "Illustrative replay • host owns execution",
});
