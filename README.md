you can modify the config.json with your email address and default root_dir

```config.json
{
    "email":"You account email",
    "root_dir":"Starting location of where you want the AI to operate on your local machine",
    "conversation_location":"Storage location for private conversations"
}
```

alter the email to your email, root_dir and conversation_location to places on your drive

then to run just

> node aiqa.js


note: you can change the dir once you run the aiqa using the `cd [path]` command

## Prompt project autocomplete

The Blazor Home prompt can request project metadata and name searches through the existing client connection. These commands are UI helpers, not new LLM tools.

- Type `@bs Hom` to search source files and directories in project `bs`.
- Type `$ch req` to search documentation files in project `ch`.
- A space separates the alias from the search. Searches start at three characters.
- Matching uses case-insensitive basenames: prefix matches first, then contains matches, with deterministic name/path ordering.
- Selection inserts a backticked `virtual folder:\relative\path` reference. It does not attach or read the file.
- Arrow keys and Enter select; Escape, close, or outside click cancel without deleting typed text. Ctrl+Enter retains the existing send shortcut.

Edit the exported `GlobalConfig` in `ai-config.mts`, then restart the client manually. The current runtime loads `.mts` directly (validated on Node 24.16.0); no new compilation step is required for the client.

Configuration options (defined in `configsetup.mts`):

- `projects`: aliases with `name`, `path`, and optional `comment`. Names must be unique ignoring case and contain no spaces. Paths must resolve within the current virtual root.
- `exclude_directories`: directory-basename wildcard patterns, applied at every depth, case-insensitive. `*` matches any sequence and `?` one character; `.*` excludes dot-prefixed directories.
- `max_match_count`: positive integer, default 10.
- `at_file_extensions`: overrides the source extension list; defaults to `cs, ts, js, razor, vue`. Ben's configuration additionally includes `mts, cjs`.
- `dollar_file_extensions`: overrides the documentation extension list; default `md`.

Extensions may include a leading dot. Directory symlinks/junctions are not traversed. Searches use a short-lived, 15-second metadata index; new/deleted names may take that long to appear/disappear. Large or slow scans return an error rather than silently presenting partial rankings.

The transport remains sequential. A picker request can wait behind another client command. The UI debounces/coalesces searches and ignores obsolete responses; it does not change command concurrency. Do not start a second polling client with the same identity for testing.

Generated/dependency directories are not implicitly excluded: add `dist`, `bin`, `obj`, `env`, or `venv` to your exclusion list if you do not want those names in results.
