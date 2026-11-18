const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function downloadLineImage(messageId, accessToken, maxBytes = DEFAULT_MAX_IMAGE_BYTES) {
  if (!/^[A-Za-z0-9_-]+$/.test(messageId || '')) {
    throw new TypeError('Invalid LINE message ID');
  }
  if (!accessToken) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is required to download message images');
  }

  const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`LINE image download failed with HTTP ${response.status}`);
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`LINE message content is not an image (${contentType || 'unknown content type'})`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`LINE image exceeds the ${maxBytes}-byte limit`);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      await response.body.cancel();
      throw new Error(`LINE image exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(Buffer.from(chunk));
  }

  if (totalBytes === 0) throw new Error('LINE returned an empty image');
  return { buffer: Buffer.concat(chunks), mimeType: contentType };
}

module.exports = { downloadLineImage };
