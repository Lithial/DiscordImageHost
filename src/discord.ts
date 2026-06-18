import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

/**
 * Minimal shape of the message object Discord returns when a webhook is
 * posted with `?wait=true`. We only care about the attachment URL.
 */
interface DiscordMessageResponse {
  attachments?: Array<{ url?: string }>;
}

/** Content-Type by file extension, so Discord renders the upload inline as an image. */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".ico": "image/x-icon",
};

/**
 * Upload a local image file to a Discord webhook and return its CDN URL.
 *
 * @param webhookUrl The full Discord webhook URL to post to.
 * @param filePath   Path to a local image file.
 * @returns The `cdn.discordapp.com` URL of the uploaded attachment.
 * @throws If the file cannot be read, the request fails, Discord returns a
 *         non-2xx status, or the response carries no attachment URL.
 */
export async function postImageToWebhook(webhookUrl: string, filePath: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read image file at "${filePath}": ${reason}`);
  }

  const filename = basename(filePath);
  const mime = MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
  const form = new FormData();
  form.append("files[0]", new Blob([bytes], { type: mime }), filename);

  // `?wait=true` makes Discord reply with the created message JSON (carrying the
  // attachment URL); without it the webhook returns 204 No Content and no URL.
  const target = new URL(webhookUrl);
  target.searchParams.set("wait", "true");

  let response: Response;
  try {
    response = await fetch(target, { method: "POST", body: form });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reach the Discord webhook: ${reason}`);
  }

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Discord webhook returned ${response.status} ${response.statusText}: ${rawBody || "(empty body)"}`,
    );
  }

  let message: DiscordMessageResponse;
  try {
    message = JSON.parse(rawBody) as DiscordMessageResponse;
  } catch {
    throw new Error(
      `Discord webhook returned a non-JSON response (is "wait=true" being stripped?): ${rawBody}`,
    );
  }

  const url = message.attachments?.[0]?.url;
  if (!url) {
    throw new Error(`Discord accepted the upload but returned no attachment URL. Response: ${rawBody}`);
  }
  return url;
}
