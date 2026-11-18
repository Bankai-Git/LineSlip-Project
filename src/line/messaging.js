const { messagingApi } = require('@line/bot-sdk');

function createLineMessenger(channelAccessToken) {
  if (!channelAccessToken || channelAccessToken.startsWith('replace-with-')) {
    throw new Error('Set LINE_CHANNEL_ACCESS_TOKEN in .env before starting the LINE workflow');
  }
  const client = new messagingApi.MessagingApiClient({ channelAccessToken });

  async function sendEventMessage(event, message) {
    if (event.replyToken) {
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [message] });
        return;
      } catch (error) {
        console.warn('LINE reply failed; attempting a push message', error.status || error.message);
      }
    }

    const target = event.source?.groupId || event.source?.roomId || event.source?.userId;
    if (!target) throw new Error('LINE event has no destination for a reply');
    await client.pushMessage({ to: target, messages: [message] });
  }

  async function sendPushMessage(lineUserId, message) {
    await client.pushMessage({ to: lineUserId, messages: [message] });
  }

  return { sendEventMessage, sendPushMessage };
}

function textMessage(text, quickReply) {
  return {
    type: 'text',
    text,
    ...(quickReply ? { quickReply } : {}),
  };
}

function slipConfirmationMessage(slip, note) {
  const date = String(slip.transaction_date).slice(0, 10);
  const transactionNames = { transfer: 'โอนเงิน', bill_payment: 'จ่ายบิล', receive: 'รับเงิน', other: 'ธุรกรรมอื่น' };
  const lines = [
    note || 'อ่านข้อมูลสลิปได้แล้ว กรุณาตรวจสอบก่อนยืนยัน',
    `รายการ: ${transactionNames[slip.transaction_type] || transactionNames.other}`,
    `ยอดเงิน: ${slip.amount} บาท`,
    `วันที่: ${date}`,
    `เวลา: ${slip.transaction_time || 'ไม่พบ'}`,
    `รหัสอ้างอิง: ${slip.reference_no}`,
  ];
  const senderName = [slip.sender_prefix, slip.sender_first_name, slip.sender_last_name].filter(Boolean).join(' ');
  const recipientName = [slip.recipient_prefix, slip.recipient_first_name, slip.recipient_last_name].filter(Boolean).join(' ');
  if (senderName) lines.splice(2, 0, `ผู้โอน: ${senderName}`);
  if (slip.transaction_type === 'bill_payment' && slip.recipient_company_name) lines.splice(2, 0, `บริษัทผู้รับ: ${slip.recipient_company_name}`);
  else if (recipientName) lines.splice(2, 0, `ผู้รับ: ${recipientName}`);
  if (slip.sender_bank_name) lines.push(`ธนาคารผู้โอน: ${slip.sender_bank_name}`);
  if (slip.recipient_bank_name) lines.push(`ธนาคารผู้รับ: ${slip.recipient_bank_name}`);
  if (slip.ocr_confidence != null) lines.push(`ความมั่นใจ OCR: ${Number(slip.ocr_confidence).toFixed(0)}%`);

  return textMessage(lines.join('\n'), {
    items: [
      {
        type: 'action',
        action: {
          type: 'postback',
          label: 'ยืนยัน',
          data: `slip_action=confirm&slip_id=${encodeURIComponent(slip.id)}`,
          displayText: 'ยืนยันรายการนี้',
        },
      },
      {
        type: 'action',
        action: {
          type: 'postback',
          label: 'แก้ไข',
          data: `slip_action=edit&slip_id=${encodeURIComponent(slip.id)}`,
          displayText: 'แก้ไขข้อมูลสลิป',
        },
      },
    ],
  });
}

function transactionSummaryFlex(summary) {
  const labels = { transfer: 'ยอดโอน', bill_payment: 'จ่ายบิล', receive: 'ยอดรับ', other: 'อื่น ๆ' };
  const colors = { transfer: '#5865d8', bill_payment: '#f2a93b', receive: '#29a36a', other: '#87909c' };
  const rows = summary.transactionTypes || [];
  const max = Math.max(1, ...rows.map((row) => Number(row.total_amount)));
  const components = rows.map((row) => ({
    type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md',
    contents: [
      { type: 'box', layout: 'horizontal', contents: [
        { type: 'text', text: labels[row.transaction_type] || labels.other, size: 'sm', flex: 1 },
        { type: 'text', text: `${row.total_amount} บาท · ${row.transaction_count} รายการ`, size: 'sm', align: 'end', flex: 2, wrap: true },
      ] },
      { type: 'box', layout: 'vertical', height: '8px', backgroundColor: '#eceef2', cornerRadius: '4px', contents: [
        { type: 'box', layout: 'vertical', width: `${Math.max(3, Number(row.total_amount) / max * 100)}%`, height: '8px', backgroundColor: colors[row.transaction_type] || colors.other, cornerRadius: '4px', contents: [] },
      ] },
    ],
  }));
  return {
    type: 'flex', altText: `สรุปธุรกรรม ${summary.periodLabel}: ${summary.totalAmount} บาท`,
    contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: `สรุปธุรกรรม ${summary.periodLabel}`, weight: 'bold', size: 'lg', wrap: true },
      { type: 'text', text: `ยอดรวม ${summary.totalAmount} บาท · ${summary.transactionCount} รายการ`, weight: 'bold', size: 'md', color: '#34347f', wrap: true },
      { type: 'separator', margin: 'md' },
      ...(components.length ? components : [{ type: 'text', text: 'ไม่มีธุรกรรมที่ยืนยันแล้วในช่วงนี้', size: 'sm', color: '#777777', margin: 'md' }]),
    ] } },
  };
}

module.exports = { createLineMessenger, textMessage, slipConfirmationMessage, transactionSummaryFlex };
