# FileTrackingTools independent client acceptance

Run only after the Node feature owners release the client worktree for offline testing. From this QA directory:

```cmd
node acceptance.mjs > acceptance-results.jsonl 2>&1
```

`node acceptance.mjs --preflight` runs only harness/real-console verification and cleanup. Normal execution runs named acceptance groups and exits nonzero on a failure. Capture records contain timing, flags and counts only. The environment record includes SHA-256 fingerprints of the actual loaded feature source files and native server. Source bodies and fixture file bodies are not written to the report. The fixture is created outside the client worktree; redirect reports outside the client worktree if you intend to keep them.

Prerequisites: Node 24, a working `git.exe` on the client's `PATH` outside the tracked project, and already provisioned client dependencies. The test oracle defaults to Git in Program Files unless overridden; the production tracker does not require or fall back to that location. The harness locates the client automatically when copied to a sibling of `client-src` or run from `tests/file-tracking` in a client checkout. Optional environment variables: `FILE_TRACKER_QA_CLIENT` (explicit checkout); `FILE_TRACKER_QA_DEPENDENCIES` (checkout containing an existing `node_modules`, fallback when the tested checkout has none); `FILE_TRACKER_QA_GIT_EXE` (stock Git executable for the independent oracle); and `FILE_TRACKER_QA_TMP` (an existing external scratch directory; defaults to the OS temp directory). Dependencies are used read-only. No npm install, app start, browser, browser UI, live transport, provider, or SQL. `Server.StartPolling` receives synthetic requests and delivers real native replies through in-memory fetch; actual socket `connect` is denied. The Server, poll dispatch, native console, Git launcher, tracker, filesystem and real Git subprocesses are not replaced. Private client configuration and unrelated desktop-only handlers are stubbed. This does not test C# authority/authentication, production HTTP routing, or providers.

Each run uses a unique disposable scratch directory. The fixture initializes an ordinary Git repo and a linked project worktree with an admin pointer and common refs outside the project. The seed commit is confined to the disposable fixture. All tracker state is inside those generated projects. HEAD, Git refs, linked index/admin/config/ignore bytes, and both project ignore files are compared before and after. Only known synthetic payloads and a harmless synthetic hook/environment test are used. Cleanup terminates the owned native shell before removing the run directory. Only the script and named result files are retained.

## Checkpoint review routes

Run `node review.mjs` with the same environment to exercise the dedicated, read-only review routes against real private Git objects through the native poll dispatcher. It pages a manifest larger than the capture receipt, compares every path/blob tuple to a byte-based oracle, and checks legacy/proved capture metadata, retained historical reads after new edits or capture, exact encodings/size limits, rejected tracker/route/cursor/object/path/tuple combinations, and unchanged private and ordinary Git files. Persist only synthetic result logs outside the worktree. This does not test a real disconnected desktop or C# authorization; the bridge stays offline.

## Scale and whole checkpoint evidence

Run `node large-captures.mjs` with the same environment for an isolated capture exceeding 256 MiB in total and 16 MiB per file. It checks every large blob against stock Git, then transfers a complete 30 MiB historical file in bounded chunks and recomputes its Git hash after overwriting the live file. The test also checks that ordinary preview still reports a version above its display limit, and that wrong route, path, side, or offset and closed readers cannot return evidence. Add `--files` to capture over 8,000 files and enumerate over 30,000 ignored names, then read the full paged manifest and recheck unchanged capture. The fixture checks that at least 2 GiB of scratch space is available before creating any data and removes its own unique fixture afterward. These are regression sizes, not production limits.

## Existing `.aiwork` directories

Run `node work-area-casing.mjs` with the same offline environment. A disposable real Git worktree contains a Git-tracked file under lowercase `.aiwork`. The test opens and reopens the same tracker, captures and reads a saved edit, and checks the ordinary index, refs and existing file. A mixed-case outer name is also accepted, but a junction or incorrectly spelled private `tracking` child is rejected. Only the shared outer directory gets case-tolerant lookup; the tracker still excludes the entire directory from snapshots.


## Git discovery on Windows

Run `node git-discovery.mjs` with the same offline environment and an external scratch directory. The test changes `PATH` only inside its own Node process, starts a fresh offline client per case, and copies the installed Git runtime executable and its neighboring DLLs into a disposable path with spaces. If necessary, set `FILE_TRACKER_QA_GIT_BIN` to the installed runtime directory (`ucrt64\bin` or `mingw64\bin`, not `cmd\`). `FILE_TRACKER_QA_GIT_EXE` is used only as an independent oracle. The test checks that missing or unusable Git is rejected before private directories are created and that an existing `.aiwork` sentinel is preserved. It also checks that the tracker ignores the working directory, relative PATH entries, project-local executables and PATHEXT, and verifies a real capture with the relocated executable and isolated Git options and environment.
