# CDP client functionality-first lifecycle/native interaction checkpoint

Date: 2026-11-08. Current client increment only, not full mandatory-suite or live deployment completion.

## Policy and baseline

Branch CDP, HEAD `3a25866ba303472aa540cc8c914bba64b44ecfa1`. Existing approved exact playwright-core1.65 dependency and CDP-only server.js branch are retained. This increment does not edit package/lock/server.js, authentication, HTTP polling, client selection, configuration, or the generic logger. Runtime: Node24.22.2 win32 x64, installed Chrome157.0.8103.38, Playwright1.65.0. No new dependencies, browser downloads, main/poller invocation, service/deployment/production SQL/provider execution, commits or pushes.

Ben's functionality-first decision258/260 supersedes prior privacy-blocking objectives. Password/Sensitive Fill no longer bans screenshots or artifacts. No mask system, opt-in, credential reset or context recreation is required. Same authenticated owned context remains usable. redactLogs remains default true and configurable false. Authorized OFF diagnostics can contain raw sensitive and known-literal Fill values directly, before any ordinary-classification proof; caps and image/base64/private control endpoint/key exclusions remain. Plaintext is not added to the durable argument journal. No privacy certification or general secret-detection guarantee is claimed. Older219 privacy expectations are historical/superseded, not failing gates to restore.

## Owned source and actual adapters

The exact15 operational sources are listed in the final manifest. New `cdp-lifecycle.mts` holds one page's lifecycle adapter. New `cdp-interactions.mts` holds class-owned prepared native operations and pinned prepared drag. Existing contract/store/manager/page/targets/events/watches/diagnostics were minimally extended. Artifact/private-directory/bootstrap/bridge/server.js files are byte-unchanged from247. Sibling-owned `cdp-dialogs.mts`, `cdp-network.mts`, and `cdp-files.mts` are NOT integrated, edited or counted in this15 snapshot.

Exact additional contracts, using existing envelope SessionId/PageId/ActionId/fingerprint:

| Operation | Normalized args and effective behavior |
| --- | --- |
| ClosePage | `{}` only, no invented Options/public timeout. Public explicit page close with beforeunload enabled; exact page.isClosed proof before quota release. Retained already-closed page can report a genuine no-op without repeating I/O. |
| Reload | `{bypassCache:false,waitUntil:'domcontentloaded',timeoutMs:30000}`. Existing guarded routing disables HTTP cache; result states that fact. `bypassCache:true` currently fails CACHE_BYPASS_UNSUPPORTED before barrier. No routing weakening. |
| SetViewport | `{width,height,deviceScaleFactor:1}`. Public per-page CSS resize preserving captured context scale and authentication. Measured viewport/DPR checked after layout and actual PNG checked in fixture. Requested scale must equal captured scale; a change fails DEVICE_SCALE_FACTOR_UNSUPPORTED before barrier. No context recreation or unverified native-CDP override. |
| Hover | `{target,options}`. Pinned public ElementHandle hover, main frame. Disabled controls may be hovered; visibility/stability still required. |
| SelectOptions | `{target,values,options}`. Native select only. Up to128 unique bounded string values; empty native value is allowed. Disabled option/optgroup, duplicate native-value ambiguity and invalid single-select combinations reject. Already-selected set is an explicit no-op. Library input/change is NOT claimed physically trusted. |
| SetChecked | `{target,checked,options}`. Native checkbox/radio only; already-correct state is no-op. Checked radio false is explicitly unsupported, not property mutation. |
| Scroll | `{target:null,deltaX:0,deltaY:0,options}`. Finite fractional CSS-pixel deltas within +/-1000000. Null targets main-frame scrolling element. Native scrollBy(instant), not OS wheel. Actual before/after offsets, bounds/RTL evidence. Zero delta is no-op; nonzero at a bound reports attempted operation separately from offset change. |
| DragAndDrop | `{source,destination,inputMethod:'pointer',options}`. Two pinned same-page/main-frame elements, public page-bound mouse gesture and finally release. No synthetic fallback or locator re-resolution. `syntheticDataTransfer` is admitted literal wire but fails DRAG_METHOD_UNSUPPORTED before input. |

Common ActionOptions remain `{timeoutMs:10000,expectedDocumentId:null}`. Targets/defaults/IDs/revision remain compatible. Drag requires both hit-tested centers to remain in the viewport after scrolling; no cross-frame/offscreen auto-scroll guarantee. Public pointer APIs do not provide a gesture-wide action timeout; preflight/scroll uses the requested timeout, and no background race is invented to claim cancellation.

Input mechanics are not business success. No automatic action retry/fallback, no OS focus/global keyboard, no normal Chrome/profile takeover. All actual execution remained on owned loopback fixtures.

## Journal, page accounting and observation cleanup

All new input uses the existing full-normalized-argument HMAC acceptance, one-use committed dispatch barrier, pinned targets, page exclusion, parent mutation denial, and uncertainty fences. Read-only preparations happen before input. Post-barrier failures remain uncertain; same ID never repeats input. ClosePage has no generic uncertainty bypass.

Known-owned schema4 migrates additively to5 with `closed_pages(page_id,verified_ms,call_id)`. Existing page membership remains a retained tombstone. Manager verifies actual owned page closure; store independently requires exact `{pageClose:{pageId,closed:true}}` and commits proof/receipt/quota release atomically. Missing/false/foreign proof or failed outcome commit releases nothing. Duplicate or fresh no-op cannot free a second slot. Closed pages reject new work but retained parent reads and artifacts/events stay accessible. Current-schema damage or unknown versions fail closed without repair/reset. Recovery does not reattach/replay or release unknown resources.

Verified page close disposes only that page's targets/watch subscriptions/listeners. Active WaitFor does not block legitimate page input/close. Whole-browser four-flag cleanup guard140 is unchanged. The entire247 CdpWatch replay class is byte-preserved; only owner-level per-page cleanup was added. Historical missing-payload errors and gap marker remain intact.

## Machine capabilities and canonical fixtures

`operationCapabilities` adds true for ClosePage, Reload, SetViewport, Hover, SelectOptions, SetChecked, Scroll, DragAndDrop only because actual adapters exist. Additional actual fields:

- `lifecycleCapabilities`: verifiedPageClose=true, reloadBypassCache=false, effectiveHttpCache='disabled by existing guarded routing', deviceScaleFactorChanges=false, resizeScale='preserve context-created scale only', screenshotScale='css'.
- `interactionCapabilities`: mainFrameOnly=true, nativeSelectOnly=true, nativeCheckableOnly=true, cssPixelScroll=true, dragInputMethods=['pointer'], syntheticFallback=false.
- screenshotAfterSensitiveFill=true; diagnosticPolicy.rawFillValues=true.
- watchCapabilities.historyReplay='gap-and-omission-aware-v1' remains unchanged.

Authoritative corpus: `C:\AIWork\2026-11-08\CDP1935261\client\lifecycle-wire-ae9d07e4-b7cd-4861-b714-f0d94a978ca2\CdpWire.v1.lifecycle-interaction.fixture.json`. It contains14 positive and18 negative synthetic canonical command vectors, plus8 UNALTERED actual completed GetCall replies with original submitted commands/separate query and actual paired capability command/response. Valid wire versus unsupported runtime variants are explicit. No new aliases, CancelWatch ID, protocol revision or sibling/server registration claim.

## Actual validation and provenance

All paths below are under `C:\AIWork\2026-11-08\CDP1935261\client`.

1. `functionality-unblock-079b8ea5-e7b8-4c27-8c93-b46430f62b03/report.json`: early actual4 positive groups, own password/Sensitive login -> screenshot/artifact and raw OFF values, verified cleanup. This earlier13 source has its own exact pin `functionality-unblock-source-85cfd9d0-9445-4322-b3c5-8f6037ac61e6/manifest.json`, used by sibling server's separately reported paired59. Do not relabel it as this15 acceptance.
2. `lifecycle-qc-5b3d2e79-3846-4639-b4dc-66e77b59b51b/report.json`: actual15 workflow groups, SAME15 source hashes before/after. One owned Chrome, two authenticated pages and replacements. Native hover/check/drag genuine trusted events; native select input/change actual untrusted library provenance; CSS scroll; CSS800x600/DPR1/PNG and unaffected sibling640; reload asset refetch/auth/doc invalidation; negative targets/parent/dedup/conflict; verified cap2 page slot release; WaitFor plus input/close; actual beforeunload leaves uncertain close open-accounted; whole-close all4 flags and0 pending operations. Public own host9360/browser3952/profile-Qs2qXw proof retained. Wrapper `watch-run-95b91869-1aff-451a-98bf-4f2cbe67e291/exit.json` status0.
3. `page-accounting-37dcdbd2-6532-4edc-b276-d27de1b68620/report.json`:8 groups actual private ACL/SQLite, SYNTHETIC resources and CONTROLLED migration/evidence/outcome commit/reopen/schema faults. No actual browser/crash claim. Wrapper `watch-run-89eafd81-6680-4911-b6ac-5f857d93c485/exit.json` status0.
4. `history247-qc-1de2cab8-49ac-47ae-9ca9-071c3453c843/report.json`:12 actual-module controlled/no-browser groups, same corrective omission/gap/parent/quota/default-live behavior. Wrapper `watch-run-c7287d06-28c0-465e-85df-c2040ae1c456/exit.json` status0.
5. `cleanup-proof-b1f70547-416b-4983-ad1e-af54c0a4c76b/report.json`:9 controlled actual-source manager/browser public-boundary groups for140, real private ACL/SQLite but inert browser boundary. Wrapper `watch-run-9fd3d559-4c4d-4462-b16b-f13ace21e1ba/exit.json` status0.
6. `lifecycle-wire-ae9d07e4-b7cd-4861-b714-f0d94a978ca2/report.json`:14/18 validator cases and8 actual replies, no browser rerun. Wrapper `watch-run-ec0ce7a5-a69f-4ba7-a884-76d2dc686d0d/exit.json` status0.

Final audit writes immutable15 copies/diffs/commands/hashes and this status to a fresh `lifecycle-final-*` directory, with alias `lifecycle-final-source-hashes.json`. It requires ALL15 hashes to equal actual workflow15 hashes,247 replay class byte equality, only prior package/lock/server.js tracked dirt,15 runtime syntax checks, import-only CommonJS feature entry, and unchanged hashes after audit. No TypeScript static compiler build is claimed.

## Failed attempts, preserved honestly

- `watch-run-28c600de-435b-4d36-b361-dbc6d5006d5b`: first lifecycle fixture import failed on SQL quoting before ANY fixture resources/browser. Corrected source then actual15 passed on exact recorded hashes. No failed browser launch.
- `watch-run-8b1157f7-b4a3-4f0b-b8d4-6ac746f69569` and `page-accounting-b219d5b1-0689-4138-a7d7-63c3423c7251`: scratch accounting fixture incorrectly expected INSPECTION_REQUIRED when PAGE_CAPACITY has earlier rejection precedence. Five groups passed; no production defect/change. Original fixture preserved as `page-accounting-before-error-precedence-qc.mts`. Corrected fixture asserts exact PAGE_CAPACITY and separately proves existing-page uncertainty fence. New8 passed on unchanged production source.

The first final audit (`watch-run-a7620090-3919-4885-8ceb-bff240678bf7`, source-only snapshot `lifecycle-final-791c4ef9-9a01-414b-a518-3c3dd311bdb8`) exited0 and verified15/syntax/import/diffs, but the generic runner does not forward additional command arguments, so its evidence map was empty. Preserved it and its script as `audit-lifecycle-source-only.mjs`; final audit instead reads explicit `lifecycle-audit-evidence.json`. This is an audit-packaging correction only, with no production or browser rerun. The later complete manifest is authoritative.

## Pending, not full project completion

Differentiated cache bypass, per-page DPR change, syntheticDataTransfer/cross-frame drag and remaining mandatory catalogue variants stay Pending. External real applications, macOS, live provider/attachment acceptance, production startup, and paired server acceptance of this15 are not claimed. Existing main-frame/PNG/isolated headless limits remain. Dialog/network/files helpers are sibling-owned standalone modules awaiting later core integration, not tools simply because files exist.

Independent review follows this immutable handoff. Historic102 and152 unknown profile/TEMP leftovers remain untouched/Pending at their exact paths in `cdp-integration-status.md`; no broad scan/kill/delete or claim they are gone. All new actual workflow resources have verified owned cleanup. Continue full project in the coordinator's next coherent follow-up, not broad completion at this subset.
