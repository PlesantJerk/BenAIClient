# CDP client rollout runbook

## Status: preparation, not deployment

Runtime35 is frozen at task scratch `download-policy-resumption/handoff-9dElP9/manifest.json`. Client capture/deny passed6 and preceding image/cache passed10 in separate owned-loopback scopes. These are not signed-in production/provider acceptance. The matching server image/cache and download-policy paired workflows have now passed, followed by the actual final net9 host build. The authoritative current server checkpoint is `Phone/ChatAblaze/ChatAblaze/Implementation/ChromeCDPTools/ROLLOUT_CHECKPOINT.md`; its download-policy-stage receipts identify the exact mutually tested hashes. Client standalone tests and server paired tests remain separate evidence, and neither establishes deployed live-provider acceptance. No rollout, main/poller or provider was executed to prepare this guide.

## Prerequisites and existing non-Electron entry

Use approved matching server/client files, including the complete `.mts` graph. Required existing runtime: Node24, exact playwright-core1.65.0, locked jpeg-js0.4.4 and installed Chrome. Tested machine: Windows x64, Node24.22.2, Chrome157.0.8103.38. Bootstrap currently selects `C:\Program Files\Google\Chrome\Application\chrome.exe`, not a new model/config field. No browser download or Electron is required.

Run as the intended Windows user with usable local application storage and PowerShell ACL APIs. Protected ownership/ACL, marker, reparse/alias, path-budget and known-schema checks must pass; do not repair or replace unsafe existing state to force startup. Existing account/feed authorization and client selection must work. This guide invents no credentials, deployment mechanism or service setup.

**Only after explicit approval**, the existing `README.md`/`aiqa.js` command is:

```
cd /d C:\Code\aiqa-cdp\BenAIClient
node aiqa.js
```

This starts the real poller, not a health check. `package.json` has no start script; its main field is not this entry and its test script is a placeholder. The runtime loads `.mts` directly. noEmit is a bounded check, not an emit/build requirement.

## Configuration and one-poller rule

`aiqa.js` reads working-directory `config.json`. Existing field names only: `email`, `client_name`, `root_dir`, `conversation_location`. No values/replacement config are supplied. Missing email prompts and writes it. `ai-config.mts` is existing project-picker metadata, not CDP identity/settings.

Identify the exact existing terminal/service/task launch before starting; permit only one poller for the account/client-name route. No second test poller or blanket Node/Chrome termination. The private SQLite lease cannot protect duplicate legacy pollers before lazy CDP bootstrap. Finish owned sessions before changing route/root. CLI `name`/`cd` retain existing persistence behavior; CDP captures its route and virtual root. Renaming can require deliberate CDP restart, not resource migration.

## Harness and asynchronous work

Supported scope: primary/root runtime and trusted PromptExecution-backed async workers. Legacy synchronous nested/headless factories cannot prove their immediate caller, so current binding omits/filters CDP definitions. Do not invent a sync fallback/error identifier. Actor/parent/client bindings come from the harness. Exact immediate parents have retained inspection only, not new snapshots/input/watch cancellation or owner export.

Save returned session/page/frame/document and original call/action/creation IDs. CreateSession returns an initial blank PageId. Accepted/dispatchStarted is not business success. Inspect pending work with GetCall/GetAction, never resend input to poll. Same ID returns retained state; changed parameters conflict. Uncertainty requires inspection before a genuinely new action. HandleDialog is an exact active owned-dialog exception, not a general bypass. Wait timeout/cancel does not cancel an already-running browser function or app transaction.

## Scope, image/provider limits and remaining variants

Windows isolated headless Chrome only: no profile takeover, OS focus/global keyboard, headful/macOS certification or proven OOPIF process isolation. General HTTP/HTTPS uses normal Chromium networking/cache, **not a network sandbox**. Command URL preflight remains. Only explicit embedding/QC fixtureOrigin routing disables cache/rejects differentiated bypass; it is not maintained user config.

- PNG/JPEG and visible target/child/iframe rectangles use measured CSS geometry and persistent DPR. No crop scroll/fallback; transformed/clipped/offscreen/advanced geometry or zoom other than1 may reject. Occlusion is possible, not isolated element paint.
- Image source/delivery each at most8MiB; requested maximum dimension at most4096, default1600; stricter caller limits apply. Retained source is immutable, never recaptured. Resized JPEG delivery uses fixed85. Actual attachment bytes are separate from metadata. Encoded replies12MiB, nonimage128KiB, normal arguments64KiB.
- A path/text description is not model vision. Confirm an actual decodable attachment reaches the chosen provider/model. Responses/Claude offline serialization/pixel evidence is not a live provider test.
- Limits:8 sessions/account+client,8 pages/session,32 watches/page;5000 events or4MiB/session with gaps; rich evidence7days and persistent dedup identities; artifacts256MiB/session and1GiB/account+client combined. Download64MiB default; transient native overshoot is best-effort, retained admission hard. Deny never admits artifacts; native events may be silent and no app rollback is claimed.
- Remaining variants: main-frame file input/pointer drag only, synthetic drag unsupported, virtual file namespace/default10000ms timeout, restricted page keys, no SecretRef resolver, bounded main-native network previews/no HTTP replay or child-network join, binary metadata rather than binary text, three trace sections rather than HAR, incomplete geometry/platform coverage. Regex: fixed Unicode-u,1024-pattern/32768-input/100ms. Predicates repeat in exact browser frames and may mutate/await; not purity or cancellation guarantees. Query capabilities rather than infer full variants from all32 tool names.

## Private state, safe close and logs

Storage: `%LOCALAPPDATA%\BenAI-CDP-v1-<route digest prefix>`, verified marker and private `journal`, `images`, `observations`, `downloads`. Persistent installation ID/HMAC key require no new maintained credentials. SQLite WAL/FULL records acceptance and the pre-input barrier; full arguments affect a keyed digest without raw argument-payload storage. Artifacts/logs/trace can nevertheless contain sensitive data.

Restart preserves evidence/dedup, not browser reattachment, input replay, watch rearming or release of unknown reservations. Runtime cursors/bodies may be unavailable. Expired identity is not a fresh action.

Prefer explicit owned ClosePage/CloseSession and inspect original completion. Page quota needs verified exact-page closure. Session completion needs **browserExited, hostExited, generatedProfileRemoved, privateTemporaryRootRemoved** all true. Cleanup stops observations, closes its owning host/browser first, then disposes helpers on closed pages. Running mechanics can block close; inspect/resolve only the exact dialog, not bypass. Initialized SIGINT/SIGTERM handlers attempt bounded cleanup, but process exit/PID absence is not four-proof cleanup; Windows terminal/signal behavior is not certified here.

`CreateSession.options.redactLogs` defaults true. Authorized OFF may log raw sensitive values/page contents and bounded native errors. No password-screenshot ban, masking prerequisite or privacy guarantee. Diagnostics stay16KiB and exclude giant image/base64 dumps/private control fields. Unknown/default scopes remain metadata-safe; server logging is separate.

Historic102/152, CLIENT12 modal and three CLIENT13 helper failures remain Pending, not startup cleanup targets. Refer to existing `cdp-dialog-network-status.md`, `cdp-helper-resumption-status.md` and task `factual-audit.md`. Specific modal PIDs were absent, not proof its profile/TEMP was removed. Later success never repairs old receipts. Do not broad-scan, delete or reuse those scopes.

## Proposed signed-in live smoke: NOT executed

After matching deployment/provider approval, use one approved non-destructive account/application:

1. Start exactly one poller. In supported root/async harness select its existing client; GetCapabilities must verify revision `v1-redactLogs-2026-11-08`, actual installation/incarnation, image/Reload/download subsets and provider image availability.
2. CreateSession, save IDs/initial PageId, Navigate and sign in using owned tools. Do not import a normal profile. Observe/Inspect a harmless signed-in element; record actual application evidence.
3. In that same context capture PNG/JPEG/visible target. Verify actual provider attachment MIME/dimensions/hash, not metadata alone. Read retained scaled image and source immutability; resize DPR if supported and confirm auth persists.
4. Prearm a watch, perform one harmless input with a new action ID, inspect original GetCall/watch. Capture/read a small approved download. In a separate deny session confirm no admitted artifact, without requiring native events.
5. On an approved cacheable page compare normal/bypass/normal against real server/network evidence; otherwise record unavailable, not success inferred from reload.
6. Close owned sessions, poll original calls and verify four flags, retained artifact access, inventory and no pending operations. Stop only the identified client after cleanup. Save actual replies/attachments/timestamps/uncertainty. Missing receipt/provider proof means partial smoke, not rollout acceptance.

No deployment procedure, live provider/login or service installation is claimed by this proposed sequence.
