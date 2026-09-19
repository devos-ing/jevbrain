import { expect, test } from "bun:test";
import { getReplayData } from "../scripts/extract.ts";
import { ReplayDataSchema } from "../src/contracts.ts";

test("exports a safe illustrative replay with an eligible selected profile", () => {
  const data = ReplayDataSchema.parse(getReplayData());
  expect(data.label).toBe("ILLUSTRATIVE OFFLINE REPLAY");
  expect(
    data.profiles.find((profile) => profile.profileId === data.selection.profileId)?.eligible,
  ).toBe(true);
  expect(data.notice).toBe("Illustrative replay • host owns execution");

  const serialized = JSON.stringify(data);
  expect(serialized).not.toContain("/Users/");
  expect(serialized).not.toContain("TYPESAFE_API_KEY");
  expect(serialized).not.toContain("Authorization");
  expect(serialized).not.toContain("model");
});
