import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  CapcheckClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Lead Friendly endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/leadfriendly-info-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const PRICING = "get_pricing";
const INDUSTRIES = "list_industries";
const CAPABILITY = "check_capability";
const OMITTED = ["book_demo", "create_lead"];
const ALL_TOOLS = [PRICING, INDUSTRIES, CAPABILITY];

const SAMPLE_RESULT = {
  content: [
    { type: "text", text: "{\"plans\":[{\"name\":\"Starter\",\"price\":99}]}" },
  ],
  structuredContent: { plans: [{ name: "Starter", price: 99 }] },
};

const CAPABILITY_ARGS = { query: "call leads after hours" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "lead-friendly-info", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new CapcheckClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

/* CLI helpers (also used by the omission suite). */

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

/* MCP client over an in-memory transport, for tools/list and
 * tools/call assertions at the MCP layer itself. */
async function withMcpClient<T>(
  upstream: { fetchFn: FetchFn },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "capcheck-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 3 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 3);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 3 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool (no title key)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
      ]);
    }
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(defOf(PRICING).description, /subscription plans and prices/);
    assert.match(defOf(CAPABILITY).description, /can do a specific job/);
  });

  it("get_pricing and list_industries carry NO required key; check_capability requires query", () => {
    assert.equal("required" in schemaOf(defOf(PRICING)), false);
    assert.equal("required" in schemaOf(defOf(INDUSTRIES)), false);
    assert.deepEqual(schemaOf(defOf(CAPABILITY)).required, ["query"]);
  });

  it("every inputSchema is an object schema with additionalProperties false", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(schemaOf(tool).additionalProperties, false);
      assert.equal("$schema" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
  });

  it("get_pricing takes no properties", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(PRICING)).properties), []);
  });

  it("list_industries carries only the optional query string", () => {
    const props = schemaOf(defOf(INDUSTRIES)).properties;
    assert.deepEqual(Object.keys(props), ["query"]);
    assert.equal(props.query.type, "string");
    assert.equal(
      props.query.description,
      "Optional keyword to filter industries (e.g. 'auto', 'medical').",
    );
  });

  it("check_capability carries only the query string", () => {
    const props = schemaOf(defOf(CAPABILITY)).properties;
    assert.deepEqual(Object.keys(props), ["query"]);
    assert.equal(props.query.type, "string");
    assert.equal(
      props.query.description,
      "The capability/job to check, in plain language.",
    );
  });

  it("isKnownTool recognises the built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("pricing"), false);
    assert.equal(isKnownTool("check"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("labelled omissions: book_demo and create_lead are absent", () => {
  it("the omitted tools are not among the served tool names (registry level)", () => {
    for (const name of OMITTED) {
      assert.equal(TOOL_NAMES.includes(name), false);
      assert.equal(TOOL_DEFS.some((t) => t.name === name), false);
    }
    assert.equal(TOOL_DEFS.length, 3);
  });

  it("isKnownTool rejects both omitted tools (registry level)", () => {
    for (const name of OMITTED) assert.equal(isKnownTool(name), false);
  });

  it("the MCP layer rejects book_demo as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () =>
        handleCallTool(c, "book_demo", {
          name: "Jane Example",
          email: "jane@example.com",
        }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP layer rejects create_lead as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () =>
        handleCallTool(c, "create_lead", {
          name: "Jane Example",
          email: "jane@example.com",
          phone: "+1-555-0100",
        }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP tools/list response carries exactly the 3 built tools and neither omitted tool", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.deepEqual(
      listed.map((t) => t.name),
      ALL_TOOLS,
    );
    for (const name of OMITTED) {
      assert.equal(listed.some((t) => t.name === name), false);
    }
    assert.deepEqual(listed, fixture.tools);
    assert.equal(upstream.calls.length, 0);
  });

  it("an MCP tools/call for book_demo is rejected and never reaches the upstream", async () => {
    const upstream = makeUpstream();
    await withMcpClient(upstream, async (client) => {
      await assert.rejects(() =>
        client.callTool({
          name: "book_demo",
          arguments: { name: "Jane Example", email: "jane@example.com" },
        }),
      );
    });
    assert.equal(upstream.calls.length, 0);
  });

  it("an MCP tools/call for create_lead is rejected and never reaches the upstream", async () => {
    const upstream = makeUpstream();
    await withMcpClient(upstream, async (client) => {
      await assert.rejects(() =>
        client.callTool({
          name: "create_lead",
          arguments: { name: "Jane Example", email: "jane@example.com" },
        }),
      );
    });
    assert.equal(upstream.calls.length, 0);
  });

  it("book_demo is not a CLI command and exits 2", () => {
    const res = runCli(["book_demo", "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.doesNotMatch(res.stderr, /one of: [^\n]*book_demo/);
  });

  it("create_lead is not a CLI command and exits 2", () => {
    const res = runCli(["create_lead", "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.doesNotMatch(res.stderr, /one of: [^\n]*create_lead/);
  });
});

/* ------------------------------------------------------------------ */

describe("forwarding: session handshake, reuse and passthrough", () => {
  it("opens a session lazily: initialize, notifications/initialized, then tools/call", async () => {
    const { client, calls } = stubClient();
    const result = await client.callTool(PRICING, {});
    assert.equal(result.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    const init = calls[0].body.params as Record<string, any>;
    assert.equal(init.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(init.clientInfo, { name: "capcheck", version: VERSION });
  });

  it("posts to the pinned default endpoint when no override is set", async () => {
    const { client, calls } = stubClient();
    await client.callTool(PRICING, {});
    assert.ok(calls.length > 0);
    for (const call of calls) assert.equal(call.url, DEFAULT_ENDPOINT_URL);
    assert.equal(
      DEFAULT_ENDPOINT_URL,
      "https://www.leadfriendly.com/api/mcp",
    );
  });

  it("honours the LEADFRIENDLY_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new CapcheckClient({
      fetchFn: upstream.fetchFn,
      env: { LEADFRIENDLY_MCP_URL: "https://example.invalid/custom-mcp" },
    });
    await c.callTool(PRICING, {});
    assert.ok(upstream.calls.length > 0);
    for (const call of upstream.calls) {
      assert.equal(call.url, "https://example.invalid/custom-mcp");
    }
  });

  it("an explicit deps.url wins over the env override", async () => {
    const upstream = makeUpstream();
    const c = new CapcheckClient({
      fetchFn: upstream.fetchFn,
      env: { LEADFRIENDLY_MCP_URL: "https://example.invalid/from-env" },
      url: "https://example.invalid/from-deps",
    });
    await c.callTool(PRICING, {});
    for (const call of upstream.calls) {
      assert.equal(call.url, "https://example.invalid/from-deps");
    }
  });

  it("carries the issued Mcp-Session-Id on later requests, never on initialize", async () => {
    const { client, calls } = stubClient({ sessionId: "sess-xyz" });
    await client.callTool(PRICING, {});
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("sends no session header at all when the upstream issues none", async () => {
    const { client, calls } = stubClient({ sessionId: null });
    await client.callTool(PRICING, {});
    for (const call of calls) {
      assert.equal("Mcp-Session-Id" in call.headers, false);
    }
  });

  it("reuses one session across calls: initialize happens exactly once", async () => {
    const { client, calls } = stubClient();
    await client.callTool(PRICING, {});
    await client.callTool(CAPABILITY, CAPABILITY_ARGS);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
  });

  it("forwards the tool name and arguments upstream unchanged", async () => {
    const { client, calls } = stubClient();
    await client.callTool(CAPABILITY, CAPABILITY_ARGS);
    const call = calls.find((c) => c.body.method === "tools/call");
    assert.ok(call !== undefined);
    const params = call.body.params as Record<string, unknown>;
    assert.equal(params.name, CAPABILITY);
    assert.deepEqual(params.arguments, CAPABILITY_ARGS);
  });

  it("returns the upstream result verbatim, extra fields included", async () => {
    const { client } = stubClient();
    const result = await client.callTool(PRICING, {});
    assert.deepEqual(result, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through verbatim", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "pricing source unavailable" }],
      isError: true,
    };
    const { client } = stubClient({ callResult: upstreamResult });
    const result = await client.callTool(PRICING, {});
    assert.deepEqual(result, upstreamResult);
  });

  it("understands SSE-framed upstream replies", async () => {
    const { client } = stubClient({ sse: true });
    const result = await client.callTool(PRICING, {});
    assert.deepEqual(result, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards through a fresh client", async () => {
    const upstream = makeUpstream();
    const result = await callTool(INDUSTRIES, { query: "auto" }, {
      fetchFn: upstream.fetchFn,
      env: {},
    });
    assert.deepEqual(result, SAMPLE_RESULT);
    assert.deepEqual(methods(upstream.calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("an MCP-layer tools/call forwards upstream and returns the result", async () => {
    const upstream = makeUpstream();
    const out = await withMcpClient(upstream, async (client) => {
      return client.callTool({
        name: CAPABILITY,
        arguments: CAPABILITY_ARGS,
      });
    });
    assert.deepEqual(out.content, SAMPLE_RESULT.content);
    assert.equal(upstream.calls.length, 3);
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent", () => {
  it("no request carries an Authorization header (default environment)", async () => {
    const { client, calls } = stubClient();
    await client.callTool(PRICING, {});
    await client.callTool(CAPABILITY, CAPABILITY_ARGS);
    assert.ok(calls.length > 0);
    for (const call of calls) {
      const keys = Object.keys(call.headers).map((k) => k.toLowerCase());
      assert.equal(keys.includes("authorization"), false);
      assert.equal(keys.includes("proxy-authorization"), false);
      assert.equal(keys.includes("x-api-key"), false);
    }
  });

  it("no Authorization header even when the environment carries credential-shaped values", async () => {
    const upstream = makeUpstream();
    const c = new CapcheckClient({
      fetchFn: upstream.fetchFn,
      env: {
        LEADFRIENDLY_MCP_URL: "https://example.invalid/mcp",
        LEADFRIENDLY_API_KEY: "sk-must-never-be-sent",
        AUTHORIZATION: "Bearer must-never-be-sent",
      },
    });
    await c.callTool(PRICING, {});
    assert.ok(upstream.calls.length > 0);
    for (const call of upstream.calls) {
      const keys = Object.keys(call.headers).map((k) => k.toLowerCase());
      assert.equal(keys.includes("authorization"), false);
      const values = Object.values(call.headers).join(" ");
      assert.equal(values.includes("must-never-be-sent"), false);
    }
  });

  it("the only headers sent are content negotiation plus the session id", async () => {
    const { client, calls } = stubClient();
    await client.callTool(PRICING, {});
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.match(calls[0].headers.Accept, /application\/json/);
    assert.match(calls[0].headers.Accept, /text\/event-stream/);
  });
});

/* ------------------------------------------------------------------ */

describe("failures surface as capcheck error: results", () => {
  it("an upstream JSON-RPC error on tools/call becomes a capcheck error", async () => {
    const { client } = stubClient({
      callError: { code: -32602, message: "Invalid params: query required" },
    });
    const result = await client.callTool(CAPABILITY, {});
    assert.equal(result.isError, true);
    assert.equal(
      textOf(result),
      "capcheck error: Invalid params: query required",
    );
  });

  it("a non-2xx status on tools/call becomes a capcheck error", async () => {
    const { client } = stubClient({
      callStatus: 500,
      callBodyText: "internal error",
    });
    const result = await client.callTool(PRICING, {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "capcheck error: HTTP 500");
  });

  it("an unparseable tools/call body becomes a malformed-response error", async () => {
    const { client } = stubClient({ callBodyText: "<html>oops</html>" });
    const result = await client.callTool(PRICING, {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "capcheck error: malformed response");
  });

  it("a response with no result object becomes a malformed-response error", async () => {
    const { client } = stubClient({ callBodyText: "" });
    const result = await client.callTool(PRICING, {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "capcheck error: malformed response");
  });

  it("a fetch that throws on tools/call becomes a request-failed error", async () => {
    const { client } = stubClient({ throwOn: "tools/call" });
    const result = await client.callTool(PRICING, {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "capcheck error: request failed: socket hang up");
  });

  it("an initialize JSON-RPC error fails the call before any tools/call", async () => {
    const { client, calls } = stubClient({
      initError: { code: -32000, message: "handshake refused" },
    });
    const result = await client.callTool(PRICING, {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "capcheck error: handshake refused");
    assert.deepEqual(methods(calls), ["initialize"]);
  });

  it("a fetch that throws on initialize becomes a capcheck error", async () => {
    const { client } = stubClient({ throwOn: "initialize" });
    const result = await client.callTool(PRICING, {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "capcheck error: socket hang up");
  });

  it("a hung upstream call times out into a capcheck error", async () => {
    const { client } = stubClient({ hangOnCall: true }, { timeoutMs: 50 });
    const result = await client.callTool(PRICING, {});
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^capcheck error: /);
  });

  it("a failed session does not poison the client: the next call retries", async () => {
    const upstream = makeUpstream();
    let failInit = true;
    const flaky: FetchFn = async (url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      if (failInit && body.method === "initialize") {
        failInit = false;
        throw new Error("connection reset");
      }
      return upstream.fetchFn(url, init);
    };
    const c = new CapcheckClient({ fetchFn: flaky, env: {} });
    const first = await c.callTool(PRICING, {});
    assert.equal(first.isError, true);
    const second = await c.callTool(PRICING, {});
    assert.deepEqual(second, SAMPLE_RESULT);
  });

  it("the MCP layer rejects non-object arguments with InvalidParams", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRICING, "not-an-object"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    await assert.rejects(
      () => handleCallTool(c, PRICING, [1, 2]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP layer treats undefined arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const result = await handleCallTool(c, PRICING, undefined);
    assert.deepEqual(result, SAMPLE_RESULT);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses a plain JSON body", () => {
    const msg = parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{}}', 1);
    assert.deepEqual(msg, { jsonrpc: "2.0", id: 1, result: {} });
  });

  it("picks the SSE data line whose id matches the request", () => {
    const body = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}',
      "",
      'data: {"jsonrpc":"2.0","id":2,"result":{"b":2}}',
      "",
    ].join("\n");
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { b: 2 },
    });
  });

  it("returns null for empty or unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("data: [DONE]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("CLI surface", () => {
  it("--version prints the version and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), VERSION);
    assert.equal(VERSION, "0.1.0");
  });

  it("an unknown command prints usage and exits 2", () => {
    const res = runCli(["frobnicate"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /get_pricing, list_industries, check_capability/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([PRICING, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2 (arguments must be an object)", () => {
    const res = runCli([PRICING, "[1,2]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments exit 2", () => {
    const res = runCli([PRICING, "{}", "{}"]);
    assert.equal(res.status, 2);
  });
});
