# Actual capture/deny download policy checkpoint

Created 2026-11-09T04:23:38.271Z. Source35 pinned at C:/AIWork/2026-11-08/CDP1935261/client/download-policy-resumption/handoff-9dElP9/manifest.json; prior image/cache handoff-XLM9h1 is unchanged.

## Literal normalization

CreateSession.args.options.downloadPolicy omitted defaults to capture. Explicit capture or deny only. Null, booleans, numeric0, DENY, empty, allow, object and array reject INVALID_WIRE. No new public tool/alias/model parameter. Full effective args continue to participate in creation HMAC/dedup.

## Implemented

Five feature files changed: contract/browser/client/download-capture/downloads. Helper create(owner, limits, policy='capture') uses the exact nondefault browserContextId proved from its owned anchor Page. Context acceptDownloads matches policy. Capture retains allowAndName/default behavior. Deny uses scoped native deny; no reserved file bytes, completedFile is unavailable, verification/artifact admission cannot occur. Only real native events are recorded with their existing same DownloadId; optional nativeState records actual progress. No synthetic denial event is promised if Chromium is silent. No app transaction cancellation or rollback is inferred. Existing cookies, quotas, owners and native stream are retained.

## Actual evidence

Native workflow PASS6, exit0 at 2026-11-09T04:18:44.510Z; report C:/AIWork/2026-11-08/CDP1935261/client/download-policy-resumption/workflow-41V44q/report.json; exit C:/AIWork/2026-11-08/CDP1935261/client/download-policy-resumption/stage-workflow-uudAfF/exit.json; all35 before/after hashes equal. This actual Chrome emitted started/progress/canceled for deny, with artifact/hash/size null and empty staging. Server request still completed. Default capture admitted real artifacts before and after deny. A separate capture context inside the SAME Browser had a different exact native context ID and remained usable; closing only that context did not affect denied context/cookies. Both core sessions completed four cleanup flags; sibling staging removed; final pending0/journalClosed.

Admission: 36 syntax/import commands, 3 normalized positives/9 negatives, actual exit0. Native paths are controlled owned loopback; no public platform/provider/full-project acceptance. No new noEmit run is claimed. Corpus with 335 untouched actual pairs: C:/AIWork/2026-11-08/CDP1935261/client/download-policy-resumption/handoff-9dElP9/CdpWire.v1.download-policy.fixture.json.

## Capabilities

sessionCapabilities.downloadPolicies=['capture','deny']; downloadCapabilities.nativeDeny=true, denyProducesArtifacts=false, policyScope='exact owned browserContextId', denyEventCoverage='observed native events only; native denial may be silent', applicationRollbackClaimed=false. Existing defaults/revision/IDs remain. Paired backend support is Pending.

No runtime failure occurred in this phase. Pre-run scratch corrections matched existing envelope shape/UTF8 payload and required genuinely new capture IDs, without weakening runtime assertions. No unrelated helpers, server, credentials, dependencies or main startup changed. No main/poller/SQL/provider/services/deploy/commit/push. All old pins and historic failed resources remain untouched. Other mandatory variants remain separately Pending.
