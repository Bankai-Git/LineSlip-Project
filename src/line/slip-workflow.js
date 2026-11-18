const { processLineImageEvent } = require('./process-image-event');
const { normalizePendingSlip } = require('../db/normalize-pending-slip');
const { textMessage, slipConfirmationMessage, transactionSummaryFlex } = require('./messaging');
const { localDateInTimezone } = require('../summary/scheduler');
const { saveSlipImage, deleteSlipImage } = require('../slips/image-store');

const EDIT_PROMPT = [
  'ส่งข้อมูลที่แก้ไขภายใน 15 นาที โดยพิมพ์หนึ่งรายการต่อบรรทัด:',
  'ยอดเงิน: 60.00',
  'วันที่: 22 ก.ค.2569',
  'เวลา: 12:00 (ถ้าไม่มีใส่ -)',
  'รายการ: โอนเงิน | จ่ายบิล | รับเงิน | อื่น ๆ',
  'บริษัทผู้รับ: ร้านตัวอย่าง (ใช้กับจ่ายบิล ถ้าไม่มีใส่ -)',
  'คำนำหน้าผู้รับ: นาย (ใช้กับโอน/รับเท่านั้น; ถ้าไม่มีใส่ -)',
  'ชื่อผู้รับ: สมชาย (ใช้กับโอน/รับเท่านั้น)',
  'นามสกุลผู้รับ: ใจดี (ใช้กับโอน/รับเท่านั้น; ถ้าถูกปิดใส่ -)',
  'คำนำหน้าผู้โอน: นาย (ถ้าไม่มีใส่ -)',
  'ชื่อผู้โอน: ธนาวุฒิ (ถ้าไม่มีใส่ -)',
  'นามสกุลผู้โอน: ทองดี (ถ้าถูกปิดหรืออ่านไม่ครบใส่ -)',
  'รหัสอ้างอิง: 620312577520|00000989790',
].join('\n');

function hasTransactionMarker(text) {
  return /รายการโอนเงิน|หลักฐานการโอน|สลิป|โอนเงิน.{0,30}(?:สำเร็จ|สําเร็จ|เรียบร้อย)|transfer.{0,30}(?:successful|complete|receipt)|payment.{0,30}(?:successful|receipt)|bill\s*payment|receipt|ชำระบิล|จ่ายบิล|(?:เงินเข้า|รับโอน|ได้รับเงิน|รับเงิน|รายการรับเงิน)|money\s+received|incoming\s+transfer/i.test(text);
}

function getSlipDecision(result) {
  const rawText = result.ocr?.text?.trim() || '';
  if (rawText.length < 5) return { status: 'unreadable' };
  if (!hasTransactionMarker(rawText)) return { status: 'not_slip' };

  const missing = [];
  if (!result.parsed.amount) missing.push('ยอดเงิน');
  if (!result.parsed.date) missing.push('วันที่');
  if (!result.parsed.refNo) missing.push('รหัสอ้างอิง');
  if (missing.length) return { status: 'incomplete', missing };

  try {
    normalizePendingSlip(result);
  } catch {
    return { status: 'incomplete', missing: ['ยอดเงินหรือวันที่ที่อ่านได้ไม่ถูกต้อง'] };
  }
  return { status: 'ready' };
}

function parseEditMessage(text) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(ยอด(?:เงิน)?|วันที่|เวลา|รายการ|บริษัทผู้รับ|ผู้รับ|คำนำหน้าผู้รับ|ชื่อผู้รับ|นามสกุลผู้รับ|คำนำหน้าผู้โอน|ชื่อผู้โอน|นามสกุลผู้โอน|รหัสอ้างอิง|เลขอ้างอิง)\s*[:=]\s*(.+)$/i);
    if (match) fields.set(match[1].replace(/\s/g, '').toLowerCase(), match[2].trim());
  }
  const get = (...keys) => keys.map((key) => fields.get(key)).find(Boolean);
  const amount = get('ยอดเงิน', 'ยอด');
  const date = get('วันที่');
  const referenceNo = get('รหัสอ้างอิง', 'เลขอ้างอิง');
  const time = get('เวลา');
  const recipientName = get('ผู้รับ');
  if (!amount || !date || !referenceNo) return null;
  const edit = { amount, date, time: !time || time === '-' ? null : time, referenceNo };
  if (recipientName) {
    edit.recipientFirstName = recipientName;
    edit.recipientLastName = '-';
  }
  if (fields.has('บริษัทผู้รับ')) edit.recipientCompanyName = get('บริษัทผู้รับ');
  const typeNames = new Map([
    ['โอนเงิน', 'transfer'], ['transfer', 'transfer'],
    ['จ่ายบิล', 'bill_payment'], ['ชำระบิล', 'bill_payment'], ['bill_payment', 'bill_payment'],
    ['รับเงิน', 'receive'], ['receive', 'receive'],
    ['อื่น', 'other'], ['อื่นๆ', 'other'], ['อื่น ๆ', 'other'], ['other', 'other'],
  ]);
  if (fields.has('รายการ')) edit.transactionType = typeNames.get(get('รายการ').toLowerCase()) || get('รายการ');
  if (fields.has('คำนำหน้าผู้โอน')) edit.senderPrefix = get('คำนำหน้าผู้โอน');
  if (fields.has('ชื่อผู้โอน')) edit.senderFirstName = get('ชื่อผู้โอน');
  if (fields.has('นามสกุลผู้โอน')) edit.senderLastName = get('นามสกุลผู้โอน');
  if (fields.has('คำนำหน้าผู้รับ')) edit.recipientPrefix = get('คำนำหน้าผู้รับ');
  if (fields.has('ชื่อผู้รับ')) edit.recipientFirstName = get('ชื่อผู้รับ');
  if (fields.has('นามสกุลผู้รับ')) edit.recipientLastName = get('นามสกุลผู้รับ');
  return edit;
}

function createSlipWorkflow({ slips, messenger, summaryService }) {
  async function reply(event, message) {
    try {
      await messenger.sendEventMessage(event, message);
    } catch (error) {
      console.error('Could not send LINE response:', error.message);
    }
  }

  async function handleImage(event) {
    try {
      await processLineImageEvent(event, {
        onParsed: async (result) => {
          const decision = getSlipDecision(result);
          if (decision.status === 'unreadable') {
            await reply(event, textMessage('อ่านภาพนี้ไม่สำเร็จ กรุณาส่งภาพสลิปที่ชัดเจนอีกครั้ง'));
            return;
          }
          if (decision.status === 'not_slip') {
            await reply(event, textMessage('ภาพนี้ยังตรวจไม่พบว่าเป็นหลักฐานธุรกรรม กรุณาส่งภาพรายการชำระเงินหรือรับเงินโดยตรง'));
            return;
          }
          if (decision.status === 'incomplete') {
            await reply(event, textMessage(`อ่านข้อมูลสลิปได้ไม่ครบ (${decision.missing.join(', ')}) กรุณาส่งภาพที่ชัดเจนอีกครั้ง`));
            return;
          }

          try {
            const imageFile = await saveSlipImage(result.image);
            result.image = imageFile;
            const saved = await slips.createPendingSlip(result);
            if (saved.status === 'created') {
              await reply(event, slipConfirmationMessage(saved.slip));
            } else if (saved.slip?.status === 'pending') {
              await deleteSlipImage(imageFile.path);
              await reply(event, slipConfirmationMessage(saved.slip, 'พบรายการนี้แล้วและยังรอยืนยัน'));
            } else if (saved.slip?.status === 'confirmed') {
              await deleteSlipImage(imageFile.path);
              await reply(event, textMessage('สลิปนี้ถูกยืนยันแล้ว ไม่ได้นำมาบันทึกซ้ำ'));
            } else {
              await deleteSlipImage(imageFile.path);
              await reply(event, textMessage('สลิปนี้เคยได้รับแล้ว จึงไม่ได้บันทึกซ้ำ'));
            }
          } catch (error) {
            console.error('Could not save pending slip:', error.message);
            await reply(event, textMessage('ระบบบันทึกรายการไม่สำเร็จ กรุณาลองส่งสลิปอีกครั้งภายหลัง'));
          }
        },
      });
    } catch (error) {
      console.error('Could not read LINE image:', error.message);
      await reply(event, textMessage('อ่านภาพนี้ไม่สำเร็จ กรุณาส่งภาพสลิปที่ชัดเจนอีกครั้ง'));
    }
  }

  async function handlePostback(event) {
    const lineUserId = event.source?.userId;
    const params = new URLSearchParams(event.postback?.data || '');
    const action = params.get('slip_action');
    const id = params.get('slip_id');
    if (!lineUserId || !/^[1-9]\d*$/.test(id || '')) {
      await reply(event, textMessage('คำสั่งนี้ไม่ถูกต้อง กรุณาเลือกจากข้อความสลิปอีกครั้ง'));
      return;
    }

    if (action === 'confirm') {
      const result = await slips.confirmPendingSlip({ id, lineUserId });
      const message = result.status === 'confirmed'
        ? textMessage('ยืนยันรายการแล้ว รายการนี้จะถูกรวมในสรุป')
        : result.status === 'already_confirmed'
          ? textMessage('รายการนี้ยืนยันแล้ว')
          : textMessage('ไม่พบรายการที่รอยืนยันในบัญชีนี้');
      await reply(event, message);
      return;
    }

    if (action === 'edit') {
      const result = await slips.startPendingSlipEdit({ id, lineUserId });
      const message = result.status === 'editing'
        ? textMessage(EDIT_PROMPT)
        : result.status === 'already_confirmed'
          ? textMessage('รายการนี้ยืนยันแล้ว จึงแก้ไขไม่ได้')
          : textMessage('ไม่พบรายการที่รอยืนยันในบัญชีนี้');
      await reply(event, message);
      return;
    }

    await reply(event, textMessage('ไม่รู้จักคำสั่งนี้ กรุณาเลือกจากข้อความสลิปอีกครั้ง'));
  }

  async function handleText(event) {
    const lineUserId = event.source?.userId;
    if (!lineUserId) return;
    const command = (event.message?.text || '').trim();
    const summaryCommands = new Map([
      ['/สรุปยอดรวมของวันนี้', 'day'], ['/สรุปยอดรวมของสัปดาห์นี้', 'week'],
      ['/สรุปยอดรวมของเดือนนี้', 'month'], ['/สรุปยอดรวมของปีนี้', 'year'],
    ]);
    const requestedPeriod = summaryCommands.get(command);
    if (requestedPeriod) {
      if (!summaryService) { await reply(event, textMessage('ระบบสรุปยอดยังไม่พร้อมใช้งาน')); return; }
      try {
        const timeZone = process.env.SUMMARY_TIMEZONE || 'Asia/Bangkok';
        const summary = await summaryService.buildPeriodSummary({ lineUserId, period: requestedPeriod, date: localDateInTimezone(timeZone) });
        await reply(event, transactionSummaryFlex(summary));
      } catch (error) {
        console.error('LINE period summary failed:', error.message);
        await reply(event, textMessage('สร้างสรุปยอดไม่สำเร็จชั่วคราว กรุณาลองอีกครั้ง'));
      }
      return;
    }
    const fields = parseEditMessage(event.message?.text || '');
    if (!fields) {
      if (/^(ยอดเงิน|ยอด|วันที่|เวลา|รายการ|บริษัทผู้รับ|ผู้รับ|คำนำหน้าผู้รับ|ชื่อผู้รับ|นามสกุลผู้รับ|คำนำหน้าผู้โอน|ชื่อผู้โอน|นามสกุลผู้โอน|รหัสอ้างอิง|เลขอ้างอิง)\s*[:=]/m.test(event.message?.text || '')) {
        await reply(event, textMessage(EDIT_PROMPT));
      }
      return;
    }

    try {
      const result = await slips.applyPendingSlipEdit({ lineUserId, ...fields });
      if (result.status === 'updated') {
        await reply(event, slipConfirmationMessage(result.slip, 'แก้ไขข้อมูลแล้ว กรุณาตรวจสอบและยืนยัน'));
      } else if (result.status === 'duplicate_reference') {
        await reply(event, textMessage('รหัสอ้างอิงนี้มีอยู่แล้วในบัญชีของคุณ กรุณาตรวจสอบและส่งข้อมูลใหม่'));
      } else {
        await reply(event, textMessage('ไม่พบคำขอแก้ไขที่ใช้งานอยู่ กรุณากด “แก้ไข” จากรายการสลิปก่อน'));
      }
    } catch (error) {
      if (error.code === 'INVALID_SLIP_DATA') {
        await reply(event, textMessage(`รูปแบบข้อมูลไม่ถูกต้อง กรุณาตรวจสอบแล้วส่งใหม่\n${EDIT_PROMPT}`));
        return;
      }
      throw error;
    }
  }

  async function handleEvent(event) {
    try {
      const supportedEvent = event.type === 'postback'
        || (event.type === 'message' && ['image', 'text'].includes(event.message?.type));
      if (supportedEvent && event.source?.type && event.source.type !== 'user') {
        await reply(event, textMessage('เพื่อแยกข้อมูลส่วนตัว กรุณาส่งสลิปและยืนยันรายการในแชทส่วนตัวกับบัญชีนี้'));
        return;
      }
      if (event.type === 'message' && event.message?.type === 'image') return await handleImage(event);
      if (event.type === 'postback') return await handlePostback(event);
      if (event.type === 'message' && event.message?.type === 'text') return await handleText(event);
    } catch (error) {
      console.error('LINE slip action failed:', error.message);
      await reply(event, textMessage('ระบบดำเนินการไม่สำเร็จชั่วคราว กรุณาลองอีกครั้งภายหลัง'));
    }
  }

  return { handleEvent };
}

module.exports = { createSlipWorkflow, getSlipDecision, parseEditMessage, hasTransactionMarker };
