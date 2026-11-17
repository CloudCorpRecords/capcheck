# BUILD-REPORT — capcheck (Lane B, Batch B5)

Rebuild of `com.leadfriendly/lead-friendly-info` v1.0.0 (remote-only MCP
server at `https://www.leadfriendly.com/api/mcp`), per
`specs-laneb5/capcheck.md`. Forwarding client, labelled subset: 3 of 5
captured tools. Fixture:
`harness/fixtures/leadfriendly-info-tools-original.json`.

## Resume note

This build is a RESUME of a partial build: the previous builder died
mid-build (platform failure, no report). The resuming builder did not
trust the partial work; every pre-existing file was read and verified
firsthand against the spec and fixture before being built on.

State found on resume (more complete than the handoff described):
`src/{types,index,forward,mcp,cli}.ts`, all 4 workflows, `tsconfig.json`,
`.gitignore`, `LICENSE`, plus `package.json`, `server.json`, `Dockerfile`,
`README.md`, `CHANGELOG.md` and `test/forward.test.ts` already present.
Missing: `package-lock.json`, `dist/`, `parity-out/`, `BUILD-REPORT.md`,
and the back half of the test file.

## Verification of pre-existing work

- `src/forward.ts` — verified against spec: pinned upstream
  `https://www.leadfriendly.com/api/mcp`, env override
  `LEADFRIENDLY_MCP_URL`, error prefix `capcheck error:`, headers limited
  to Content-Type/Accept (+ Mcp-Session-Id when issued) — no
  Authorization header is ever constructed. Session flow
  initialize → notifications/initialized → tools/call, SSE-tolerant,
  results passed through verbatim.
- Tool literals — verified independently of the test suite: the
  TOOL_DEFS block in `forward.ts` was extracted and deep-compared in
  Python against the fixture; result: deep-equal, names in order
  `get_pricing`, `list_industries`, `check_capability`, each carrying
  exactly the keys `name`/`description`/`inputSchema` with
  `additionalProperties: false`. (Generated programmatically from the
  fixture by the scratch generator `/tmp/laneb5-capcheck-scratch/gen.py`,
  never retyped.) No fixture/spec conflicts found; nothing in `src/` was
  rewritten.
- `src/mcp.ts` — verified: low-level `Server` API (not McpServer/zod),
  tools/list answered locally from TOOL_DEFS, unknown tools rejected
  with McpError MethodNotFound, non-object args with InvalidParams.
- `package.json` — `@reneturcios/capcheck` v0.1.0, one bin, fleet dep
  ranges, mcpName `io.github.CloudCorpRecords/capcheck`. Conforms.
- `server.json` — description verified at exactly 91 chars (the spec's
  string verbatim); npm entry carries `version: 0.1.0`; OCI entry
  `ghcr.io/cloudcorprecords/capcheck:0.1.0` carries NO `version` field.
  Conforms.
- `Dockerfile` — two-stage `node:20-alpine`, ENTRYPOINT/CMD as template,
  label `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/capcheck"`.
  Conforms.
- Workflows, tsconfig, .gitignore, LICENSE, README, CHANGELOG — read and
  conform (CHANGELOG head `## 0.1.0 (2026-10-28)`; README written fresh,
  documents the omissions and the no-auth posture).

## Work completed on resume

- **Completed `test/forward.test.ts`** — the partial file ended after
  the registration-integrity and omissions suites. Appended, in the
  same fake-fetch style and reusing the existing stub-upstream helpers:
  forwarding/session suite (handshake order, pinned + env + deps URL
  resolution, session-id carriage and reuse, verbatim passthrough incl.
  upstream isError, SSE replies, MCP-layer call), no-Authorization
  suite (no auth header under default or credential-laden
  environments; header set is exactly Content-Type/Accept), failure
  suite (`capcheck error:` rendering for RPC error, HTTP 500, malformed
  body, thrown fetch, init failure, timeout, session retry,
  InvalidParams), parseRpcBody units, and CLI surface tests
  (--version, usage/exit-2 paths). This also supplies the
  no-Authorization assertion the spec requires; the pre-existing half
  already carried the registration-integrity deep-equal and the
  book_demo/create_lead absence assertions at registry, MCP and CLI
  level. Nothing pre-existing in the test file was changed.
- **Lockfile, CLEAN Route 3**: generated with no `node_modules` present
  via `npm install --package-lock-only --ignore-scripts --offline`;
  verified parses, name == `@reneturcios/capcheck`, **exactly 128
  package entries**.
- `npm ci --ignore-scripts --offline` clean; `npm run build` clean;
  `npx tsc --noEmit` exit 0.

## Results

- Tests: **55 pass / 55 total, 0 fail** (7 suites, fake-fetch only, no
  live network).
- Parity: **PASS, 100.0%** — original_tools=3, rebuild_tools=3,
  missing=[], extra=[], schema_diffs=[].
  Command: `python3 harness/parity.py --original
  harness/fixtures/leadfriendly-info-tools-original.json --rebuild
  "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/capcheck/dist/cli.js mcp"
  --out builds/capcheck/parity-out` (absolute paths as run).
  Output in `parity-out/` (parity.json, parity.md).
- Full 19-file factory set present. Version consistency: package.json =
  server.json (top-level + npm entry + OCI tag) = core `VERSION` =
  CHANGELOG head = 0.1.0.

## Labelled reconstructions / flags

- `LEADFRIENDLY_MCP_URL` env override and the `capcheck error:` failure
  rendering are labelled reconstructions per spec (documented in code
  comments, README and CHANGELOG).
- Omissions `book_demo` and `create_lead` (PII lead routing) are absent
  and asserted absent at registry, MCP and CLI level in tests.
- No conflicts between the partial work, the spec and the fixture were
  found; no source file required a rewrite. The only incomplete artifact
  was the test file, completed as described above.
- No live upstream call was made by this build; the only live capture
  relied on is the coordinator's fixture.
