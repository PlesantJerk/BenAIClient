# FileTrackingTools independent client acceptance

Run only after the Node feature owners release the client worktree for offline testing. From this QA directory:

```cmd
node acceptance.mjs > acceptance-results.jsonl 2>&1
```

`node acceptance.mjs --preflight` runs only harness/real-console verification and cleanup. Normal execution runs named acceptance groups and exits nonzero on a failure. Capture records contain timing, flags and counts only. The environment record includes SHA-256 fingerprints of the actual loaded feature source files and native server. Source bodies and fixture file bodies are not written to the report. The fixture is created outside the client worktree; redirect reports outside the client worktree if you intend to keep them.

Prerequisites: Node 24, Git for Windows at the usual Program Files location, and already provisioned client dependencies. The harness locates the client automatically when copied to a sibling of `client-src` or run from `tests/file-tracking` in a client checkout. Optional environment variables: `FILE_TRACKER_QA_CLIENT` (explicit checkout); `FILE_TRACKER_QA_DEPENDENCIES` (checkout containing an existing `node_modules`, fallback when the tested checkout has none); `FILE_TRACKER_QA_GIT_EXE` (stock Git executable for the independent oracle); and `FILE_TRACKER_QA_TMP` (an existing external scratch directory; defaults to the OS temp directory). Dependencies are used read-only. No npm install, app start, browser, browser UI, live transport, provider, or SQL. `Server.StartPolling` receives synthetic requests and delivers real native replies through in-memory fetch; actual socket `connect` is denied. The Server, poll dispatch, native console, Git launcher, tracker, filesystem and real Git subprocesses are not replaced. Private client configuration and unrelated desktop-only handlers are stubbed. This does not test C# authority/authentication, production HTTP routing, or providers.

Each run uses a unique disposable scratch directory. The fixture initializes an ordinary Git repo and a linked project worktree with an admin pointer and common refs outside the project. The seed commit is confined to the disposable fixture. All tracker state is inside those generated projects. HEAD, Git refs, linked index/admin/config/ignore bytes, and both project ignore files are compared before and after. Only known synthetic payloads and a harmless synthetic hook/environment test are used. Cleanup terminates the owned native shell before removing the run directory. Only the script and named result files are retained.
