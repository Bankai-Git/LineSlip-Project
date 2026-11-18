const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SLIP_DIR = path.resolve(__dirname, '../../slip');

async function saveSlipImage(image) {
  if (!image?.buffer || !Buffer.isBuffer(image.buffer)) throw new TypeError('Slip image buffer is required');
  const extension = image.mimeType === 'image/png' ? '.png' : image.mimeType === 'image/webp' ? '.webp' : '.jpg';
  const filename = `${randomUUID()}${extension}`;
  await fs.mkdir(SLIP_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(SLIP_DIR, filename), image.buffer, { flag: 'wx', mode: 0o600 });
  return { path: filename, mimeType: image.mimeType || 'image/jpeg' };
}

async function deleteSlipImage(filename) {
  if (!filename || path.basename(filename) !== filename) return;
  await fs.unlink(path.join(SLIP_DIR, filename)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

module.exports = { SLIP_DIR, saveSlipImage, deleteSlipImage };
