> Historical turn4 snapshot, preserved below. Current client integration, the independent HIGH140 cleanup finding and its correction, current validation, and both unresolved scratch leftovers are documented in `cdp-integration-status.md`. Statements below about unapproved shared hooks and unchanged CreateSession defaults describe that earlier snapshot, not the current source. Reviewer143 identified that the former cached-incomplete cleanup path could falsely complete a later close; this has a new focused correction and requires current-source independent verification.

# CDP feature-local input and retained image increment

Parent conversation 1935261. Client checkout `C:\Code\aiqa-cdp\BenAIClient`, branch CDP, HEAD `3a25866ba303472aa540cc8c914bba64b44ecfa1`. This is current turn4 status. `cdp-browser-status.md` below its historical banner preserves the prior turn3 evidence verbatim.

## Scope and review boundary

Feature modules only. No server.js, config, package/lock, server-source, shared registration, logger/body/provider hook or framework edits in this increment. No npm invocation, browser download, AIQA poller, service startup/restart, deployment, commit, push, email or delegated worker. All new runtime stores, images and owned browser profiles were under `C:\AIWork\2026-11-08\CDP1935261\client` in fresh real Windows private ACL directories. No normal Chrome profile, OS focus or global keyboard input.

Independent reviewer board114 cleared the exact prior six-source snapshot with its own repros. That historical clearance does not automatically approve this increment. Seven current source hashes are in `turn4-mechanics-source-hashes.json` in scratch and the final input fixture report. New source needs coordinator review. Prior reports and old source hashes were not overwritten.

## Implemented

- `cdp-contract.mts`: strict additional v1 ReadArtifact, Click, Fill and PressKey schemas/defaults. Existing positive golden/default normalization remains unchanged. Structured targets follow spec role/testId/label/placeholder/text/css, optional name only for role, exact, frameId and withinElementId, or elementId/documentId/frameId. Unknown fields, invented ordinal, mixed value/SecretRef and unsupported key chords reject. Mutating inputs require ActionId and opaque server fingerprint.
- `cdp-targets.mts`: class-owned Node ElementHandle references, bounded to 1,000 per document. No app globals or DOM identity attributes. Exact one-match resolution, retained container scope, main-frame ownership, stale/detached/replaced/foreign checks and expected document validation. Public read-only visibility/enabled/stability and Fill editability checks occur before the durable dispatch barrier. Public browser click performs normal hit testing and scrolling after the barrier. No forced click, locator-first fallback or retarget of a detached handle.
- `cdp-client.mts`: per-page preparation exclusion plus existing SQLite dispatch exclusion; separate retained named operations and responsive GetCall. After fresh acceptance, input preparation resolves the target, then the committed one-use dispatch barrier precedes public ElementHandle click/fill/press. Duplicate IDs return existing receipts without another input. Post-barrier exceptions conservatively become uncertain through the existing outcome path, never an automatic retry. Receipts/results identify mechanics, not application/business success.
- `cdp-store.mts`: optional nonsensitive resolved target evidence is committed in the same dispatch barrier transaction and retained on failure/completion. No raw selector, value, body or script is persisted. Added authorized artifact capture/expiry metadata read reuses existing getArtifact ACL. Recovery and accounting remain unchanged. Coordinator board123 subsequently authorized the narrow owner CloseSession cleanup exception described below; it does not reconcile or replay uncertain input.
- `cdp-browser.mts`: main-frame target composition, document invalidation, safe frame metadata and current page/pending-dialog state. Pending native dialogs block new unrelated input. Dialog resolution remains unsupported. Frame metadata explicitly marks children unsupported; no child-frame fallback.
- `cdp-artifacts.mts`: real ReadArtifact wire handler supports retained PNG metadata and optional actual validated image transfer. Capture/expiry time, original stored dimensions/hash and resized delivery dimensions/hash/scaling are distinct. Owner or exact stored immediate parent/account/client ACL plus requested session must match. Retrieval works after verified browser close. PNG offsets other than zero and all text/binary pagination explicitly fail unsupported. MaxBytes is not image truncation. The preexisting direct authorized PNG API remains compatible.
- `cdp-private-directory.mts`: unchanged from independently reviewed source.

## Public defaults and actual limitations

ReadArtifact args: artifactId required; offset 0; maxBytes 16000; attachImage false; maxImageDimension 1600; maxImageMiB 8. Session required, page omitted. Transfer fields are exactly artifactId, encoding base64, mimeType image/png, byteLength, sha256, width, height, dataBase64. Bytes are not dumped into textual result metadata. Provider/model image delivery is not integrated or claimed.

Click: target required, button left, clickCount 1, modifiers [], options timeoutMs 10000 and expectedDocumentId null. Left/right and single/double gestures use public browser input. Fill: exactly one value or SecretRef; sensitive false and same options. SecretRef explicitly unsupported because no approved resolver exists. Empty string is a valid value. Supported Fill controls are text/search/email/url/tel/password inputs, textarea and contenteditable. No value readback is returned, even for nonsensitive input.

PressKey: key required, target null, same action options. Vocabulary: Enter, Tab, Shift+Tab, Escape, ArrowUp/Down/Left/Right, Space, Backspace, Delete, Home, End, PageUp, PageDown, and Control/Meta/ControlOrMeta plus A or a, Enter, Home, End, ArrowLeft or ArrowRight. No clipboard, browser-navigation/tab/window or OS-global shortcuts. Target null captures the active element in the explicit page. A focused child frame explicitly fails unsupported.

Main frame only. TestId/CSS do not accept exact=false as an implemented behavior. There is no invented ordinal. Observe is bounded rendered DOM, not hidden-element inspection, accessibility-tree completeness or app view-model access. Observation cursors, watches, network/body adapters, file/download, dialog resolution, general Evaluate, pointer/drag, JPEG, headful, general real-app navigation and macOS are unsupported. All navigation/network containment remains the single trusted owned 127.0.0.1 fixture origin. No Node TTL authority was added; server C# TempCache remains the planned authoritative live lookup.

## Sensitive input

Full normalized effective Fill parameters, including sensitive plaintext, participate in the independent private keyed digest. The journal retains only the digest and nonsensitive target identity, not arguments. Provider error strings, raw Playwright diagnostics, traces and values are not logged or returned.

Sensitive=true or a password target marks the entire owned session sensitive. Known literal echoes are redacted from subsequent tool observations. New screenshots across that session fail closed, because masking arbitrary DOM/canvas/application echoes is not proven. This is conservative, not a promise to erase a literal already persisted in a caller's request or preexisting evidence. SecretRef has no resolver. Live plaintext is retained only in bounded session memory for known-literal redaction, not SQLite/artifacts.

## Actual validation

The first reports below preserve the pre-cleanup-correction increment evidence. Final corrected-source reruns are listed in the final handoff section; they do not erase the earlier snapshots or failed original schema-only negative.

Commands used package-free Node execution, not a new framework:

- `node groundwork-qc.mts`: original script correctly stops at the former invalid structured Observe schema case. This is retained in `turn4-groundwork-console.txt`, not reported as PASS.
- `node groundwork-turn4-qc.mts`: 24 groups PASS. Original 23 journal/ownership/recovery/quota checks retained, with only that obsolete static negative moved to runtime frame rejection, plus durable target metadata/no plaintext check. Report `qc-70a0a04b-2b32-459a-b7e3-c2f0f3d0f033\report.json`. Synthetic SQLite records, clean reopen and controlled durability failures, not actual browser/crash claims.
- `node inventory-qc.mts`: original 5 groups PASS. Report `inventory-qc-eb81d92a-dbc6-495c-8e43-d6dd414de254\report.json`.
- `node browser-qc.mts`: original 18 groups PASS. Report `browser-qc-0c974826-fc7b-43e6-b077-e7711bf4b41f\report.json`. Actual installed Chrome 157.0.8103.38, Playwright 1.65.0, Node 24.22.2 Windows x64. Both browsers/hosts/profiles/TEMP roots verified removed, including same-call late close completion after the real 1ms deadline.
- `node input-qc.mts`: final 15 groups PASS. Report `input-qc-999f5a5f-c2b9-4c5f-8d67-d8d81b56c56e\report.json`. All seven source hashes captured before execution and unchanged at completion. Real Chrome and SQLite, two pages, actual trusted click/fill/keyboard/double-click/right-click events and application-visible fixture state, all six selector strategies, scoped IDs/Observe, empty Fill, duplicate Click/Fill/PressKey causing zero new corresponding input events, changed arguments conflicting, and hidden/disabled/ambiguous/stale/foreign rejection before dispatch. Actual PNG ReadArtifact bytes/scaling/hash and parent ACL, sensitive echo/image policy, full retained private-file plaintext scan, responsive GetCall during target preparation, page exclusion and retained parent reads after close.
- Final input run public owned proof: host PID 5132, Chrome PID 7948, generated profile leaf playwright_chromiumdev_profile-0SJa9G. Browser exit, host exit, profile removal and dedicated TEMP removal all true. No pending session. Fixture listener closes in finally and process exits.
- Seven source modules pass `node --check`. This is runtime syntax/import/fixture validation, not a TypeScript static compiler build. Git tracked diff whitespace check is separate and is not claimed to cover untracked files automatically.

Original positive shared golden cases/defaults were preserved. Old golden invalid Observe target with frameId child-frame was invalid only because structured targets were previously unsupported. It now normalizes structurally, while the real target fixture rejects the actual unknown/child frame without fallback. Board121 records this precise intentional expansion. No server-owned golden was edited; sibling must version its expanded target contract coherently.

## Authorized owner-cleanup correction

Board122 established the former primitive limitation with controlled SQLite state: an uncertain page input also fenced fresh CloseSession. Coordinator board123 explicitly authorized the smallest cleanup-only correction after the current run finished.

Only owner CloseSession skips the unresolved-input fence, under its own normal dedup identity and committed dispatch barrier. Click/Fill/PressKey/CreatePage and other business input remain fenced. Parent inspection cannot mutate. Store dispatchStarted busy exclusion is unchanged. The manager additionally rejects cleanup while any other named same-session browser operation is unfinished, including an uncertain close whose actual mechanics continue. Unknown outcome is never misrepresented as resolved. Capacity is released only after the owned public process/profile cleanup succeeds and CloseSession completes. The original input receipt, target and first uncertainty history remain unchanged.

Actual installed-Chrome cleanup fixture PASS5: `cleanup-qc-07975e70-4bd0-48ef-9911-0b2cc14c61ba\\report.json`. A real click sent one fixture commit then opened a native dialog; active owner cleanup failedBeforeDispatch PAGE_BUSY. The same original click timed out uncertain. Its duplicate produced no new commit. Other input/creation stayed fenced, parent cleanup was denied and cap1 stayed reserved. Separate owner cleanup completed with public browser/host/profile/TEMP proof all true. Original uncertainty/target/history survived; duplicate cleanup returned the same receipt/timestamp without new I/O. A new independent session was admitted only after verified close and fully cleaned. No dialog was resolved and no successful business outcome was invented. This is a real browser post-dispatch exception, not an injected mock.

The earlier board102 failed-run orphan remains Pending and untouched:

`C:\AIWork\2026-11-08\CDP1935261\client\browser-qc-d9202786-8451-46fc-ac1c-4ee6a3a2d9ba\private\browser-70622ada-ee2a-4b68-99ff-4ad6790d564a`

Its directory names do not prove a live or exited process. No broad process scan, kill or deletion was attempted. Passing new-run cleanup does not erase that earlier leftover.

## Saved cleanup-corrected snapshot before mechanical-settlement proof

Reports below used the cleanup-corrected source, with no source changes during their runs. Source hashes were cross-checked by audit-turn4-final.mjs. Coordinator board130 then authorized the two result.mechanicsSettled fields described in the final section. The old reports/hash file remain preserved; they are not represented as runs against that later client hash.

| Command | Result | Scratch report |
| --- | --- | --- |
| node groundwork-turn4-cleanup-qc.mts | 24 groups PASS, synthetic journal/contract including new target barrier and owner-cleanup exception | qc-f00f90d9-0044-4f21-a39d-f4bb77c95245/report.json |
| node inventory-qc.mts | Original 5 groups PASS | inventory-qc-cead832e-0efd-436b-a910-58b6e7926c7d/report.json |
| node browser-qc.mts | Original 18 groups PASS, actual Chrome | browser-qc-43bc6da6-a46d-4742-aeb0-0900f6920966/report.json |
| node input-qc.mts | 15 groups PASS, actual Chrome and all seven hashes unchanged | input-qc-7f8be9c9-66d7-4d85-86a9-5bda5cccd41d/report.json |
| node cleanup-qc.mts | 5 groups PASS, actual dialog-induced post-dispatch uncertainty and cleanup | cleanup-qc-07975e70-4bd0-48ef-9911-0b2cc14c61ba/report.json |

Final input public owned proof: host 8580, Chrome 672, profile playwright_chromiumdev_profile-7scYBU. Final browser regression proofs: hosts/browsers 2684/7728 and 3540/7584. Cleanup correction proofs: 4036/7956 and 9068/8. Each report verifies all four cleanup facts true; no pending sessions or listeners remain in those runs. These are spawned-resource proofs, not global process-scan assertions. Original orphan102 remains unresolved separately.

Seven modules pass node --check. Tracked git diff --check and explicit source trailing-whitespace/hash checks pass. No TypeScript static compiler build, macOS test, shared registration, live bridge/provider or real-app/business workflow acceptance is claimed.

Store SHA256: 562835339d4618dba01171910ea507162705ca44ce75aa9eb633a403540c853f. Client SHA256: 1d3b6a7a6c63f1bc1f39cd3c72998c57303b9f75452fbfc0dc7d6af7c18df1e8. Exact remaining hashes and fixture/status hashes are in scratch turn4-final-source-hashes.json. Current independent review is Pending; board114 only cleared the earlier snapshot. Shared hooks remain unapproved. Cross-runtime schema/read-call tracking and server uncertainty-lease cleanup alignment remain server integration work, not inferred from these client module tests.

## Final current mechanical-settlement proof (coordinator130)

GetCall result.mechanicsSettled is an internal boolean tied to the existing originalCallId/originalOperation and actual captured client/session/page. It is true only when that retained original named operation's actual work promise has settled in this live incarnation. It is false for a still-running operation or a missing/evicted/unknown original. The caller deadline, early returned envelope or an uncertain/completed receipt alone does not set it true. Caller-supplied proof is not an accepted request field. Wrong owner/parent/client identity cannot read it. Both durable original mutations and retained named reads use the same rule.

This proves only that the actual wrapper/browser-command mechanics are no longer running. It does not prove business success, rollback, cancellation or absence of later application/network effects; it never reconciles the original uncertain input. The server may use a verified bound true only to quiesce the owner-cleanup lease. Client CloseSession still checks every other unfinished same-session named operation and the durable input gate. Parent inspection never becomes mutation permission.

The final current client hash is 4e149db176518e363a3cdf1735dc28f05ba13163dfcace56b80c054345c5b250. Other six source hashes from the previous corrected snapshot are unchanged. New immutable actual-source evidence:

| Command | Result | Scratch report |
| --- | --- | --- |
| node browser-mechanics-qc.mts | 19 groups PASS, original18 plus real expired-close-deadline underlying-running false then same-call settled true | browser-qc-c06bd97a-d075-46aa-9922-1370301eaee8/report.json |
| node cleanup-mechanics-qc.mts | 6 groups PASS, actual settled-but-uncertain true, missing original false, wrong identity has no proof, spoofed true rejected, actual owner cleanup/history/capacity | cleanup-qc-39b54360-1801-462c-af0b-1538bb437ccd/report.json |
| node input-qc.mts | Original15 groups PASS on all seven latest hashes, unchanged throughout | input-qc-4d2c3ef4-ed3a-4a7c-9e51-a380f9c89b05/report.json |

The 24-group journal and 5-group inventory reports above remain applicable to the unchanged final store hash. Final mechanical-proof fixtures again verify every owned browser/host/profile/TEMP cleanup true and no pending session; listeners close in finally. Hash audit records final source/fixture/status hashes in turn4-mechanics-source-hashes.json without overwriting prior snapshots. All seven syntax checks and tracked diff check pass; no static TS compiler, real transport/provider, macOS or business-workflow acceptance is implied.

New independent review remains Pending. No shared hooks were edited or inferred approved. Old orphan102 remains Pending untouched.

Await the coordinator's next FollowUpPrompt. Successful module fixtures are not registered tool, bridge/provider image or business-workflow acceptance.
