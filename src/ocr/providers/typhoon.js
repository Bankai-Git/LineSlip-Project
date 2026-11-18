const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const OCR_PROMPT = `Extract all text from the image.

Instructions:
- Only return the clean Markdown.
- Do not include any explanation or extra text.
- You must include all information on the page.

Formatting Rules:
- Tables: Render tables using <table>...</table> in clean HTML format.
- Equations: Render equations using LaTeX syntax with inline ($...$) and block ($$...$$).
- Images/Charts/Diagrams: Wrap any clearly defined visual areas (e.g. charts, diagrams, pictures) in:

<figure>
Describe the image's main elements (people, objects, text), note any contextual clues (place, event, culture), mention visible text and its meaning, provide deeper analysis when relevant (especially for financial charts, graphs, or documents), comment on style or architecture if relevant, then give a concise overall summary. Describe in Thai.
</figure>
- Page Numbers: Wrap page numbers in <page_number>...</page_number> (e.g., <page_number>14</page_number>).
- Checkboxes: Use ☐ for unchecked and ☑ for checked boxes.`;

function extractText(content) {
  const text = Array.isArray(content)
    ? content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n')
    : content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Typhoon OCR returned an empty response');
  }

  // Typhoon OCR may wrap extracted Markdown in a JSON object.
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.natural_text === 'string') return parsed.natural_text.trim();
    if (typeof parsed.text === 'string') return parsed.text.trim();
  } catch {
    // Plain Markdown/text is also a valid OCR response.
  }
  return text.trim();
}

async function recognize(image, { onProgress } = {}) {
  const baseUrl = (process.env.TYPHOON_OCR_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = process.env.TYPHOON_OCR_MODEL || 'scb10x/typhoon-ocr1.5-3b:latest';
  const timeoutMs = Number(process.env.TYPHOON_OCR_TIMEOUT_MS) || 180000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    onProgress?.(0);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        // Ollama's OpenAI-compatible endpoint ignores the key but expects a
        // bearer token header in some compatible clients.
        Authorization: `Bearer ${process.env.TYPHOON_OCR_API_KEY || 'ollama'}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } },
            { type: 'text', text: OCR_PROMPT },
          ],
        }],
        max_tokens: Number(process.env.TYPHOON_OCR_MAX_TOKENS) || 10000,
        temperature: 0.1,
        top_p: 0.6,
        repetition_penalty: 1.05,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message || `HTTP ${response.status}`;
      throw new Error(`Typhoon OCR request failed: ${message}`);
    }
    const text = extractText(payload?.choices?.[0]?.message?.content);
    onProgress?.(1);
    return { text, confidence: null };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Typhoon OCR request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { recognize };
