# CDP client integration increment, turn5

Parent conversation 1935261. Checkout `C:\Code\aiqa-cdp\BenAIClient`, branch CDP, HEAD `3a25866ba303472aa540cc8c914bba64b44ecfa1`. This is the current handoff. Earlier status files and scratch reports remain historical evidence, including their failures. Current source needs independent verification; earlier reviewer114/143 clearances do not approve this revision.

## Scope and runtime

Ben authorized CreateSession per-session log redaction default ON, CDP-only client dispatch/log/body hooks, automatic private bootstrap and ordinary HTTP/HTTPS source support. The existing account email, configured client name, HTTP polling/reply protocol and client selection remain authoritative. No replacement authentication, binding, session-cache or settings framework was introduced.

Actual runtime tested: Windows x64, Node 24.22.2, installed Chrome 157.0.8103.38 at the existing Program Files location, and exact playwright-core 1.65.0. Previously approved package/package-lock dependency edits are retained; this increment ran no npm install and added no dependency. Electron remains omitted. Configuration remains vps-cdp with the existing routing email/root. No configuration or server C# source/SQL was edited.

No aiqa.js or server.js main/constructor/poller execution, service start/restart, deployment, browser download, normal profile takeover, desktop input, commit, push, email or delegated worker. All actual browser traffic was to owned 127.0.0.1 fixtures, using fresh real Windows private ACL directories under `C:\AIWork\2026-11-08\CDP1935261\client`.

## HIGH140 cleanup/accounting correction

The independent finding was definite: an incomplete cleanup proof was cached and thrown once; a later fresh CloseSession could return that cached false proof, allowing the manager to complete the close and release capacity incorrectly.

Two narrow defenses now apply:

1. CdpBrowserSession.close validates a cached proof every time. Any false or missing browserExited, hostExited, generatedProfileRemoved or privateTemporaryRootRemoved flag throws again. It does not retry process I/O automatically.
2. The manager independently requires all four flags exactly true before store.complete. A returned partial/malformed proof cannot release session/page reservations.

Original uncertain receipt/target/history and live reservation remain. Same cleanup ID returns its prior receipt without input. Fresh cleanup IDs do not turn cached incomplete proof into success or allocate new session/page capacity. No fake cleanup, broad process scan or unrelated-process kill was added.

Focused actual-class/SQLite/private-ACL tests cover the cached incomplete path and each false/missing flag. Their process/browser boundary is controlled and inert, not a real browser failure claim. Real valid cleanup, late same-call completion and actual dialog-induced input uncertainty were separately rerun against the final source.

## Real feature-owned bootstrap and shared branch

- New cdp-bootstrap.mts derives one persistent private installation root from the actual existing normalized client name and routing email. Default parent is Windows LOCALAPPDATA. No model field chooses paths, binaries, route or credentials. Fixture overrides are embedding-only.
- The root label uses a shortened opaque route digest, while the private marker retains the full digest and exact version/name. A conservative Windows path budget is checked before root creation/browser launch. This is a protective admission rule, not proof of the cause of the earlier failed launch.
- New roots receive current-user/SYSTEM protected ACLs. Existing roots require the exact private marker, owner/DACL and ordinary unaliased files, with reparse checks. Unknown/missing/mismatched/hardlinked state is rejected, never repaired or replaced.
- Existing DB/WAL/SHM private-file ACLs are verified before DatabaseSync/key access. Only freshly created owned files are hardened. Artifact files receive equivalent protection before metadata acceptance and are checked before retrieval. Actual bootstrap tests exercised these APIs in scratch; the production LOCALAPPDATA store was not opened.
- The persisted installation UUID and private journal key survive verified reopen. The process incarnation changes. Neither UUID proves browser-process ownership. Recovery remains fail closed, retaining unknown/orphaned resources without replay, attach, replacement or kill.
- New cdp-bridge.mts is importable without starting a browser, store or poller. It lazily bootstraps on an admitted CDP command, captures the real configured route, and refuses silent route changes for existing CDP resources. Existing legacy selection behavior is not changed.
- The approved server.js edit is limited to the bridge import/field/construction and a CDP candidate branch before legacy raw command/result/error logging. It uses the existing Reply method and transport ID. Non-CDP command handlers, logger, selection and HTTP URLs are unchanged. Malformed CDP-shaped candidates remain inside bounded safe handling rather than falling through to legacy raw logs.
- The shared server.js entry was syntax-checked only. A separate actual CommonJS require of the feature bridge passed on Node24 without requiring or executing either shared main entry.

## Versioned log policy and always-on limits

Canonical field: CreateSession.args.options.redactLogs, strict boolean, omitted default true. Explicit null, string or number rejects. A root-level alias rejects. Effective normalized arguments and both keyed integrity/dedup checks include the field. Changing it under the same creation identity conflicts.

Store schema3 adds private creation/session policy tables. Acceptance captures policy atomically and session completion binds it. Legacy/unknown policy defaults ON. Reopen retains the authorized session policy. Old schema migration code exists; this is not a claim of exhaustive production migration acceptance.

New cdp-diagnostics.mts provides bounded command admission and diagnostic projection:

- ON emits allowlisted operation/correlation/handle/state/error metadata, not raw commands/results.
- OFF emits actual bounded raw CDP diagnostics only when exact stored session/owner or authorized retained parent scope permits it. CreateSession, pre-session, unknown, malformed and invalid scopes remain ON. A model or untrusted reply cannot downgrade policy. The request-time captured policy also governs the eventual reply log.
- Fill plaintext and SecretRef, password/private-key/control-endpoint fields and image/base64 bytes remain excluded even OFF. Known sensitive session literals remain redacted and the existing screenshot-blocking policy remains in force. OFF is not a bypass of sensitive/artifact rules.
- Diagnostic records are always bounded to 16 KiB. Argument admission is bounded before contract cloning/bootstrap. Existing 64 KiB normalized args, 128 KiB nonimage reply and 12 MiB encoded reply bounds remain always on.
- The legacy batched poll has already called resp.json before this feature receives a command. Client command admission is NOT claimed to cap that earlier HTTP allocation. Server-side preallocation reply guards are sibling work.

Exact capability fields are reply.cdp.result.contractRevision = v1-redactLogs-2026-11-08 and reply.cdp.result.createSessionRedactLogs = true. Older clients that cannot implement this option require an explicit contract mismatch at the server, not silent ignoring. Server previous revisions are not claimed aligned or accepted by these client tests.

## Navigation and lifecycle

Default source policy permits ordinary HTTP/HTTPS and local about:blank, rejects URL credentials and file/javascript/data/chrome/unsupported schemes, and needs no manually configured application origin. Embedding-only fixtureOrigin can still constrain QC to one owned origin. Source validation includes external example.invalid URLs, but no external request or general application workflow was executed. Capabilities state generalApplicationAcceptance false.

All profiles remain isolated. No user profile, OS focus/global keyboard, private Playwright internals, public control endpoint or browser-wide process scan is used. Public owned host/browser/profile evidence is retained privately; endpoint credentials never enter receipts or diagnostics.

Feature shutdown journals fresh cleanup operations only for resources this manager actually owns. It reports unavailable/pending/incomplete resources instead of claiming them cleaned, and does not replay uncertain business input. Manual graceful API cleanup was tested. Lazy SIGINT/SIGTERM hooks exist only after the runtime opens; actual OS-signal integration was not executed. There is no Node TTL authority; the server's existing C# TempCache remains authoritative.

## Actual immutable-source validation

Scratch base for all relative paths below: `C:\AIWork\2026-11-08\CDP1935261\client`.

Command: `node run-turn5-qc.mjs`. Suite `turn5-suite-c04cdfbf-2743-45ef-a52c-17e1ed8c210e/report.json` records eight actual subprocess exit codes zero, stdout/stderr hashes and all eleven source hashes unchanged before/after every child. This does not rely on stale shell ERRORLEVEL values.

| Child command | Result | Actual evidence |
| --- | --- | --- |
| source-check-turn5.mjs | 11 syntax checks PASS | source-check-turn5.json and suite stdout/stderr |
| cleanup-proof-qc.mjs | 9 controlled groups PASS | cleanup-proof-41b1a0dc-428d-45a9-8045-02362c97115f/report.json |
| versioned groundwork-redactLogs-qc.mts | 24 synthetic contract/journal groups PASS | qc-babf1579-08a1-4c42-995d-3e98924fe15a/report.json |
| inventory-qc.mts | 5 synthetic groups PASS | inventory-qc-29fd3252-c574-4f47-a2e8-d051d862d086/report.json |
| browser-mechanics-qc.mts | original18 plus mechanical-proof group, 19 PASS, actual Chrome | browser-qc-7a052393-9240-4c9e-8b7e-118c2fe7f408/report.json |
| cleanup-mechanics-qc.mts | 6 PASS, real modal-induced timeout/uncertainty and owned cleanup | cleanup-qc-fadec675-fdfb-484d-bfaa-d6894e0890fd/report.json |
| input-qc.mts | 15 PASS, genuine trusted browser events/app-visible fixture state | input-qc-efc29658-7194-46c5-8ac9-2c2818e2c3e3/report.json |
| bridge-qc.mts | 15 PASS, actual bootstrap/ACL/SQLite/two Chrome sessions | bridge-qc-12d06b66-d21f-46f0-a09f-ffe4c5c355aa/report.json |

The shared original golden and original scripts were preserved. The runner writes a versioned client golden adding only the new CreateSession default to the applicable normalization cases. The prior turn4 structured-Observe static-negative correction remains explicit. No server-owned fixture was edited.

While auditing evidence, the first full-suite capability-wire.json was found to pair a fresh generated example command with the actual response. That file is NOT the authoritative paired wire. The old fixture was preserved as bridge-qc-before-paired-capture.mts, then only its command-capture provenance was corrected. Command `node run-turn5-qc.mjs --bridge-only` reran the complete bridge15 checks on the SAME eleven unchanged source hashes. Its suite is `turn5-suite-0de4c6d1-bf9f-4804-b56c-27479c379aae/report.json` and report is `bridge-qc-f4966280-435a-41aa-a8ef-d24c21dd94e3/report.json`.

Use `bridge-qc-f4966280-435a-41aa-a8ef-d24c21dd94e3/capability-wire.json` for the exact ACTUAL matching command/response/defaults. Both callIds are 6f540b34-cb1e-434e-a68e-29b9df254934.

Bridge checks include actual default-ON and explicit-OFF session diagnostics, policy conflict, wrong owner/scope fallback ON, PNG bytes/hash/parent ACL, genuine sensitive Fill/echo redaction/screenshot blocking, input/log caps, controlled accessors rejected without invocation, private-marker/hardlink/junction/ACL rejection before key access, persistent installation reopen and retained evidence. Known sensitive marker scans cover retained private SQLite/WAL/PNG/marker and diagnostic output. Endpoints/base64 are absent from diagnostics even OFF. Actual raw OFF is demonstrated with a public fixture URL marker, not merely metadata relabeled raw.

The final paired bridge run public proofs are hosts/browsers 7648/1068 and 6176/7452. All four cleanup facts are true; known PIDs are absent, exact generated profiles and dedicated TEMP roots removed, pending operations zero and journal closed. Fixture listeners close in finally. All other final successful browser regression reports likewise verify owned cleanup. These are owned-resource assertions, not global absence scans.

`node bridge-cjs-import-qc.cjs` separately passes actual CommonJS feature import, lazy construction without route/bootstrap, unchanged signal counts before runtime opens and empty owned shutdown. Evidence: bridge-cjs-import-report.json. No shared main entry executed.

Source/runtime syntax and fixture validation are not a TypeScript static compiler build, deployed HTTP/provider-image test, registered-tool acceptance or business-workflow success. Final git/whitespace/source/provenance audit is saved in turn5-final-source-hashes.json; no earlier source-hash files are overwritten. Its first whole-file shared-server whitespace assertion found preexisting HEAD trailing spaces. The audit was narrowed to full new-feature files plus git diff --check for tracked changed lines, preserving legacy source instead of reformatting it. Git's existing LF/CRLF advisory was not treated as a runtime failure and no Git configuration was changed.

## Failed runs and unresolved leftovers

These remain separate from passing current runs:

1. Earlier board102 orphan remains Pending and untouched:
   `C:\AIWork\2026-11-08\CDP1935261\client\browser-qc-d9202786-8451-46fc-ac1c-4ee6a3a2d9ba\private\browser-70622ada-ee2a-4b68-99ff-4ad6790d564a`
2. First turn5 bridge attempt passed only bootstrap/caps2, then browser creation failed post-barrier and retained uncertainty. Report: bridge-qc-02bb073c-bc27-4c82-a7be-a84d90683199/report.json. No ready/public browser PID proof existed. Its scratch leftover remains Pending and untouched:
   `C:\AIWork\2026-11-08\CDP1935261\client\bridge-qc-02bb073c-bc27-4c82-a7be-a84d90683199\BenAI-CDP-v1-102408ab08e9c7e3a114c4a1b20e2c9898ea77a580d3302650230a889787b977\browser-9d7d318a-2751-4dc8-9326-8ee9b8496328`
   The old report's browserExited true did not have public browser proof and is not trusted as exit evidence. Current source is more conservative after a rejected attempted launch with no public child proof. Long Windows path was a hypothesis, not an established cause. Shorter labels/path admission and bounded classified private startup evidence were added; no unknown-profile deletion/kill or old-ID retry occurred.
3. Second actual bridge run reached eleven useful groups, then its negative junction test hit path-budget admission before its expected reparse rejection. Report bridge-qc-eff85770-804b-48e8-8224-eb67ea93a715/report.json remains BLOCKED as recorded. Only the fixture alias was shortened; both its owned browsers had verified cleanup. The later complete bridge reports do not rewrite that failure.

No old unknown process/profile was scanned, killed, claimed exited or deleted. Directory names and installation UUIDs do not establish process ownership or status.

## Remaining gates

- Independent verification of this exact source, especially HIGH140 defenses, private persistent-file admission and shared branch/log projection, is Pending.
- Sibling server must coherently align the strict redactLogs revision/default/HMAC metadata, original GetCall scope and registered read/input surfaces, including its approved reply preallocation guards. No cross-runtime claim is inferred from old pinned checks.
- Main-frame/headless Windows/PNG only. SecretRef, child-frame actions/DOM inspection, watches, network/file/download adapters, dialog resolution, general Evaluate, pointer scope, JPEG, headful, text/binary artifact pagination and macOS remain unsupported.
- No deployed live feed, provider image acceptance, arbitrary external application or business-write workflow has been tested. Existing bridge protection remains a release gate, not an authentication rewrite.
- Both unresolved scratch leftovers above remain Pending.

Await coordinator FollowUpPrompt. Successful importable bridge fixtures are not production/browser-workflow acceptance.
