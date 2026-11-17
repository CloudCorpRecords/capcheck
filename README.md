# capcheck

Answer three questions about Lead Friendly without taking on a sales pipeline. capcheck is a small forwarding client for the hosted Lead Friendly MCP service: the tool list is served from your own machine using the captured definitions, and each call is sent upstream, with the service's answer returned exactly as it arrived.

Three of the service's five captured tools are exposed, and all three are read-only lookups over published information: what the subscriptions cost, which industries have a ready-made agent template, and whether a job you describe is something the service can do. The other two captured tools, `book_demo` and `create_lead`, are deliberately left out: both hand a prospect's name and email to the vendor's sales team, and this rebuild does not route anyone's personal details anywhere.

## The tools

- **`get_pricing`** — The current subscription plans and prices, read live from the vendor's pricing source of truth. No arguments.
- **`list_industries`** — The industry verticals that ship with a tailored agent template, such as auto dealerships, trucking and dispatch, dental, and HVAC. An optional `query` keyword narrows the list.
- **`check_capability`** — Ask whether a specific job is covered, in plain language: after-hours lead calls, truck dispatch, white-labelling for an agency, and so on. The job goes in the required `query` argument.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/capcheck mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "capcheck": {
      "command": "npx",
      "args": ["-y", "@reneturcios/capcheck", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/capcheck
docker run --rm ghcr.io/cloudcorprecords/capcheck get_pricing '{}'
```

## CLI

A single binary covers both the command line and the MCP server. Every tool is a subcommand whose one argument is a JSON string of that tool's inputs:

```bash
capcheck get_pricing '{}'
capcheck list_industries '{}'
capcheck list_industries '{"query":"auto"}'
capcheck check_capability '{"query":"call leads after hours"}'
capcheck --version
```

Exit codes: `0` for a successful forwarded call, `1` when the result that comes back is an error, and `2` for usage mistakes like an unknown subcommand or a JSON argument that does not parse. `book_demo` and `create_lead` are not subcommands and exit `2` like any other unknown name.

## Configuration

- `LEADFRIENDLY_MCP_URL` — Replaces the upstream endpoint. Defaults to the pinned hosted endpoint, `https://www.leadfriendly.com/api/mcp`. (This override variable is a reconstruction introduced by this rebuild.)

The Lead Friendly registry record lists no headers for its remote, so capcheck never attaches an authentication header — every call goes upstream keyless.

When the upstream cannot answer — it returns a JSON-RPC error, answers with a non-2xx status, sends a body that cannot be read, or the request itself fails — the caller receives an error result whose text begins with `capcheck error:`.

## How forwarding works

The first call of a process opens a session against the upstream: an `initialize` request (protocol version `2025-03-26`), a `notifications/initialized` notification, and then the `tools/call`. If the service issues an `Mcp-Session-Id` header during initialize, capcheck repeats it on subsequent requests and keeps reusing that one session until the process ends. Replies are understood in both plain JSON and server-sent-events framing. Successful results are passed through untouched, `isError` flag and any extra fields included.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The suite compares the served tool list against the captured surface tool for tool, asserts the omitted `book_demo` and `create_lead` tools are absent at the registry, MCP and CLI levels, walks the session handshake and its reuse, proves no `Authorization` header is sent under any environment, and confirms that arguments travel upstream unchanged and results return unchanged.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
