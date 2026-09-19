# Context handoff

Jevbrain separates profile selection from worker context. The host supplies the routing brief and candidate sources. The context splitter validates those inputs against a trusted policy and produces a verbatim manifest plus a declarative grant.

The splitter does not scan the repository, fetch files named by metadata, summarize source text, detect secrets, route the task, or enforce runtime permissions.

## Source classes

The host classifies each supplied source for the current delegation:

| Class | Use |
| --- | --- |
| Required | The worker cannot complete the task safely without it. |
| Shared | Multiple delegations may use the same approved read-only source. |
| Task evidence | Code excerpts, error output, contracts, or completed upstream results for this task. |
| Optional | Helpful material that the task can complete without. |
| Forbidden | Material that must not enter the manifest or worker packet. |

Classification is task-specific. Splitting a conversation into equal chunks is not a context policy.

## Trusted policy and request data

The request provides the approved brief and references candidate source IDs. A separate trusted policy owns source text, logical repository namespace, availability, sharing rules, ownership, mandatory IDs, and the declarative permissions associated with admitted sources.

Request data cannot replace source text, claim ownership, change sharing rules, or grant permissions. Schema validation proves only that policy data is well formed; the host remains responsible for supplying an authentic policy.

A source enters the manifest only when it is allowed, available, inside the exact logical namespace, and permitted for the current delegation. Forbidden sources never enter. A private source is admitted only for its owning delegation.

Mandatory policy sources and request-required sources form one required set. If any required source is missing or blocked, the splitter returns `needs_context` and does not produce a partial grant.

## Verbatim provenance

Admitted text remains unchanged. The splitter sorts entries by source ID and records a content digest and UTF-8 byte count from the supplied text. It preserves the approved brief, constraints, decisions, acceptance criteria, source category, and origin.

Source IDs, digests, and a grant are evidence and correlation data. They do not authorize filesystem reads, writes, tools, network access, or provider egress. The runtime must enforce those boundaries separately.

## Sharing across delegations

Delegations may reference the same approved read-only source, but each delegation keeps its own manifest, grant, write scope, and result. A worker's progress or inference does not become another worker's trusted input until the host verifies and shares it explicitly.

Provider egress is a separate decision from local sharing. A source admitted to a local manifest is not automatically approved for Jev or another external provider.

## Deferred context features

The released flow preserves admitted sources verbatim. It does not compress source text, perform semantic retrieval, replace chat history, or support general follow-up reads. Context compression and repository retrieval remain deferred.

When an integration eventually builds a worker packet, it must preserve required sources, provenance, exceptions, negative constraints, and unknown states. If required content exceeds a limit, the safe result is an explicit budget failure rather than silent deletion.

## Verification boundary

The implemented `context-v1` stage verifies deterministic filtering, required-source handling, stable ordering, verbatim text, digests, UTF-8 byte counts, and safe serialization with offline fixtures. It does not prove that a runtime enforced the declared grant or that a worker received only the manifest contents.
