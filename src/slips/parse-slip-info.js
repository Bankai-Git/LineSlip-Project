/**
 * Extracts candidate fields from OCR output. This is only a parser; the
 * later validation stage must decide whether the amount/date are trustworthy.
 * Accepts the existing raw string form or the OCR adapter's { text, confidence }.
 */
const TRANSACTION_TYPES = ['transfer', 'bill_payment', 'receive', 'other'];

// Bank brands/Thai legal names are normalized against BOT's current institution registry;
// standard Thai interbank abbreviations are cross-checked against bank-issued code tables.
// https://www.bot.or.th/th/fi-branch.html
// https://www.kasikornbank.com/th/Download/Level4_doc/EAZYMANUALKCashConnectPlus_EN.pdf
const BANKS = [
  { name: 'ธนาคารกรุงเทพ', aliases: ['ธนาคารกรุงเทพ', 'กรุงเทพ', 'bangkok bank', 'bualuang', 'bbl'] },
  { name: 'ธนาคารกสิกรไทย', aliases: ['ธนาคารกสิกรไทย', 'กสิกรไทย', 'kasikornbank', 'kbank', 'k plus', 'k-plus'] },
  { name: 'ธนาคารกรุงไทย', aliases: ['ธนาคารกรุงไทย', 'กรุงไทย', 'krungthai', 'krung thai', 'ktb', 'krungthai next'] },
  { name: 'ธนาคารไทยพาณิชย์', aliases: ['ธนาคารไทยพาณิชย์', 'ไทยพาณิชย์', 'siam commercial bank', 'scb easy', 'scb'] },
  { name: 'ธนาคารกรุงศรีอยุธยา', aliases: ['ธนาคารกรุงศรีอยุธยา', 'กรุงศรี', 'krungsri', 'bank of ayudhya'] },
  { name: 'ธนาคารทหารไทยธนชาต', aliases: ['ธนาคารทหารไทยธนชาต', 'ทีเอ็มบีธนชาต', 'ttb', 'ttb touch'] },
  { name: 'ธนาคารยูโอบี', aliases: ['ธนาคารยูโอบี', 'ยูโอบี', 'united overseas bank', 'uob'] },
  { name: 'ธนาคารซีไอเอ็มบี ไทย', aliases: ['ธนาคารซีไอเอ็มบี', 'ซีไอเอ็มบีไทย', 'cimb thai', 'cimb'] },
  { name: 'ธนาคารออมสิน', aliases: ['ธนาคารออมสิน', 'ออมสิน', 'government savings bank', 'my mo', 'my mo'] },
  { name: 'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร', aliases: ['ธนาคารเพื่อการเกษตร', 'ธ.ก.ส.', 'ธกส', 'baac', 'a-mobile'] },
  { name: 'ธนาคารอาคารสงเคราะห์', aliases: ['ธนาคารอาคารสงเคราะห์', 'ธอส', 'ghb', 'ธอส.'] },
  { name: 'ธนาคารอิสลามแห่งประเทศไทย', aliases: ['ธนาคารอิสลามแห่งประเทศไทย', 'ไอแบงก์', 'ibank', 'islamic bank of thailand'] },
  { name: 'ธนาคารทิสโก้', aliases: ['ธนาคารทิสโก้', 'ทิสโก้', 'tisco'] },
  { name: 'ธนาคารเกียรตินาคินภัทร', aliases: ['ธนาคารเกียรตินาคินภัทร', 'เกียรตินาคิน', 'kkp'] },
  { name: 'ธนาคารแลนด์ แอนด์ เฮ้าส์', aliases: ['ธนาคารแลนด์แอนด์เฮ้าส์', 'แลนด์ แอนด์ เฮ้าส์', 'lh bank', 'lhbank'] },
  { name: 'ธนาคารไทยเครดิต', aliases: ['ธนาคารไทยเครดิต', 'ไทยเครดิต', 'thaicredit'] },
  { name: 'ธนาคารไอซีบีซี (ไทย)', aliases: ['ธนาคารไอซีบีซี', 'ไอซีบีซีไทย', 'icbc thai'] },
  { name: 'ธนาคารซิตี้แบงก์', aliases: ['citibank', 'ซิตี้แบงก์'] },
];

function detectBank(rawText) {
  const normalized = rawText.toLocaleLowerCase().replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ');
  return BANKS.find((bank) => bank.aliases.some((alias) => {
    const key = alias.toLocaleLowerCase().replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/[ก-๙]/.test(key)) return normalized.includes(key);
    return new RegExp(`(?:^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(normalized);
  }))?.name || null;
}

function detectPartyBanks(lines) {
  const recipientIndex = lines.findIndex((line) => /^(?:ถึง|ผู้รับ|recipient|to)\s*[:：]?/i.test(cleanOcrLine(line)));
  if (recipientIndex < 0) return { senderBankName: detectBank(lines.join('\n')), recipientBankName: null };
  const senderLines = lines.slice(0, recipientIndex);
  const recipientLines = lines.slice(recipientIndex, recipientIndex + 8);
  const senderBankName = detectBank(senderLines.join('\n')) || detectBank(lines.join('\n'));
  const recipientBankName = detectBank(recipientLines.join('\n'));
  return { senderBankName, recipientBankName };
}

function cleanOcrLine(line) {
  return line
    .replace(/<\/?figure>/gi, ' ')
    .replace(/[`#]/g, '')
    .replace(/^\s*[|>•-]+\s*/, '')
    .trim();
}

function parseSenderName(lines) {
  let nameText = null;
  const senderLabel = /^(?:จาก|ผู้โอน|sender|from)\s*[:：]?\s*(.*)$/i;
  for (let index = 0; index < lines.length; index += 1) {
    const cleaned = cleanOcrLine(lines[index]);
    const match = cleaned.match(senderLabel);
    if (!match) continue;
    nameText = match[1].trim();
    if (!nameText) {
      for (const candidate of lines.slice(index + 1, index + 5)) {
        const next = cleanOcrLine(candidate);
        if (/^(?:ถึง|to)(?:\s|$)/i.test(next)) break;
        if (/^(?:ธนาคาร|บัญชี|เลขที่บัญชี|พร้อมเพย์|รหัส|รายการ|เวลา|วันที่|ยอด|จำนวนเงิน)\b/i.test(next)) continue;
        nameText = next;
        break;
      }
    }
    break;
  }
  if (!nameText) return { senderPrefix: null, senderFirstName: null, senderLastName: null };

  nameText = cleanOcrLine(nameText)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+(?:ธนาคาร|บัญชี|เลขที่บัญชี|พร้อมเพย์)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = nameText.split(' ').filter(Boolean);
  const prefixNames = ['นางสาว', 'ด.ช.', 'ด.ญ.', 'น.ส.', 'นาย', 'นาง', 'Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.'];
  const normalizedPrefix = (token) => token.toLowerCase().replace(/\.$/, '');
  const prefixIndex = prefixNames.findIndex((prefix) => normalizedPrefix(prefix) === normalizedPrefix(tokens[0] || ''));
  const senderPrefix = prefixIndex >= 0 ? prefixNames[prefixIndex] : null;
  const nameTokens = senderPrefix ? tokens.slice(1) : tokens;
  const senderFirstName = nameTokens[0]?.slice(0, 120) || null;
  const surname = nameTokens.slice(1).join(' ').slice(0, 120);
  const maskedSurname = /[*＊•·●○×]|(?:x|X){2,}|\.{2,}|#{2,}|_{2,}/.test(surname);

  return {
    senderPrefix,
    senderFirstName,
    senderLastName: surname && !maskedSurname ? surname : null,
  };
}

function parseRecipientName(lines) {
  let nameText = null;
  const label = /^(?:ถึง|ผู้รับ|recipient|to)\s*[:：]?\s*(.*)$/i;
  for (let i = 0; i < lines.length; i += 1) {
    const cleaned = cleanOcrLine(lines[i]);
    const match = cleaned.match(label);
    if (!match) continue;
    nameText = match[1].trim();
    if (!nameText) {
      for (const candidate of lines.slice(i + 1, i + 8)) {
        const next = cleanOcrLine(candidate);
        if (/^(?:จาก|ผู้โอน|sender|from|พร้อมเพย์|QR\s*Code|รหัส|รายการ|บัญชี)/i.test(next) || /^\d{4,}/.test(next)) break;
        if ((next.match(/[ก-๙]/g) || []).length >= 3 || /\b[A-Za-z]{2,}/.test(next)) { nameText = next; break; }
      }
    }
    break;
  }
  if (!nameText) return { recipientPrefix: null, recipientFirstName: null, recipientLastName: null, recipientName: null };
  nameText = cleanOcrLine(nameText).replace(/\([^)]*\)/g, ' ').replace(/\s+(?:ธนาคาร|บัญชี|เลขที่บัญชี|พร้อมเพย์)\b.*$/i, '').replace(/\s+/g, ' ').trim();
  const tokens = nameText.split(' ').filter(Boolean);
  const prefixes = ['นางสาว', 'ด.ช.', 'ด.ญ.', 'น.ส.', 'นาย', 'นาง', 'Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.'];
  const norm = (s) => s.toLowerCase().replace(/\.$/, '');
  const prefix = prefixes.find((item) => norm(item) === norm(tokens[0] || '')) || null;
  const names = prefix ? tokens.slice(1) : tokens;
  const first = names[0]?.slice(0, 120) || null;
  const surname = names.slice(1).join(' ').slice(0, 120);
  const masked = /[*＊•·●○×]|(?:x|X){2,}|\.{2,}|#{2,}|_{2,}/.test(surname);
  return {
    recipientPrefix: prefix,
    recipientFirstName: first,
    recipientLastName: surname && !masked ? surname : null,
    recipientName: [prefix, first, surname && !masked ? surname : null].filter(Boolean).join(' ') || null,
  };
}

function parseRecipientCompanyName(lines, fallback) {
  const label = /^(?:บริษัทผู้รับ|ผู้รับชำระ|ชื่อผู้ให้บริการ|ร้านค้า|ชื่อร้านค้า|merchant|biller|payee)\s*[:：]?\s*(.*)$/i;
  for (let index = 0; index < lines.length; index += 1) {
    const match = cleanOcrLine(lines[index]).match(label);
    if (!match) continue;
    const value = match[1].trim() || cleanOcrLine(lines[index + 1] || '');
    if (value && !/^(?:เลขที่รายการ|รหัสอ้างอิง|จำนวนเงิน|ยอดเงิน|วันที่|เวลา|from|to)\b/i.test(value)) return value.slice(0, 120);
  }
  return fallback;
}

function detectTransactionType(rawText, bankName = null) {
  if (/(?:ชำระ|จ่าย)(?:ค่า|บิล)|รายการชำระบิล|bill\s*payment|payment\s+of\s+bill/i.test(rawText)) return 'bill_payment';
  if (/(?:เงินเข้า|รับโอน|ได้รับเงิน|รายการรับเงิน|รับเงิน)|money\s+received|received\s+(?:a\s+)?transfer|incoming\s+transfer/i.test(rawText)) return 'receive';
  if (/(?:รายการโอนเงิน|หลักฐานการโอน|โอนเงิน)|\btransfer\b/i.test(rawText)) return 'transfer';
  const senderLabel = /(?:^|\n)\s*(?:จาก|ผู้โอน|sender|from)\s*[:：]?/im.test(rawText);
  const recipientLabel = /(?:^|\n)\s*(?:ถึง|ผู้รับ|recipient|to)\s*[:：]?/im.test(rawText);
  const outgoingEvidence = /(?:โอนออก|เงินออก|หักจากบัญชี|ถอนจากบัญชี|จ่ายจากบัญชี|โอนไปยัง|โอนให้|transfer\s+to|debit(?:ed)?)/i.test(rawText)
    || (senderLabel && recipientLabel)
    || (Boolean(bankName) && senderLabel && recipientLabel);
  if (outgoingEvidence) return 'transfer';
  return 'other';
}

function parseSlipInfo(ocrResult) {
  const rawText = typeof ocrResult === 'string' ? ocrResult : ocrResult?.text;
  if (typeof rawText !== 'string') {
    throw new TypeError('parseSlipInfo expects OCR text or an object containing text');
  }

  const amountMatch = rawText.match(/(\d{1,3}(?:,\d{3})*\.\d{2})\s*(?:บาท|THB|บ\.)?/);
  const thaiMonth = '(?:ม\\.ค\\.?|ก\\.พ\\.?|มี\\.ค\\.?|เม\\.ย\\.?|พ\\.ค\\.?|มิ\\.ย\\.?|ก\\.ค\\.?|ส\\.ค\\.?|ก\\.ย\\.?|ต\\.ค\\.?|พ\\.ย\\.?|ธ\\.ค\\.?|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|[A-Za-z]{3,})';
  const dateMatch = rawText.match(new RegExp(`(?:^|[^\\d])(\\d{1,2}\\s*${thaiMonth}\\s*\\.?\\s*\\d{2,4})`));
  const timeMatch = rawText.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
  const refMatch = rawText.match(/(?:เลขที่รายการ|รหัสอ้างอิง|Ref(?:erence)?(?:\s*No)?)[:\s]*([A-Za-z0-9]+(?:\|[A-Za-z0-9]+)*)/i);

  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sender = parseSenderName(lines);
  const recipient = parseRecipientName(lines);
  const partyBanks = detectPartyBanks(lines);
  const transactionType = detectTransactionType(rawText, partyBanks.senderBankName);

  return {
    amount: amountMatch ? amountMatch[1] : null,
    date: dateMatch ? dateMatch[1] : null,
    time: timeMatch ? timeMatch[1] : null,
    refNo: refMatch ? refMatch[1] : null,
    ...(transactionType === 'bill_payment'
      ? { recipientPrefix: null, recipientFirstName: null, recipientLastName: null, recipientCompanyName: parseRecipientCompanyName(lines, recipient.recipientName) }
      : { recipientPrefix: recipient.recipientPrefix, recipientFirstName: recipient.recipientFirstName, recipientLastName: recipient.recipientLastName, recipientCompanyName: null }),
    ...sender,
    transactionType,
    ...partyBanks,
    rawText,
    ocrConfidence: typeof ocrResult === 'string' ? null : ocrResult.confidence ?? null,
  };
}

module.exports = { parseSlipInfo, parseSenderName, parseRecipientName, parseRecipientCompanyName, detectTransactionType, detectBank, detectPartyBanks, TRANSACTION_TYPES };
