import { describe, expect, test } from "bun:test";
import type { ContextSplitRequest, TrustedContextPolicy } from "../src/context/contracts.ts";
import { contentDigest } from "../src/context/digest.ts";
import { splitContext } from "../src/context/split-context.ts";

const briefing = {
  objective: "Preserve this objective verbatim.  ",
  acceptanceCriteria: ["Keep every admitted source unchanged."],
  constraints: ["Do not infer missing evidence."],
  decisions: ["Use the trusted catalog as supplied."],
};

function readyRequest(): ContextSplitRequest {
  return {
    delegationId: "delegation-a",
    briefing,
    references: [
      { sourceId: "source-optional", category: "optional", relevanceLabel: "example" },
      { sourceId: "source-shared", category: "shared", relevanceLabel: "project rule" },
      { sourceId: "source-evidence", category: "evidence", relevanceLabel: "observed output" },
      { sourceId: "source-required", category: "required", relevanceLabel: "task constraint" },
    ],
  };
}

function readyPolicy(): TrustedContextPolicy {
  return {
    delegationId: "delegation-a",
    policyVersion: "1.0.0",
    repositoryNamespace: "repo:synthetic",
    allowShared: true,
    allowedSourceIds: [
      "source-required",
      "source-shared",
      "source-evidence",
      "source-optional",
      "source-mandatory",
    ],
    mandatorySourceIds: ["source-mandatory"],
    catalog: [
      {
        sourceId: "source-required",
        sourceVersion: "1.0.0",
        repositoryNamespace: "repo:synthetic",
        visibility: "delegation_private",
        ownerDelegationId: "delegation-a",
        availability: { status: "available", text: "required text\n" },
      },
      {
        sourceId: "source-shared",
        sourceVersion: "1.0.0",
        repositoryNamespace: "repo:synthetic",
        visibility: "shared",
        availability: { status: "available", text: "shared text" },
      },
      {
        sourceId: "source-evidence",
        sourceVersion: "1.0.0",
        repositoryNamespace: "repo:synthetic",
        visibility: "delegation_private",
        ownerDelegationId: "delegation-a",
        availability: { status: "available", text: "evidence: café" },
      },
      {
        sourceId: "source-optional",
        sourceVersion: "1.0.0",
        repositoryNamespace: "repo:synthetic",
        visibility: "shared",
        availability: { status: "available", text: "optional text" },
      },
      {
        sourceId: "source-mandatory",
        sourceVersion: "1.0.0",
        repositoryNamespace: "repo:synthetic",
        visibility: "shared",
        availability: { status: "available", text: "policy mandatory text" },
      },
    ],
  };
}

describe("context split", () => {
  test("preserves briefing and all admitted text with stable ordering and provenance", () => {
    const first = splitContext(readyRequest(), readyPolicy());
    const second = splitContext(readyRequest(), readyPolicy());
    expect(first).toEqual(second);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("expected ready context");
    expect(first.manifest.briefing).toEqual(briefing);
    expect(first.manifest.entries.map(({ sourceId }) => sourceId)).toEqual([
      "source-evidence",
      "source-mandatory",
      "source-optional",
      "source-required",
      "source-shared",
    ]);
    const evidence = first.manifest.entries.find(({ sourceId }) => sourceId === "source-evidence");
    expect(evidence).toMatchObject({
      text: "evidence: café",
      contentDigest: contentDigest("evidence: café"),
      utf8Bytes: 15,
    });
    const mandatory = first.manifest.entries.find(
      ({ sourceId }) => sourceId === "source-mandatory",
    );
    expect(mandatory).toMatchObject({
      category: "required",
      relevanceLabel: null,
      text: "policy mandatory text",
    });
    expect(first.grant).toMatchObject({
      grantKind: "data_sharing_only",
      enforcement: "declarative",
    });
  });

  test("required references cannot expose denied sources and public output does not leak canaries", () => {
    const request = {
      delegationId: "delegation-a",
      briefing,
      references: [
        { sourceId: "forbidden-id-canary", category: "required", relevanceLabel: "required" },
        { sourceId: "sibling-id-canary", category: "required", relevanceLabel: "required" },
        { sourceId: "namespace-id-canary", category: "required", relevanceLabel: "required" },
        { sourceId: "unlisted-id-canary", category: "required", relevanceLabel: "required" },
      ],
    };
    const policy = {
      delegationId: "delegation-a",
      policyVersion: "1.0.0",
      repositoryNamespace: "repo:synthetic",
      allowShared: true,
      allowedSourceIds: ["forbidden-id-canary", "sibling-id-canary", "namespace-id-canary"],
      mandatorySourceIds: [],
      catalog: [
        {
          sourceId: "forbidden-id-canary",
          sourceVersion: "1.0.0",
          repositoryNamespace: "repo:synthetic",
          visibility: "forbidden",
          availability: { status: "available", text: "FORBIDDEN_TEXT_CANARY" },
        },
        {
          sourceId: "sibling-id-canary",
          sourceVersion: "1.0.0",
          repositoryNamespace: "repo:synthetic",
          visibility: "delegation_private",
          ownerDelegationId: "sibling-owner-canary",
          availability: { status: "available", text: "SIBLING_TEXT_CANARY" },
        },
        {
          sourceId: "namespace-id-canary",
          sourceVersion: "1.0.0",
          repositoryNamespace: "repo:other-canary",
          visibility: "shared",
          availability: { status: "available", text: "NAMESPACE_TEXT_CANARY" },
        },
        {
          sourceId: "unlisted-id-canary",
          sourceVersion: "1.0.0",
          repositoryNamespace: "repo:synthetic",
          visibility: "shared",
          availability: { status: "available", text: "UNLISTED_TEXT_CANARY" },
        },
      ],
    };
    const output = JSON.stringify(splitContext(request, policy));
    expect(JSON.parse(output)).toEqual({
      status: "needs_context",
      reason: "required_context_unavailable",
      missingRequiredCount: 4,
      omissions: { denied: 4, unavailable: 0 },
    });
    for (const canary of [
      "forbidden-id-canary",
      "sibling-id-canary",
      "sibling-owner-canary",
      "namespace-id-canary",
      "repo:other-canary",
      "unlisted-id-canary",
      "FORBIDDEN_TEXT_CANARY",
      "SIBLING_TEXT_CANARY",
      "NAMESPACE_TEXT_CANARY",
      "UNLISTED_TEXT_CANARY",
    ]) {
      expect(output).not.toContain(canary);
    }
    expect(output).not.toContain("grant");
  });

  test("pending mandatory context returns needs_context without a partial grant", () => {
    const policy = readyPolicy();
    policy.catalog = policy.catalog.map((entry) =>
      entry.sourceId === "source-mandatory"
        ? { ...entry, availability: { status: "pending" as const } }
        : entry,
    );
    const outcome = splitContext(readyRequest(), policy);
    expect(outcome).toEqual({
      status: "needs_context",
      reason: "required_context_unavailable",
      missingRequiredCount: 1,
      omissions: { denied: 0, unavailable: 1 },
    });
  });

  test("trusted mandatory sources survive omitted and downgraded request references", () => {
    const omitted = splitContext(
      { delegationId: "delegation-a", briefing, references: [] },
      readyPolicy(),
    );
    expect(omitted.status).toBe("ready");
    if (omitted.status !== "ready") throw new Error("expected mandatory-only ready context");
    expect(omitted.manifest.entries).toHaveLength(1);
    expect(omitted.manifest.entries[0]).toMatchObject({
      sourceId: "source-mandatory",
      category: "required",
      relevanceLabel: null,
    });

    const request = readyRequest();
    request.references.push({
      sourceId: "source-mandatory",
      category: "optional",
      relevanceLabel: "caller attempted downgrade",
    });
    const downgraded = splitContext(request, readyPolicy());
    expect(downgraded.status).toBe("ready");
    if (downgraded.status !== "ready") throw new Error("expected ready context");
    expect(
      downgraded.manifest.entries.find(({ sourceId }) => sourceId === "source-mandatory"),
    ).toMatchObject({ category: "required" });
  });

  test("rejects duplicates, request-side permission injection, and delegation mismatch safely", () => {
    const duplicateRequest = readyRequest();
    const firstReference = duplicateRequest.references[0];
    if (firstReference === undefined) throw new Error("fixture request has no references");
    duplicateRequest.references.push(firstReference);
    expect(splitContext(duplicateRequest, readyPolicy())).toEqual({
      status: "rejected",
      reason: "invalid_request",
    });
    expect(
      splitContext(
        {
          ...readyRequest(),
          references: [
            {
              sourceId: "source-required",
              category: "required",
              relevanceLabel: "required",
              visibility: "shared",
              ownerDelegationId: "delegation-a",
            },
          ],
        },
        readyPolicy(),
      ),
    ).toEqual({ status: "rejected", reason: "invalid_request" });
    expect(
      splitContext(readyRequest(), { ...readyPolicy(), delegationId: "delegation-b" }),
    ).toEqual({ status: "rejected", reason: "delegation_mismatch" });
  });

  test("changing admitted text changes content and manifest digests", () => {
    const first = splitContext(readyRequest(), readyPolicy());
    const changedPolicy = readyPolicy();
    changedPolicy.catalog = changedPolicy.catalog.map((entry) =>
      entry.sourceId === "source-evidence"
        ? { ...entry, availability: { status: "available" as const, text: "changed evidence" } }
        : entry,
    );
    const changed = splitContext(readyRequest(), changedPolicy);
    expect(first.status).toBe("ready");
    expect(changed.status).toBe("ready");
    if (first.status !== "ready" || changed.status !== "ready") throw new Error("expected ready");
    expect(changed.manifest.manifestDigest).not.toBe(first.manifest.manifestDigest);
    expect(changed.manifest.entries[0]?.contentDigest).not.toBe(
      first.manifest.entries[0]?.contentDigest,
    );
  });
});
