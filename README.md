# discord-image-host

A small [MCP](https://modelcontextprotocol.io) server that uploads a local image
to a Discord channel through a webhook and returns the image's CDN URL — turning a
Discord channel into an ad-hoc image host an agent can post to (e.g. to avoid
committing images to a git repo).

It exposes a single tool:

| Tool | Input | Returns |
| --- | --- | --- |
| `post_image` | `{ "path": "/abs/path/to/image.png" }` | The `cdn.discordapp.com` URL of the uploaded image (plain text) |

## Two ways to run

- **Docker (recommended, always-on)** — runs as a long-lived HTTP MCP service that
  restarts automatically. Your MCP client connects over a URL.
- **Local stdio (dev)** — the MCP client spawns the process per session over stdio.
  Simplest for development; sees all your local files natively.

The transport is chosen by `MCP_TRANSPORT` (`stdio` default, `http` for the container).

## Prerequisites

- A Discord webhook URL — Discord: **Server Settings → Integrations → Webhooks →
  New Webhook**, pick the channel, **Copy Webhook URL**
  (`https://discord.com/api/webhooks/<id>/<token>`).
- For Docker: Docker + Docker Compose. For local: Node.js >= 22.

## Docker quickstart

```bash
cp .env.example .env       # then edit it (see below)
docker compose up -d --build
docker compose ps          # should show "healthy"
```

`.env` (gitignored — never committed):

```ini
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
HOST_FILES_DIR=/home/youruser/coding
```

- `DISCORD_WEBHOOK_URL` — the channel the server posts to.
- `HOST_FILES_DIR` — a host directory bind-mounted **read-only** into the container
  at the **same path**, so `post_image` can read your files. See the constraint below.

The compose service publishes the endpoint to **`127.0.0.1:3939` only** (not your
LAN), runs as a non-root user, and uses `restart: unless-stopped` so it comes back
after a crash and when the Docker daemon starts. To have it survive reboots, ensure
Docker itself starts on boot (`sudo systemctl enable docker`).

### File visibility (important)

The container has its own filesystem. It can only read files under the mounted
`HOST_FILES_DIR`, and because its working directory differs from yours, **you must
pass absolute paths** to `post_image`. Put the images you want to host under
`HOST_FILES_DIR` (default `~/coding`), or broaden/add mounts in `docker-compose.yml`
(e.g. add `/tmp` for transient screenshots). The mount is read-only — the server
only ever reads.

## Connecting an MCP client

**To the container (HTTP):**

```json
{
  "mcpServers": {
    "discord-image-host": { "type": "http", "url": "http://127.0.0.1:3939/mcp" }
  }
}
```

**Local (stdio):** build first (`npm install && npm run build`), then:

```json
{
  "mcpServers": {
    "discord-image-host": {
      "command": "node",
      "args": ["/absolute/path/to/discordImageHost/dist/index.js"],
      "env": { "DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/<id>/<token>" }
    }
  }
}
```

After connecting, the `post_image` tool is available; call it with a file path and
it returns the CDN URL.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | _(required)_ | Webhook the server posts to |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3939` | HTTP listen port (http mode) |
| `HOST` | `0.0.0.0` | HTTP bind address (http mode) |

## How it works

`POST`s the file as `multipart/form-data` to the webhook with `?wait=true`, which
makes Discord respond with the created message (including the attachment URL)
instead of an empty `204`. The first attachment's `url` is returned. In HTTP mode it
serves a stateless [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
MCP endpoint at `/mcp` and a `/health` probe.

## Caveat: Discord CDN links expire

Discord signs attachment URLs with expiring `ex`/`is`/`hm` query parameters
(currently ~24h). The link works immediately and renders inside Discord
indefinitely, but a bare copied link used for long-term **external** hotlinking will
eventually return 404 — Discord platform behavior; the tool returns exactly what
Discord provides.

## Development

```bash
npm install
npm run build      # compile to dist/
npm run dev        # run from source via tsx (stdio)
npm test           # integration tests against a local fake Discord endpoint
```
