# CDP diagnostic client checkpoint

Matching harness/client source is developed on `CDP-diagnostics`. No running client was changed by implementation or tests. The separate `CDP-mac` platform port is not merged here.

The client adds optional poll provenance and best-effort metadata phases for an existing CDP transport attempt. Hostname, configured client name, Node runtime, PID, boot UUID and Node time origin are observations, not routing/authentication or loaded-code proof. No DOM, input values, response bodies, credentials or image bytes are sent to the new metadata endpoint.

Client receipt acknowledgement has a 150 ms cooperative timer budget. Other metadata events use a bounded best-effort lane. Failure or absence does not stop the business command and does not prove the command was not received. Older clients omit these fields; older servers can ignore the optional poll parameter, and an unavailable new endpoint loses diagnostics only.

Only CDP reply publication gains a default 10-second cooperative POST/body timer and explicit HTTP status/failure reporting. One POST is attempted, with no automatic retry or second fallback after send begins. Publication failure leaves server acceptance and the original outcome unknown. Non-CDP publication behavior and routing fields remain unchanged.

Local CDP diagnostics use one asynchronous stdout writer with at most 16 total active/queued records, 256 KiB total and 16 KiB per record plus newline. Admitted ON/OFF projections remain, while oversized/full-queue records drop. Same-buffer partial writes continue asynchronously. A hung OS write may retain one libuv worker; output delivery, flushing and ordering against unrelated legacy console writes are not guaranteed. Drop counters can be reported by later metadata events; if no later event arrives, their absence is not zero drops.

Deploy only after coordinating the matching harness and its separately approved `Sql/RemoteClientCallDiagnostics.sql` migration. A 202 diagnostic response means queued, not durable commit or a business reply. See the server's `Implementation/ChromeCDPTools/CDPDiagnostics.md` for correlation, persistence limits and structured timeout interpretation.

Validation: exact-source inert fault checks, syntax checks and an existing bounded TypeScript noEmit check passed. No live poller, browser/application workflow, endpoint/SQL persistence, provider or native Mac test ran for this diagnostic checkpoint. No dependencies were installed and no historical operation was replayed or reconciled. Restarting an existing client to load these changes requires separate coordination; do not use a restart as cleanup proof.
