const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
  additionalProperties: false,
};

function createQwenSummarizer({
  baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model = process.env.LOCAL_AI_MODEL || 'qwen3.5:9b',
  timeoutMs = Number(process.env.LOCAL_AI_TIMEOUT_MS) || 60_000,
} = {}) {
  return {
    async summarize(dailySummary) {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          stream: false,
          format: RESPONSE_SCHEMA,
          options: { temperature: 0.1 },
          messages: [
            {
              role: 'system',
              content: 'คุณช่วยเขียนสรุปธุรกรรมสั้น ๆ เป็นภาษาไทย โดยแยกความหมายของรายการโอนเงิน จ่ายบิล และรับเงินตาม transaction_type ห้ามคำนวณหรือแต่งยอดเงิน และห้ามทวนชื่อผู้รับ ชื่อผู้โอน เลขบัญชี หรือข้อมูลระบุตัวบุคคลในบทสรุป',
            },
            {
              role: 'user',
              content: JSON.stringify({
                date: dailySummary.date,
                period: dailySummary.periodLabel || dailySummary.date,
                startDate: dailySummary.startDate,
                endDateExclusive: dailySummary.endDate,
                transactions: dailySummary.transactions.map((transaction) => ({
                  id: transaction.id,
                  type: transaction.transaction_type,
                })),
              }),
            },
          ],
        }),
      });

      if (!response.ok) throw new Error(`Local AI returned HTTP ${response.status}`);
      const payload = await response.json();
      const content = payload.message?.content;
      if (typeof content !== 'string') throw new Error('Local AI returned no message content');
      const result = JSON.parse(content);
      if (typeof result.summary !== 'string') {
        throw new Error('Local AI response did not match the expected shape');
      }
      return {
        summary: result.summary.trim().slice(0, 1000),
      };
    },
  };
}

module.exports = { createQwenSummarizer };
