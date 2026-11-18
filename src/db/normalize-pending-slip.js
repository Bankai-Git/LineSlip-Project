const THAI_MONTHS = new Map([
  ['มค', 1], ['มกราคม', 1],
  ['กพ', 2], ['กุมภาพันธ์', 2],
  ['มีค', 3], ['มีนาคม', 3],
  ['เมย', 4], ['เมษายน', 4],
  ['พค', 5], ['พฤษภาคม', 5],
  ['มิย', 6], ['มิถุนายน', 6],
  ['กค', 7], ['กรกฎาคม', 7],
  ['สค', 8], ['สิงหาคม', 8],
  ['กย', 9], ['กันยายน', 9],
  ['ตค', 10], ['ตุลาคม', 10],
  ['พย', 11], ['พฤศจิกายน', 11],
  ['ธค', 12], ['ธันวาคม', 12],
]);

const ENGLISH_MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['september', 9], ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
]);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_SLIP_DATA';
  return error;
}

function normalizeDate(value) {
  if (typeof value !== 'string') throw invalid('A transaction date is required');
  const input = value.trim();
  let year;
  let month;
  let day;

  let match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    [, year, month, day] = match;
    year = Number(year);
    month = Number(month);
    day = Number(day);
  } else if ((match = input.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
    if (match[3].length === 2) year += 2000;
  } else if ((match = input.match(/^(\d{1,2})\s*([^\d\s]+)\s*(\d{2,4})$/))) {
    day = Number(match[1]);
    const monthLabel = match[2].replace(/[^ก-๙A-Za-z]/g, '').toLowerCase();
    month = THAI_MONTHS.get(monthLabel) || ENGLISH_MONTHS.get(monthLabel);
    year = Number(match[3]);
    if (!month) throw invalid('The transaction date has an unsupported month');
    if (match[3].length === 2) year += THAI_MONTHS.has(monthLabel) ? 2500 : 2000;
  } else {
    throw invalid('The transaction date could not be parsed');
  }

  if (year > 2400) year -= 543;
  if (year < 2000 || year > 2200 || month < 1 || month > 12) {
    throw invalid('The transaction date is outside the supported range');
  }
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) throw invalid('The transaction date is not a valid calendar date');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid('A transaction amount is required');
  const amount = String(value).replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) {
    throw invalid('The transaction amount must be a positive number with at most two decimals');
  }
  const [whole, fraction = ''] = amount.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  if (normalizedWhole === '0' && !/[1-9]/.test(fraction)) throw invalid('The transaction amount must be greater than zero');
  if (normalizedWhole.length > 12) throw invalid('The transaction amount is too large');
  return `${normalizedWhole}.${fraction.padEnd(2, '0')}`;
}

function normalizeTime(value) {
  if (value == null || value === '') return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw invalid('The transaction time is invalid');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) throw invalid('The transaction time is invalid');
  return `${String(hour).padStart(2, '0')}:${match[2]}:${String(second).padStart(2, '0')}`;
}

const TRANSACTION_TYPES = new Set(['transfer', 'bill_payment', 'receive', 'other']);
const MASKED_SURNAME_PATTERN = /[*＊•·●○×]|(?:x|X){2,}|\.{2,}|#{2,}|_{2,}/;

function normalizeOptionalName(value, maxLength = 120) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) || null : null;
}

function normalizePendingSlip(input) {
  const lineUserId = typeof input?.lineUserId === 'string' ? input.lineUserId.trim() : '';
  const messageId = typeof input?.messageId === 'string' ? input.messageId.trim() : '';
  const referenceNo = typeof input?.parsed?.refNo === 'string' ? input.parsed.refNo.trim() : '';
  if (!lineUserId) throw invalid('LINE userId is required');
  if (!messageId) throw invalid('LINE messageId is required');
  if (!referenceNo) throw invalid('A reference number is required to prevent duplicate slips');

  const receivedAt = new Date(input.receivedAt || Date.now());
  if (!Number.isFinite(receivedAt.getTime())) throw invalid('The received timestamp is invalid');

  const confidence = input.parsed.ocrConfidence;
  const ocrConfidence = confidence == null ? null : Number(confidence);
  if (ocrConfidence != null && (!Number.isFinite(ocrConfidence) || ocrConfidence < 0 || ocrConfidence > 100)) {
    throw invalid('OCR confidence must be between 0 and 100');
  }

  return {
    lineUserId,
    messageId,
    webhookEventId: input.webhookEventId || null,
    referenceNo,
    amount: normalizeAmount(input.parsed.amount),
    transactionDate: normalizeDate(input.parsed.date),
    transactionTime: normalizeTime(input.parsed.time),
    recipientCompanyName: input.parsed.transactionType === 'bill_payment'
      ? normalizeOptionalName(input.parsed.recipientCompanyName || input.parsed.recipientName)
      : null,
    senderBankName: normalizeOptionalName(input.parsed.senderBankName, 120),
    recipientBankName: normalizeOptionalName(input.parsed.recipientBankName, 120),
    recipientPrefix: input.parsed.transactionType === 'bill_payment' ? null : normalizeOptionalName(input.parsed.recipientPrefix, 40),
    recipientFirstName: input.parsed.transactionType === 'bill_payment' ? null : normalizeOptionalName(input.parsed.recipientFirstName),
    recipientLastName: input.parsed.transactionType === 'bill_payment' ? null : (() => {
      const lastName = normalizeOptionalName(input.parsed.recipientLastName);
      return lastName && !MASKED_SURNAME_PATTERN.test(lastName) ? lastName : null;
    })(),
    senderPrefix: normalizeOptionalName(input.parsed.senderPrefix, 40),
    senderFirstName: normalizeOptionalName(input.parsed.senderFirstName),
    senderLastName: (() => {
      const lastName = normalizeOptionalName(input.parsed.senderLastName);
      return lastName && !MASKED_SURNAME_PATTERN.test(lastName) ? lastName : null;
    })(),
    transactionType: TRANSACTION_TYPES.has(input.parsed.transactionType) ? input.parsed.transactionType : 'other',
    ocrConfidence,
    receivedAt: receivedAt.toISOString(),
  };
}

function normalizeEditedSlip(input) {
  const referenceNo = typeof input?.referenceNo === 'string' ? input.referenceNo.trim() : '';
  if (!referenceNo) throw invalid('A reference number is required');
  const transactionType = input.transactionType == null || input.transactionType === ''
    ? null
    : input.transactionType;
  if (transactionType != null && !TRANSACTION_TYPES.has(transactionType)) {
    throw invalid('The transaction type is invalid');
  }
  const senderPrefixProvided = Object.hasOwn(input, 'senderPrefix');
  const senderFirstNameProvided = Object.hasOwn(input, 'senderFirstName');
  const senderLastNameProvided = Object.hasOwn(input, 'senderLastName');
  const recipientPrefixProvided = Object.hasOwn(input, 'recipientPrefix');
  const recipientFirstNameProvided = Object.hasOwn(input, 'recipientFirstName');
  const recipientLastNameProvided = Object.hasOwn(input, 'recipientLastName');
  const recipientCompanyNameProvided = Object.hasOwn(input, 'recipientCompanyName');
  const senderLastName = input.senderLastName === '-' ? null : normalizeOptionalName(input.senderLastName);
  const recipientLastName = input.recipientLastName === '-' ? null : normalizeOptionalName(input.recipientLastName);
  return {
    referenceNo,
    amount: normalizeAmount(input.amount),
    transactionDate: normalizeDate(input.date),
    transactionTime: normalizeTime(input.time),
    recipientPrefix: input.recipientPrefix === '-' ? null : normalizeOptionalName(input.recipientPrefix, 40),
    recipientPrefixProvided,
    recipientFirstName: input.recipientFirstName === '-' ? null : normalizeOptionalName(input.recipientFirstName),
    recipientFirstNameProvided,
    recipientLastName: recipientLastName && !MASKED_SURNAME_PATTERN.test(recipientLastName) ? recipientLastName : null,
    recipientLastNameProvided,
    recipientCompanyName: input.recipientCompanyName === '-' ? null : normalizeOptionalName(input.recipientCompanyName),
    recipientCompanyNameProvided,
    transactionType,
    senderPrefix: input.senderPrefix === '-' ? null : normalizeOptionalName(input.senderPrefix, 40),
    senderPrefixProvided,
    senderFirstName: input.senderFirstName === '-' ? null : normalizeOptionalName(input.senderFirstName),
    senderFirstNameProvided,
    senderLastName: senderLastName && !MASKED_SURNAME_PATTERN.test(senderLastName) ? senderLastName : null,
    senderLastNameProvided,
  };
}

module.exports = { normalizePendingSlip, normalizeEditedSlip };
