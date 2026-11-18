const cron = require('node-cron');

const TRANSACTION_NAMES = {
  transfer: 'โอนเงิน',
  bill_payment: 'จ่ายบิล',
  receive: 'รับเงิน',
  other: 'อื่น ๆ',
};

function localDateInTimezone(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function startSummaryScheduler({ slips, summaryService, messenger }) {
  const expression = process.env.SUMMARY_CRON || '0 21 * * *';
  const timeZone = process.env.SUMMARY_TIMEZONE || 'Asia/Bangkok';
  const dashboardUrl = process.env.DASHBOARD_PUBLIC_URL;
  if (dashboardUrl && new URL(dashboardUrl).protocol !== 'https:') {
    throw new Error('DASHBOARD_PUBLIC_URL must use HTTPS');
  }

  const task = cron.schedule(expression, async () => {
    const date = localDateInTimezone(timeZone);
    let userIds;
    try {
      userIds = await slips.listUsersWithConfirmedSlips(date);
    } catch (error) {
      console.error('Could not find LINE users for daily summary:', error.message);
      return;
    }

    for (const lineUserId of userIds) {
      try {
        const summary = await summaryService.buildDailySummary({ lineUserId, date });
        const lines = [
          `สรุปธุรกรรมที่ยืนยันแล้ว ${date}`,
          `ยอดธุรกรรมรวม ${summary.totalAmount} บาท · ${summary.transactionCount} รายการ`,
          ...summary.transactionTypes.map((row) => `• ${TRANSACTION_NAMES[row.transaction_type] || TRANSACTION_NAMES.other}: ${row.total_amount} บาท (${row.transaction_count} รายการ)`),
          summary.narrative,
        ];
        if (dashboardUrl) lines.push(`Dashboard: ${dashboardUrl}`);
        await messenger.sendPushMessage(lineUserId, { type: 'text', text: lines.join('\n') });
      } catch (error) {
        console.error('Could not send scheduled summary to one LINE user:', error.message);
      }
    }
  }, { timezone: timeZone, noOverlap: true });

  console.log(`Daily summary scheduled with "${expression}" in ${timeZone}`);
  return task;
}

module.exports = { startSummaryScheduler, localDateInTimezone };
