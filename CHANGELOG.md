# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Lead Friendly MCP server. The three captured tools of the labelled subset are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `get_pricing`, `list_industries`, `check_capability`. The captured `book_demo` and `create_lead` tools are deliberately omitted: both route a prospect's name and email to the vendor's sales team (PII lead routing), which this rebuild does not do. The three kept tools are read-only published-data lookups and submit nothing.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `capcheck error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `LEADFRIENDLY_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
