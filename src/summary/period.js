function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function getPeriodRange(period, anchorDate) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(anchorDate) ? new Date(`${anchorDate}T00:00:00.000Z`) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== anchorDate) throw new TypeError('A valid YYYY-MM-DD anchor date is required');
  const [year, month] = anchorDate.split('-').map(Number);
  if (period === 'day') return { period, startDate: anchorDate, endDate: shiftDate(anchorDate, 1) };
  if (period === 'week') {
    const startDate = shiftDate(anchorDate, -((parsed.getUTCDay() + 6) % 7));
    return { period, startDate, endDate: shiftDate(startDate, 7) };
  }
  if (period === 'month') return { period, startDate: `${year}-${String(month).padStart(2, '0')}-01`, endDate: month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01` };
  if (period === 'year') return { period, startDate: `${year}-01-01`, endDate: `${year + 1}-01-01` };
  throw new TypeError('period must be day, week, month, or year');
}

function periodLabel({ period, startDate, endDate }) {
  if (period === 'day') return startDate;
  if (period === 'week') return `${startDate} – ${shiftDate(endDate, -1)}`;
  if (period === 'month') return startDate.slice(0, 7);
  return startDate.slice(0, 4);
}

module.exports = { getPeriodRange, periodLabel };
