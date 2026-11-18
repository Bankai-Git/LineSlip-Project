const { getPeriodRange, periodLabel } = require('./period');

function fallbackSummary(dailySummary) {
  if (dailySummary.transactionCount === 0) return 'ช่วงเวลานี้ยังไม่มีธุรกรรมที่ยืนยันแล้ว';
  return `ช่วงเวลานี้มีธุรกรรมที่ยืนยันแล้ว ${dailySummary.transactionCount} รายการ ยอดรวมแสดงตาม SQL`;
}

function createSummaryService({ slips, summarizer }) {
  const narrativeCache = new Map();

  async function buildPeriodSummary({ lineUserId, period = 'day', date }) {
    const range = getPeriodRange(period, date);
    const daily = await slips.getPeriodSummary({ lineUserId, ...range });
    daily.period = period;
    daily.periodLabel = periodLabel(range);
    daily.date = date;
    let narrative = fallbackSummary(daily);

    if (daily.transactions.length > 0) {
      const cacheKey = `${lineUserId}:${period}:${range.startDate}:${range.endDate}`;
      const fingerprint = JSON.stringify(daily.transactions.map(({ id, transaction_type }) => [id, transaction_type]));
      const cached = narrativeCache.get(cacheKey);
      if (cached && cached.fingerprint === fingerprint && Date.now() - cached.createdAt < 10 * 60 * 1000) {
        narrative = cached.narrative;
      } else {
        try {
          const ai = await summarizer.summarize(daily);
          narrative = ai.summary || narrative;
          narrativeCache.set(cacheKey, { fingerprint, narrative, createdAt: Date.now() });
          if (narrativeCache.size > 256) narrativeCache.delete(narrativeCache.keys().next().value);
        } catch (error) {
          console.error('Local AI summary failed; keeping SQL totals:', error.message);
        }
      }
    }

    return { ...daily, narrative };
  }

  async function buildDailySummary({ lineUserId, date }) {
    return buildPeriodSummary({ lineUserId, period: 'day', date });
  }

  return { buildDailySummary, buildPeriodSummary };
}

module.exports = { createSummaryService };
