# CDP client groundwork status

**Historical phase-2 snapshot.** Current browser-module delivery, actual runtime evidence and unresolved earlier fixture leftover are documented in `cdp-browser-status.md`. Statements below about unimplemented browser work or no browser launch describe that earlier snapshot, not the current feature slice.

**Independent follow-through:** board 77 independently verified all five original findings fixed against contract ed3be3 and store e2c685. Later coordinator-authorized additive read/housekeeping APIs changed the store hash to 13a776. Owner QC 23 groups plus focused inventory QC 5 groups pass. Removing only the additive APIs reproduces the exact independently reviewed e2c685 body hash. The new browser code/read additions are not yet independently reviewed.

Parent conversation: 1935261. Scope: feature-local v1 contract and private SQLite metadata journal. This is not a browser adapter, tool registration, outgoing-image validator, or end-to-end browser acceptance.

## Implemented

- `cdp-contract.mts`: immutable captured identity, v1 command validation, canonical positive Int64 string IDs, a deliberately limited operation argument-schema subset, normalized defaults, bounded receipt/reply data models, and class-owned shared quota defaults from board post 30.
- `cdp-store.mts`: explicit private-directory policy requirement; ordinary unaliased SQLite files; WAL and FULL synchronous writes; atomic process-owner lease; persisted installation ID and private independent HMAC key; immutable captured client binding; durable acceptance and fresh dispatch barrier; exact owner/parent retained reads; parameter/fingerprint conflicts; evidence metadata bounds; terminal payload expiry with persistent dedup identities.
- Keys and raw normalized arguments, URLs, scripts, values and bodies are never put into receipt/event/artifact metadata. Only the keyed digest is persisted for input integrity. Installation UUID is routing metadata, not evidence of browser ownership.
- Parent inspection permits retained reads for the exact captured immediate parent/account/client only. It cannot accept input, grant a barrier, complete an operation, or append evidence.
- On a controlled reopen, accepted-only receipts become failed-before-dispatch; started receipts become uncertain; known live sessions become orphaned and continue reserving resource capacity. There is no browser reattachment, replacement, replay or process kill.
- Uncertainty fences related fresh input. Receipt reads do not unlock it. A later authoritative completion in the same client incarnation may complete the original operation, preserving minimal first-uncertainty timestamp/cause. No general observation/reconciliation unlock API is implemented yet.
- Rich evidence age does not close a live/orphaned session, delete page ownership, or expire in-flight/uncertain safety records. Only an authoritative owned CloseSession outcome releases a live session slot. Tombstones are not evicted to make room; new IDs fail closed at capacity.

## Independent review follow-through

| Finding | Initial status | Current owner status and evidence |
| --- | --- | --- |
| HIGH, uncertainty released input exclusion and rejected a late definitive completion | Pending, board 55/56 | Fixed in owner QC: sticky uncertainty fence; no second dispatch; late completion accepted; first uncertainty retained. |
| HIGH, uncertain creation released resource reservations | Pending, board 55/56 | Fixed in owner QC: uncertain session and page creation retain reservations; cap-1 cases remain full before and after late completion. |
| HIGH, diagnostic pruning released live session/page accounting | Pending, board 55/56 | Fixed in owner QC: retention clears eligible evidence only; live/orphaned sessions and page handles remain; in-flight/uncertain receipts remain safety-active. Cap-1 old-creation/recent-event/in-flight case stays full until simulated authoritative close. |
| Int64 event insertion cursor rounded above JavaScript safe integer | Pending, board 58/60 | Fixed in owner QC: cast SQLite last_insert_rowid() directly to TEXT; returned/read cursor matches 9007199254740993 exactly. |
| Receipt linked nonexistent or other-account/session artifact metadata | Pending, board 58/60 | Fixed in owner QC: completion validates existence, retained age, captured account and owned session before committing evidence. Invalid links roll back. This was an evidence-integrity finding, not a demonstrated byte-read authorization bypass. |

Owner QC passing does not substitute for the independent reviewer's stable-source recheck.

## Validation performed

Package-free fixture: `C:\AIWork\2026-11-08\CDP1935261\client\groundwork-qc.mts` imports the actual source modules and the server-owned golden fixture read-only. Uses built-in Node assert/crypto/fs and SQLite, not a new test framework. Final owner review-regression run: 23 groups PASS, report `C:\AIWork\2026-11-08\CDP1935261\client\qc-8d67dc4f-b17f-4b71-921f-b1337389a7c1\report.json`.

The fixture checks valid/invalid wire and normalization, Int64 IDs, exact ownership/client binding, duplicate/conflicting full sensitive arguments, no sensitive argument plaintext in DB/WAL, a controlled failure before barrier commit, one-time barrier/page busy gates, controlled close/reopen recovery, expiry/tombstone capacities, session/page reservations, bounded event count/byte/age gaps, artifact metadata capacities, storage guard rejection/aliased-file rejection, and all review regressions above.

All DBs/keys and metadata are synthetic and under scratch. Controlled injected failure, synthetic dispatch/completion, and clean reopen are not real crash, browser, business-write or bridge acceptance tests. No browser has been launched in this delivery. Node syntax checks pass; no TypeScript static compiler build is claimed.

## Approved dependency provisioning completed

- Existing locked runtime packages: `npm ci --omit=dev --no-audit --no-fund`, session-only `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.
- Exact new dependency: `npm install --save-exact playwright-core@1.65.0 --omit=dev --ignore-scripts --no-audit --no-fund`, session-only Electron and Playwright skip-download variables.
- Runtime import-only checks pass for nut-js, koffi, screenshot-desktop and playwright-core. Playwright reports 1.65.0. Electron is not installed. No browser download or manual install-script approval occurred. The package/lock diff contains only the exact Playwright dependency/lock entry.
- Existing dependency install reported deprecated inflight/rimraf/phin/glob and an npm install-script policy warning for koffi. Imports work without bypassing that policy. No audit fix, unrelated update or persistent npm policy change was made.

## Pending / unsupported

- Shared dispatch/logging/body hooks and outgoing image boundary. No `server.js`, `config.json`, poller, lifecycle/base or server-source integration changes in this delivery.
- A real production directory ACL/ownership guard must be supplied by the embedding harness. The fixture guard deliberately authorizes scratch only and is not proof of Windows private-directory ACLs. No production store was opened.
- Browser manager/adapters, actual browser ownership/profile proof, observations/dialogs/watches, approved file resolver/transfer, artifact byte persistence, image decode/nonempty verification and attachments, cleanup and explicit uncertainty reconciliation. Wire schemas and metadata validation do not implement these functions.
- General late-failure/disposition or verified orphan-resource release is not implemented. Unknown resources remain accounted for rather than presumed absent. No restart recovery is advertised.
- Installed Chrome/Playwright compatibility, isolated fixture browser workflow, deployed bridge acceptance, provider image delivery, and all macOS execution remain unverified. No OS focus or global input is involved.
- Shared limits are configurable initial defaults. Watch/encoded reply quotas are defined by the contract but have no executing watch/HTTP/image adapter in this slice.

No services started/restarted/deployed. No SQL applied, commits or pushes. Await coordinator FollowUpPrompt before the next implementation slice.
