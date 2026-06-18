import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postImageToWebhook } from "../src/discord.ts";

// A 1x1 transparent PNG — enough to exercise a real multipart upload.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/AP4AAAAAElFTkSuQmCC",
  "base64",
);

interface CapturedRequest {
  query: URLSearchParams;
  contentType: string;
  body: string;
}

interface FakeDiscord {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/** Start a throwaway HTTP server that stands in for Discord's webhook endpoint. */
async function startFakeDiscord(
  reply: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<FakeDiscord> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({
        query: url.searchParams,
        contentType: req.headers["content-type"] ?? "",
        // latin1 keeps the binary PNG bytes intact while leaving the ASCII
        // multipart headers (name=, filename=, Content-Type) matchable.
        body: Buffer.concat(chunks).toString("latin1"),
      });
      reply(req, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake discord: no port");
  return {
    url: `http://127.0.0.1:${address.port}/api/webhooks/123/abc`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Write the sample PNG to a temp file, run the body, then clean up. */
async function withTempImage(name: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dih-test-"));
  const path = join(dir, name);
  await writeFile(path, PNG_1x1);
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("uploads an image and returns the attachment URL", async () => {
  const cdnUrl =
    "https://cdn.discordapp.com/attachments/123/456/pic.png?ex=abc&is=def&hm=ghi";
  const discord = await startFakeDiscord((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "789", attachments: [{ id: "456", url: cdnUrl }] }));
  });
  try {
    await withTempImage("pic.png", async (path) => {
      assert.equal(await postImageToWebhook(discord.url, path), cdnUrl);
    });

    assert.equal(discord.requests.length, 1);
    const sent = discord.requests[0];
    assert.equal(sent.query.get("wait"), "true", "must force wait=true to receive the URL");
    assert.match(sent.contentType, /^multipart\/form-data/);
    assert.match(sent.body, /name="files\[0\]"/);
    assert.match(sent.body, /filename="pic\.png"/);
    assert.match(sent.body, /Content-Type: image\/png/, "MIME should be inferred from .png");
  } finally {
    await discord.close();
  }
});

test("throws with status and body when Discord rejects the upload", async () => {
  const discord = await startFakeDiscord((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Invalid Webhook Token", code: 50027 }));
  });
  try {
    await withTempImage("pic.png", async (path) => {
      await assert.rejects(
        () => postImageToWebhook(discord.url, path),
        /Discord webhook returned 401.*Invalid Webhook Token/,
      );
    });
  } finally {
    await discord.close();
  }
});

test("throws when Discord accepts the upload but returns no attachment", async () => {
  const discord = await startFakeDiscord((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "789", attachments: [] }));
  });
  try {
    await withTempImage("pic.png", async (path) => {
      await assert.rejects(() => postImageToWebhook(discord.url, path), /no attachment URL/);
    });
  } finally {
    await discord.close();
  }
});

test("throws a clear error when the file cannot be read", async () => {
  await assert.rejects(
    () => postImageToWebhook("http://127.0.0.1:1/unused", "/no/such/file-xyz.png"),
    /Could not read image file/,
  );
});
