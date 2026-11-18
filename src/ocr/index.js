const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const providers = {
  typhoon: require('./providers/typhoon'),
  tesseract: require('./providers/tesseract'),
};

function getProvider(providerName = process.env.OCR_PROVIDER || 'typhoon') {
  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Unknown OCR_PROVIDER "${providerName}". Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

async function preprocessSlipImage(input) {
  const image = sharp(input);
  const metadata = await image.metadata();
  const resizeOptions = metadata.width && metadata.width < 1500
    ? { width: 1500 }
    : {};

  return image
    .rotate()
    .resize(resizeOptions)
    .grayscale()
    .normalize()
    .linear(1.3, -20)
    .sharpen()
    .threshold(160)
    .png()
    .toBuffer();
}

async function prepareTyphoonImage(input) {
  const image = sharp(input).rotate();
  const metadata = await image.metadata();
  const longestSide = Math.max(metadata.width || 0, metadata.height || 0);
  return image
    .resize({ width: longestSide > 1800 ? undefined : 1800, height: longestSide > 1800 ? 1800 : undefined, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function readSlipText(input, options = {}) {
  if (typeof input === 'string') {
    await fs.access(path.resolve(input));
  } else if (!Buffer.isBuffer(input)) {
    throw new TypeError('OCR input must be a file path or Buffer');
  }

  const { preprocess = true, onProgress, provider: requestedProvider } = options;
  const providerName = requestedProvider || process.env.OCR_PROVIDER || 'typhoon';
  const image = providerName === 'typhoon'
    ? await prepareTyphoonImage(input)
    : preprocess ? await preprocessSlipImage(input) : input;
  return getProvider(providerName).recognize(image, { onProgress });
}

module.exports = { readSlipText, preprocessSlipImage };
