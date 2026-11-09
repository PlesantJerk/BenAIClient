# Historical turn3 browser-slice snapshot

Preserved baseline evidence below. Current turn4 input/ReadArtifact implementation, hashes, limitations and Pending items are in `cdp-input-status.md`. Statements below describe the earlier snapshot, not the current supported operations.

# CDP feature-local browser slice

Parent conversation: 1935261. Windows client checkout: `C:\Code\aiqa-cdp\BenAIClient`, branch CDP, HEAD `3a25866ba303472aa540cc8c914bba64b44ecfa1`.

This is an unregistered feature module, not a deployed browser-tool workflow. No shared dispatch/configuration/server source was edited. No AIQA poller or application service was started. No browser download, user-profile takeover, desktop/global input, SQL application, commit or push occurred.

## Implemented boundary

- `cdp-client.mts`: configured-client binding, named retained operations, prompt accepted/current replies, separate GetCall inspection, store-authoritative inventory and owner/parent read gates. Full command arguments are held only while their operation runs. Results remain bounded in process; journal receipts and private image metadata/bytes are separately retained.
- `cdp-browser.mts`: installed headless Chrome using public Playwright APIs only. A dedicated owned Node host has its own private TEMP/TMP, launches a loopback BrowserServer, and exposes only its public spawned process/profile proof over private IPC. The control endpoint is neither logged nor persisted/returned. Each session has a fresh owned browser context/profile; authentication is shared only among pages in that session. Unknown prior resources are unavailable and never attached, killed or replaced.
- Actual SQLite acceptance and fresh committed dispatch barrier precede browser/session creation, page creation, navigation and close. A duplicate acceptance never starts another operation. Conflicts and dispatch exclusion remain store-owned. A caller's close deadline records uncertainty while the original named cleanup continues; a later authoritative completion preserves first uncertainty history.
- `cdp-private-directory.mts`: real Windows fresh-root policy. Only newly created dedicated directories are hardened. Owner is the current user SID; protected DACL permits current SID and SYSTEM FullControl with file/container inheritance. Existing roots are verified, not silently changed. Ancestor links and unexpected ownership/rules fail closed. No global/parent ACL changes. Other platforms explicitly fail closed.
- `cdp-artifacts.mts`: bounded noninterlaced 8-bit Chrome RGB/RGBA PNG validation, CRC/decompression/pixel checks, nearest-neighbor downscaling, SHA256, private bytes and metadata. Retrieval checks captured ownership, age, ordinary unaliased file, length, digest and dimensions. Internal transfer uses agreed v1 `artifactId`, `encoding: 'base64'`, `mimeType`, `byteLength`, `sha256`, `width`, `height`, `dataBase64`. This is not provider image delivery or model visual review.
- Private artifact open reconciles only generated image filenames against retained metadata. Interrupted unindexed private image writes are removed; unexpected files/aliases fail closed. Maintenance scans have a 100,000-entry technical ceiling and fail closed rather than silently forgetting evidence. File-write/fsync/metadata failures attempt removal of their own partial file and propagate failures.

## Small supported subset

GetCapabilities; CreateSession; GetSessions; CreatePage; GetPages; CloseSession; GetAction; GetCall; Navigate restricted to the one trusted owned loopback fixture origin; main-frame bounded rendered-DOM observation; PNG Screenshot and authorized retained PNG retrieval through the feature API.

Observation reads DOM nodes/attributes/geometry only, not application view models or business getters. Form values are omitted, including password values. Frames may be listed as metadata; non-main-frame targeting and observation cursors fail explicitly. Page/document generation changes invalidate old observations. Unsupported modal dialogs are not automatically accepted or dismissed; only safe pending identity/type is exposed in page metadata.

GetAction parent inspection succeeds only for a unique exact stored immediate-parent/account/client match. Ambiguous sibling-child IDs fail closed and require the exact original GetCall identity. Parent inspection never accepts input.

## Store additions and independent review

The original five journal findings were independently verified fixed in board post 77 against contract `ed3be3...` and store `e2c685...`. This is not a claim that the reviewer inspected the new browser slice.

Coordinator board 80 authorized narrow additive public store reads. Current additions are getSession/listSessions/listPages/getAction, reusing store-owned authorization, plus bounded internal retainedArtifactIds for private artifact housekeeping. There is no second SQLite connection or copied SQL schema in the browser manager. No receipt mutation/recovery/dedup/uncertainty method changed. `verify-source.mjs` removes only those additive spans and reproduces exact reviewed store SHA256 `e2c685e468c091fcf6c97c82099b2ddb0601665e1597dfcbe8892b0d59bba7ee`.

Current store SHA256: `13a776e3a4cde38523301787de4a37e832140b34247b9c176cd985e356d7e0f5`. New APIs/browser code need their own independent review; original review clearance is not automatically extended to them.

## Actual validation

All scripts and runtime DBs/keys/artifacts are under `C:\AIWork\2026-11-08\CDP1935261\client`.

- `node groundwork-qc.mts`: 23 groups PASS on current store. Report `qc-ba40b3ba-2b89-4a89-9f1f-418ab3c8ca88\report.json`. Synthetic contract/journal checks, not a browser or real-crash claim.
- `node inventory-qc.mts`: 5 groups PASS. Report `inventory-qc-729512c4-5cd1-4fd5-a8e2-708f2ab79718\report.json`. Owner/parent ACL, account/client rejection, cursor paging, ambiguous child IDs, unchanged persistent SQLite/WAL bytes after reads, and orphan inventory/new-incarnation rejection. Resource records are explicitly synthetic. Shared-memory read marks are not asserted immutable.
- `node browser-qc.mts`: 18 groups PASS at 2026-11-08T16:48:52.596Z. Report `browser-qc-d6417d52-53ef-4e54-a219-57482dfba6a8\report.json`. Actual installed Chrome 157.0.8103.38, Playwright 1.65.0, Node 24.22.2 Windows x64, real private ACLs and SQLite.
- Browser fixture proves two independent sessions, three pages, cookie sharing only inside one session, real loopback navigation, bounded DOM/password omission, frame metadata, document invalidation, actual PNG source/final dimensions/hash, 1440x1000 to 800x555 downscaling, exact v1 internal transfer, attachImage=false, duplicate creation/action with no second resource/navigation, conflict/ACL failures, explicit unsupported frame/JPEG/offorigin behavior, responsive inspection during delayed navigation, and 1ms close deadline followed by late authoritative same-call completion.
- Controlled unindexed-image and retained-image corruption injections are labeled controlled, not real-crash tests. Corrupted bytes are rejected before delivery.
- Final run's two public owned process proofs: host/browser PIDs 7492/7980 and 4516/6304. Both BrowserServer process exit, Node host exit, generated-profile removal and private TEMP-root removal were verified true. Only these owned resources were closed. Fixture loopback listener is closed in finally; command returned.
- Syntax checks pass for all six feature source modules. No TypeScript static compiler build is claimed. `git diff --check` passes for tracked changes. Full source hashes and reviewed-body equivalence are in `final-source-hashes.json`; final browser report confirms no source changed during its run.

## Failed-run evidence and unresolved leftover

Failures are retained, not replaced by the passing report:

1. First fixture invocation used an invalid Windows ESM import form and failed before dispatch. Corrected to file URLs.
2. Fresh-child ACL preflight found the elevated token's default child owner was Administrators despite narrow inherited permissions. Read-only own-scratch ACL diagnostics established it. Fresh-child initialization now sets and verifies the actual current SID explicitly. No browser was started by that failed preflight.
3. The extended short-close fixture initially inspected for only 7.5 seconds, then treated expected uncertainty as failure. Its finally path did not prove cleanup for one resource. The fixture now tracks the original close call, inspects it for a bounded 120 seconds and never creates a new input to poll. Host-first shutdown replaces potentially delaying client context/disconnect cleanup.
4. Controlled orphan-image preflight caught an over-escaped filename regex before browser dispatch. Corrected and exercised in the final passing run.

An old private TEMP/profile from failed run 3 remains unresolved and was NOT killed, globally scanned or deleted:

`C:\AIWork\2026-11-08\CDP1935261\client\browser-qc-d9202786-8451-46fc-ac1c-4ee6a3a2d9ba\private\browser-70622ada-ee2a-4b68-99ff-4ad6790d564a`

It contained `playwright-artifacts-EyvxJI` and `playwright_chromiumdev_profile-BWQwZy` at inspection. Those names do not prove an old process is still running or exited. The lost runtime did not persist its public PID proof, so installation identity alone is insufficient to kill anything. Coordinator board 102 records this explicitly. New host code persists only nonsecret public spawned host/browser PID and profile-leaf proof inside its dedicated private TEMP. The final passing run's complete cleanup does not erase this earlier leftover.

## Remaining gates and unsupported work

- Shared server.js dispatch/logging/body hooks, tool registration, automatic existing bridge integration and outgoing provider image validation are not implemented or edited. Actual transport/provider acceptance is pending.
- No broad Click/Fill, watch, dialog-resolution, file-selection, download, JPEG, headful, external-site navigation, iframe-target or observation-pagination adapters. Defaults/schema alone do not implement them. Downloads are disabled and advertised unsupported.
- macOS runtime/browser compatibility and a macOS private storage guard are unsupported/unverified. No fallback to desktop input.
- General uncertainty reconciliation and verified orphan-resource disposition are unsupported. Unknown resources continue reserving capacity. No restart reattachment/survival is advertised.
- Existing server C# TempCache will be the authoritative sliding live lookup when integrated. The client has no independent idle/TTL session cache. The server can cache its proxy under the same verified client-generated session UUID; no wire change or manual binding workflow is needed. Expired server IDs must not be resurrected from client inventory. Server expiry cleanup remains a separate pending lifecycle integration concern.
- This demonstrates limited installed-Chrome compatibility, not a general browser-version matrix or completed browser-workflow acceptance.

## Pending cross-runtime transfer rule

Board 109 flags a concrete integration rule before wiring. Screenshot is a named asynchronous read; its completed GetCall currently carries transfer only when the retained original operation is Screenshot and attachImage=true. The server's draft rule allowing transfer only for op Screenshot/ReadArtifact must either validate GetCall against the verified retained original Screenshot plus artifact ownership, or align a separate internal ReadArtifact wire operation. Arbitrary GetCall transfer must not be allowed. No ReadArtifact wire schema or tool registration is implemented. This is pending contract integration, not a silent validator bypass.

Await coordinator FollowUpPrompt before further implementation.
