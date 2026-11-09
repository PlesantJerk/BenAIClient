# Native dialog and bounded network integration checkpoint

This is a client functionality increment, not completion of the full specification or live provider acceptance. Parent conversation1935261. Branch CDP, HEAD3a25866ba303472aa540cc8c914bba64b44ecfa1. No main/poller, service/deployment, production SQL/provider, dependency/download, commit/push or historic resource handling.

## Implemented contracts

- HandleDialog: existing v1 mutation envelope, owned SessionId/PageId and NEW ActionId/fingerprint. Args exactly `{dialogId,accept,promptText:null}`. Accept is required boolean. Omitted/null PromptText preserves the full native prompt default within the frozen helper's limit; explicit empty clears it. Explicit text is bounded8192 UTF16/32768 UTF8 bytes. No Options, guessed cause or client-supplied origin fields.
- GetNetworkExchange: existing retained-read envelope, exact SessionId/PageId, args `{networkRequestId,options:{includeRequestBody:false,includeResponseBody:false,maxBodyChars:16000}}`. Char budget1..65536; flags strict booleans. Read-only named completion uses separate GetCall; never resends input.
- Existing revision remains v1-redactLogs-2026-11-08. Actual capability wire publishes operationCapabilities.HandleDialog/GetNetworkExchange and explicit native-dialog/network subset fields.

## Ownership, mechanics and evidence

cdp-dialogs.mts is imported unchanged at SHA256feaa1316ae8a4b2a45f71e63e857e16a75ab4f08913332302c05d23bb2e3197e. Core has one native dialog listener and publishes the helper's SAME ID only on isNew. Descriptions label observed mechanical overlap, NOT verified application causation; idle/background origin IDs are null. A dedicated exact-dialog lane is usable while another input is pending or uncertain. Runtime owner proof is rechecked at acceptance and the committed one-use dispatch barrier. It is not a model-supplied bypass. Duplicates return retained receipts; conflicts/current/stale/foreign checks never accept/dismiss again. Resolving a dialog never clears original uncertainty or claims application success/cancellation.

cdp-network.mts is imported unchanged at SHA2560b99b407131de7e3cd82f59bc2d4ad52f0ce9d65ed85c482bc3e8b99082793d5. Each owned Page recorder is initialized before navigation/exposure. Old Playwright request/response listeners/WeakMap IDs were removed. Native-session/request/redirect-hop IDs are the sole event/lookup identity stream. Logical frame/document mappings remain null when unknown; no current-document stamping or URL/time joining. Each recorder detaches ONLY its own public CDPSession.

Network defaults:128 records and1MiB retained/page,32KiB resource/256KiB native total buffer,8KiB event postData,4096-byte/32-count headers/direction,4096-char URLs,2 body reads with3s deadline. Bounded event postData only; no unbounded request-body refetch or network replay. Text bodies are browser-decoded observations, not raw-wire bytes. Redirect, binary, oversized, truncated, evicted/unknown and post-detach unread bodies have explicit availability reasons. Data is runtime-retained, with no restart/body recovery promise. Exact parent retained reads work, including GetCall of the parent's own named read; parents cannot control dialogs or acquire inputs.

Schema stays5. Verified page tombstones, ac6 replay, HIGH140 all-four browser cleanup and generic business uncertainty remain. Closed-page observation cancellation now precedes asynchronous recorder detach, preventing an active sampler from expiring on a known closed Page during that await. Verified ClosePage alone releases its one slot. Whole-session cleanup retains its separate four proofs.

Ben's functionality-first policy is unchanged: screenshots/artifacts after password/Sensitive Fill remain usable in the same context, and OFF can log actual bounded Fill values without classification gates. No new privacy guarantees or certification are asserted. Binary/base64 log and result limits remain.

## Actual validation and provenance

Runtime: Node24.22.2 win32x64, Playwright-core1.65.0, installed Chrome157.0.8103.38. All executed browser work was owned headless Chrome against an owned127.0.0.1 fixture, with real private Windows ACL/SQLite.

- Final actual workflow PASS13: client/dialog-network-qc-4f271e27-0b23-4cf5-9a42-1b10b2d20f90/report.json; exact17 hashes unchanged through runtime. Native alert, confirm dismiss, full5000-character prompt default and explicit empty; concurrent origin pending and real post-dispatch timeout; exact control dedup/conflict/scope/parent denial; same-URL concurrent POST correlation; bounded headers/body/redirect/UTF8/JSON/binary/size/135-request eviction; retained closed-page parent reads; actual beforeunload control and all-four cleanup, zero subscriptions/pending/journal closed.
- Final vectors/capability pair: client/dialog-network-wire-d28c23c5-ea80-4792-a19e-7ee926fa8b25/CdpWire.v1.dialog-network.fixture.json. Eleven normalization positives,19 negatives,26 unaltered actual command/immediate/GetCall pairs. Synthetic normalization identities are explicitly labeled; captured runtime pairs are not synthetic.
- Controlled exact-dialog barrier fixture PASS6: client/dialog-gate-c9f47541-6324-45fb-a23a-297c743b51f2/report.json. Real private ACL/SQLite; synthetic resources/runtime proof, controlled commit failure and clean reopen. No native browser/crash/input claim for this fixture.
- Final 15-group PASS: client/lifecycle-qc-b3615c5c-7a75-4403-903d-4cdab8d32713/report.json. Scope remains exactly the report's actual-versus-controlled statement.
- Final 6-group PASS: client/dialog-gate-c9f47541-6324-45fb-a23a-297c743b51f2/report.json. Scope remains exactly the report's actual-versus-controlled statement.
- Final 8-group PASS: client/page-accounting-ad74b455-5bdc-4d39-bd0b-2c5d41d9ee76/report.json. Scope remains exactly the report's actual-versus-controlled statement.
- Final 12-group PASS: client/history247-qc-61fa6eb9-b1d4-4f36-9dfb-87fb07569c1b/report.json. Scope remains exactly the report's actual-versus-controlled statement.
- Final17 runtime syntax/CommonJS import, exact actual-source equality, six scoped diffs versus prior immutable15, nine unchanged prior core files, frozen helper hashes, Git/package checks and evidence hashes: client/dialog-network-final-source-hashes.json points to the fresh immutable manifest/copies. No static TypeScript compiler build is claimed.

## Preserved unsuccessful attempts

- Initial dialog-gate scratch fixture used unsupported Node strip-only constructor parameter properties: import failure before resource creation. Preserved old fixture; explicit properties corrected only scratch.
- First actual workflow d54e390d-5379-46e6-abe5-2d01e886fb55 passed6 groups, then exposed the parent named-read/GetCall self-authorization defect. Fixed only core named-parent read inspection. Original calls inspected; cleanup all4 true, pending0.
- Second actual workflow8a88aa9a-edd5-4387-b1a4-fc563fd20e47 passed7, then fixture expected UTF8 despite sending text/plain without charset. Chromium's decoded mojibake was preserved; only owned fixture declares UTF8 now. Cleanup all4 true.
- Third actual workflow d4a6710f-bf84-4d12-ac8c-9d7efde1a6fe passed9;500ms expired in read-only target preparation, so no dialog/input occurred. The failed-before-dispatch action was NOT replayed. Fresh fixture uses the already-proven normal10000ms budget and withholds resolution to measure actual post-dispatch uncertainty. Cleanup all4 true.
- Earlier PASS13 cafe0c90-a46c-4ca6-bcc6-0d0a4dda1578 and its corpus18c04840 are preserved on the pre-close-order source, not relabeled final.
- Preserved lifecycle regression d56c65fb-742c-4c06-8e31-17db5e9435c7 passed12 then found watch expiry instead of cancellation during network detach. The narrow ordering correction is described above. No helper or input retry was introduced; known cleanup verified.

## Pending and next integration

Independent/paired server acceptance of current17 and live model/provider acceptance remain Pending. Existing full-spec gaps remain visible: files/chooser/download adoption, Evaluate, generic artifacts/ExportTrace, full frame/watch/network conditions, DPR/cache variants and other unimplemented mandatory behaviors. Sibling files/download/evaluate/trace/viewport/artifact-reader sources are not imported, edited or counted in this17 checkpoint.

Historical unknown leftovers102 and152 remain Pending and untouched, with exact paths in cdp-lifecycle-interaction-status.md. Current verified cleanup does not establish their state. No broad process scan, kill or profile deletion was performed.

Final HIGH140 nine controlled cases, actual exit0: client/cleanup-proof-9cff2c30-7203-41c7-b309-e70eb17f63ff\report.json. Original report has no synthetic PASS field; all false/missing proofs keep live accounting and uncertainty. Scope: inert public process/browser boundary, actual manager/store/browser modules and real private ACL. No native browser acceptance claimed by this control.

## Additional failed modal-cleanup attempt and narrow correction

Unmodified lifecycle regression bc5550fd-7ef7-42c5-9f5a-21b6d25c6092 passed14 groups after page cancellation was corrected, but original CloseSession mechanics exceeded the bounded fixture window while native beforeunload remained unresolved. It stayed uncertain; the finally cleanup was denied while that original work was active. The report retains pendingOperations1/journalClosedfalse, not manufactured cleanup. Core previously awaited per-page native detach before sending its owning host the browser close. Per coordinator368 the narrow correction stops observations synchronously, closes and verifies OWN BrowserServer/host/profile/TEMP FIRST, then disposes native recorders on now-closed pages. Four-proof admission and original uncertainty remain unchanged. The final unmodified lifecycle15 and native13 workflows pass on the same exact corrected sources. No modal accept/default-dismiss or input replay was added.

The old failed attempt's public-proof host4692/browser8380 were both absent in a specific-PID check at22:49:32UTC. This is NOT four-proof cleanup: generated profile/private TEMP still existed and are preserved Pending at `C:\AIWork\2026-11-08\CDP1935261\client\l-a54134d0\BenAI-CDP-v1-102408ab08e9c7e3a114c4a1b20e2c98\browser-2e8a2dc9-6776-4d22-b162-7dcc8bb88c40`. Evidence: client/modal-attempt-partial-state.json and client/blocked-lifecycle-summary.json. No process termination, directory deletion, receipt repair or old-scope reuse occurred. Historical102/152 remain separately untouched.

Earlier native13 pre-correction copies are retained in client/dialog-network-precleanup-source-hashes.json, whose17 hashes are all asserted equal its own earlier actual PASS13 report using only reversible cleanup-order deltas. They are not relabeled final acceptance.
