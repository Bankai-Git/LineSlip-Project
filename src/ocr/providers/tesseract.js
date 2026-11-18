const path = require('node:path');
const { createWorker } = require('tesseract.js');

const languageDataPath = path.resolve(__dirname, '../../../');

async function recognize(image, { onProgress } = {}) {
  const worker = await createWorker('tha+eng', 1, {
    langPath: languageDataPath,
    gzip: false,
    logger: (message) => {
      if (onProgress && message.status === 'recognizing text') {
        onProgress(message.progress);
      }
    },
  });

  try {
    const { data: { text, confidence } } = await worker.recognize(image);
    return { text: text.trim(), confidence };
  } finally {
    await worker.terminate();
  }
}

module.exports = { recognize };
