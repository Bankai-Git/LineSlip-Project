const { downloadLineImage } = require('./download-image');
const { readSlipText } = require('../ocr');
const { parseSlipInfo } = require('../slips/parse-slip-info');

/**
 * Parser input contract: { text: string, confidence: number }.
 * The surrounding result passed to onParsed also carries LINE identity and
 * image metadata so a later storage step can associate the slip with a user.
 */
async function processLineImageEvent(event, { onParsed = () => {} } = {}) {
  if (event?.type !== 'message' || event.message?.type !== 'image') return null;
  if (event.message.contentProvider?.type !== 'line') {
    throw new Error('Only images hosted by LINE are supported');
  }
  const lineUserId = event.source?.userId;
  if (!lineUserId) throw new Error('LINE event has no userId; cannot associate this slip with a user');

  const { buffer, mimeType } = await downloadLineImage(
    event.message.id,
    process.env.LINE_CHANNEL_ACCESS_TOKEN,
    Number(process.env.MAX_IMAGE_BYTES) || undefined,
  );
  const ocr = await readSlipText(buffer);
  const sourceContext = {
    source: 'line',
    lineUserId,
    messageId: event.message.id,
    webhookEventId: event.webhookEventId || null,
    receivedAt: new Date(event.timestamp || Date.now()).toISOString(),
    image: { buffer, mimeType },
    ocr,
  };

  const parserInput = { text: ocr.text, confidence: ocr.confidence };
  const parsed = parseSlipInfo(parserInput);
  const result = { ...sourceContext, ocr: parserInput, parsed };
  await onParsed(result);
  return result;
}

module.exports = { processLineImageEvent };
