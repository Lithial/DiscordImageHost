#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { postImageToWebhook } from "./discord.js";

// The webhook to post to. Kept out of the code/repo: supplied via env. Read once
// at startup; bail early with a clear message if it's absent.
const webhookFromEnv = process.env.DISCORD_WEBHOOK_URL;
if (!webhookFromEnv) {
  console.error(
    "discord-image-host: DISCORD_WEBHOOK_URL is not set. Point it at the Discord " +
      "webhook URL this server should post images to, then restart.",
  );
  process.exit(1);
}
// Bind as a plain string so closures (HTTP handler, main) capture it without narrowing.
const WEBHOOK_URL: string = webhookFromEnv;

/** Build a fresh MCP server instance with the post_image tool registered. */
function buildServer(webhookUrl: string): McpServer {
  const server = new McpServer({ name: "discord-image-host", version: "1.0.0" });
  server.registerTool(
    "post_image",
    {
      title: "Post image to Discord",
      description:
        "Upload a local image file to the configured Discord channel and return its public CDN URL. " +
        "Pass a path to an image file the server can read (use an absolute path when the server runs " +
        "in a container, since its working directory differs from yours).",
      inputSchema: {
        path: z
          .string()
          .min(1, "path must not be empty")
          .describe("Path to a local image file to upload, e.g. /home/me/screenshot.png"),
      },
    },
    async ({ path }) => {
      try {
        const url = await postImageToWebhook(webhookUrl, path);
        return { content: [{ type: "text", text: url }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Upload failed: ${message}` }], isError: true };
      }
    },
  );
  return server;
}

/** Read and JSON-parse an HTTP request body; an empty body yields undefined. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

/** Handle one HTTP request: a health probe, then the stateless MCP endpoint. */
async function handleHttp(req: IncomingMessage, res: ServerResponse, webhookUrl: string): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Concise access log for non-health requests (the /health probe runs often).
  console.error(`[http] ${req.method ?? "?"} ${pathname}`);
  if (pathname !== "/mcp" && pathname !== "/mcp/") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST for the MCP endpoint." } }));
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON body." } }));
    return;
  }

  // Defensive interop: the transport rejects a request whose Accept lacks both
  // application/json and text/event-stream (406), or whose Content-Type lacks
  // application/json (415), before we ever see it. Append spec-complete values so
  // lenient clients still work. (omp sends compliant headers; this guards others.)
  // The Node->web Request conversion reads rawHeaders and merges duplicate header
  // names, so appending works here; mutating req.headers does not.
  req.rawHeaders.push("Accept", "application/json, text/event-stream");
  req.rawHeaders.push("Content-Type", "application/json");

  // Stateless Streamable HTTP: a fresh server + transport per request.
  // enableJsonResponse returns a plain JSON body (broadly compatible) instead of SSE.
  const server = buildServer(webhookUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function main(): Promise<void> {
  const mode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  if (mode === "http") {
    const port = Number(process.env.PORT ?? 3939);
    const host = process.env.HOST ?? "0.0.0.0";
    const http = createHttpServer((req, res) => {
      handleHttp(req, res, WEBHOOK_URL).catch((err) => {
        console.error("discord-image-host: unhandled HTTP error:", err);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => http.listen(port, host, resolve));
    console.error(`discord-image-host: HTTP MCP server listening on http://${host}:${port}/mcp`);
  } else {
    await buildServer(WEBHOOK_URL).connect(new StdioServerTransport());
  }
}

main().catch((err) => {
  console.error("discord-image-host: fatal error:", err);
  process.exit(1);
});
