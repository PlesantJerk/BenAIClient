# Initial macOS CDP smoke fixture

**Prepared for review, not native-executed.** This is an embedding-only smoke check for the initial client port, not the main client, poller, server/provider integration, model image delivery, privacy certification, or a full-platform port.

Runtime source checkpoint: `657ab5622548ddbff3e9bae79dedbcc92ce26be2`. The fixture checks the six reviewed runtime byte hashes as well as an explicitly supplied, exact checkout commit containing the reviewed fixture. Do not substitute an arbitrary branch tip for that reviewed commit.

## Supported initial 12

`GetCapabilities`, `CreateSession`, `GetSessions`, `CreatePage`, `GetPages`, `CloseSession`, `GetCall`, `GetAction`, `Navigate`, `Observe`, `Screenshot`, `ReadArtifact`.

Advanced operations remain excluded on macOS: `Click`, `Fill`, `PressKey`, `InspectElement`, `CreateWatch`, `WaitFor`, `CancelWatch`, `ReadEvents`, `ClosePage`, `Reload`, `SetViewport`, `Hover`, `SelectOptions`, `SetChecked`, `Scroll`, `DragAndDrop`, `HandleDialog`, `GetNetworkExchange`, `SetInputFiles`, `Evaluate`, and `ExportTrace`. This fixture does not enable them, attach to an existing browser, or use a normal Chrome profile or OS mouse/keyboard.

## Requirements and isolation

- Use a Ben/coordinator-approved **native macOS** host and ordinary current user, not `sudo`. The entry guard rejects any actual platform other than `darwin` before filesystem/runtime/browser activity. Never spoof `process.platform` to get a pass.
- Use an approved native **Node 24+** executable with `.mts` type stripping and `node:sqlite`. Record its actual executable/version. A PATH Node version is not evidence of the existing AIQA process's runtime. Obtain the existing application's runtime metadata from its owner without restarting it or printing credentials; this script does not scan that process.
- Existing **playwright-core 1.65.0** is required. Existing **jpeg-js 0.4.4** is optional: unavailable means an explicit JPEG skip, not permission to install or substitute a codec. JPEG decode/capture failures are failures, not skips.
- Installed executable Google Chrome must already exist at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` or the current user's `Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. No browser downloads or channel installs.
- Use a clean, approved **isolated client checkout/worktree**, not the live poller's checkout. After the fixture is reviewed and committed, the coordinator can approve a detached side worktree at that exact commit. Do not pull into, restart, or change configuration in an existing running-client checkout to prepare this test.
- The isolated tree must already resolve approved native dependencies. If it does not, stop for Ben's separate approval. Do not install, copy Windows `node_modules`, or create dependency links without approval. Do not transfer Quore source, production configuration, certificates, credentials, or private journals to a cloud/VPS.
- Choose an existing, real nonsymlink, current-user-owned `AIWork` parent outside the checkout. The scratch **leaf must not exist**, even as an empty directory or broken symlink. The fixture creates it itself with mode0700. It never defaults to Application Support, a real route, or production storage.

## Metadata preflight, on the approved Mac only

First set the approved native executable and isolated checkout paths. These commands read only metadata and do not start the application/browser:

```
NODE='/absolute/path/to/approved/node'
CHECKOUT='/absolute/path/to/approved/isolated/client'
cd "$CHECKOUT"
git --no-pager rev-parse HEAD
git --no-pager status --short
"$NODE" -p 'JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,execPath:process.execPath})'
"$NODE" -e 'const r=require("node:module").createRequire(process.cwd()+"/package.json"); console.log({playwright:r("playwright-core/package.json").version}); import("node:sqlite").then(()=>console.log({sqliteImport:true}));'
```

Have the coordinator compare the commit, fixture/script hashes, actual runtime, and installed Chrome metadata with the approved review. Missing prerequisites do not authorize installation. The fixture itself reports exact optional JPEG availability and Chrome/runtime versions from the real APIs.

## Exact invocation, only after separate native-run authorization

Use a unique coordinator-approved leaf. Do **not** run `mkdir "$SCRATCH"` first. The five arguments and their order are required:

```
SMOKE_COMMIT='<reviewed 40-hex commit containing this fixture>'
SCRATCH='/Users/<native-user>/AIWork/<approved-unique-new-smoke-leaf>'
"$NODE" "$CHECKOUT/tools/cdp-macos-smoke.mts" \
  --scratch "$SCRATCH" \
  --expected-checkout-commit "$SMOKE_COMMIT" \
  --approve-fresh-scratch
```

This reads the project's actual published `CdpClientBootstrap.open(route)` and `runtime.manager.execute(...)` APIs. The synthetic route, Int64-string scope IDs, and fixture fingerprints are embedding test data, not real credentials or a test of server fingerprint authentication. The explicit `storageParent` is the new scratch's `storage` child; no production virtual root is supplied.

## What it records and checks

- Code/fixture hashes, actual Node/platform/architecture/uid, timestamps, original request/call IDs, responses, and private receipt files. HTTP binds only to a disposable `127.0.0.1` port; the runtime's exact fixture-origin restriction blocks other application URLs.
- Current uid and exact directory0700/file0600 for installation, marker, journal SQLite/WAL/SHM and artifacts while open. The HMAC key is **inside SQLite**, not a separate invented key file. A read-only query selects only its length (32) and installation ID; no key value is selected, hashed, logged, or sent.
- Fresh scratch-only negative mode, hardlink and symlink cases. Wrong modes remain rejected and unchanged. The intentionally bad fixtures remain under the outer0700 evidence root; no production path is repaired. Actual foreign-owner/extended-ACL certification is not claimed.
- Prompt capture of the existing host's `owned-process.json`, generated profile/temporary paths and public BrowserServer-derived PIDs during initial creation polling. Exact-PID `ps` checks confirm current uid and parent relationships. A bounded environment read of **that owned child only** checks its actual TMPDIR. Other environment values and raw process environment are never written to evidence or console; there is no global process scan.
- Initial blank page, second page, inventories, navigation to a unique local marker, Observe, retained GetCall/GetAction, completed-creation dedup, wrong-actor and wrong-page rejection.
- Actual 640x480 PNG and, only when available, JPEG raster decoding, encoded-byte/hash checks, and retained artifact reads. These are real internal bytes, **not model/provider attachment-delivery evidence**.
- Unchanged parent TEMP/TMP/TMPDIR and umask, and the four exact cleanup flags: `browserExited`, `hostExited`, `generatedProfileRemoved`, `privateTemporaryRootRemoved`. Normal shutdown must also show zero pending operations and a closed journal.

Bounds: one session, two pages, headless only, viewport640x480 at DPR1, download policy `deny`, maximum download option1MiB (no download exercised), startup/close caller timeout60000ms, navigation timeout30000ms, named-operation observation deadline180000ms with250ms read polling, maximum1200 receipt calls. The runtime's existing image/size/durability/ownership limits remain in force. This is not a network sandbox guarantee beyond this disposable fixture-origin restriction.

## Results and failure handling

Evidence stays in `SCRATCH`: `report.json`, `receipts/`, `owned-process-copy.json`, `owned-process-native-proof.json`, `capture.png`, optional `capture.jpg`, and the synthetic private store. Preserve it privately; do not upload the key-bearing SQLite files as a routine report.

- `NATIVE_SMOKE_PASS`: actual Darwin execution completed the stated checks, including JPEG and four cleanup proofs.
- `NATIVE_SMOKE_PASS_WITH_JPEG_SKIPPED`: the same smoke, but JPEG was unavailable and **not tested**. Neither status is full-platform, provider, or business-application acceptance.
- `FAIL`: setup/assertion failure, not a pass. Already-known owned resources receive at most one normal exact-owner close, only if no uncertainty/pending operation exists.
- `UNCERTAIN`: preserve the scratch, original call IDs, process receipt and running owner for the coordinator. No new dispatch, cleanup replay, broad kill/delete, or automatic restart is attempted. The owned IPC/loopback server may intentionally keep the process alive. Do not start another fixture, force-exit it, or use a new ID to bypass uncertainty. Cleanup requires a specific coordinator decision using the exact recorded ownership evidence; an already-started native close cannot be unsent.

Return the actual exit/result, report and selected nonsecret receipt/image files for review. An exitless or partial run is not success. A preflight/final-evidence-write error requires checking the explicit scratch path before any rerun. Windows syntax/typecheck receipts are preparation evidence only; **native macOS validation is still pending until this authorized run actually occurs**.
