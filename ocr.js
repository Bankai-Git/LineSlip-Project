/**
 * slip-ocr.js
 * -----------------------------------------------------------------------
 * อ่านข้อมูลจากภาพสลิปโอนเงิน (Thai bank transfer slip) ด้วย Tesseract.js
 *
 * หลักการทำงาน:
 *   1. รับไฟล์ภาพสลิปที่อัปโหลดเข้ามา (path, Buffer หรือ URL)
 *   2. ใช้ sharp ปรับภาพให้เป็น Grayscale + เพิ่ม Contrast/Sharpen
 *      เพื่อลบลวดลายพื้นหลังของสลิปธนาคาร ทำให้ OCR อ่านง่ายขึ้น
 *   3. ใช้ Tesseract.js อ่านข้อความภาษาไทย+อังกฤษ (tha+eng)
 *      ออกมาเป็น string ยาว ๆ แล้วส่งกลับ (ในไฟล์นี้มีฟังก์ชัน parse
 *      ตัวอย่างแนบมาด้วย เผื่อผู้ใช้อยากดึงยอดเงิน/เลขอ้างอิงต่อ)
 *
 * ติดตั้ง dependency ก่อนใช้งาน:
 *   npm install tesseract.js sharp
 *
 * ตัวอย่างการใช้งาน (ดูท้ายไฟล์ในส่วน `if (require.main === module)`):
 *   node slip-ocr.js ./slip.jpg
 * -----------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs/promises');
const { readSlipText, preprocessSlipImage } = require('./src/ocr');
const { parseSlipInfo } = require('./src/slips/parse-slip-info');

/**
 * ปรับแต่งภาพสลิปให้เหมาะกับการทำ OCR
 * - แปลงเป็นขาวดำ (grayscale)
 * - ขยายขนาดภาพถ้าเล็กเกินไป (ช่วยให้ OCR อ่านตัวอักษรเล็ก ๆ ได้ดีขึ้น)
 * - เพิ่ม contrast / normalize แสง
 * - sharpen ให้ขอบตัวอักษรคมขึ้น
 * - แปลงเป็น threshold ขาว-ดำล้วน (binarize) เพื่อตัดลวดลายพื้นหลังสลิป
 *
 * @param {Buffer|string} input - path ของไฟล์ภาพ หรือ Buffer ของภาพ
 * @returns {Promise<Buffer>} buffer ของภาพที่ผ่านการปรับแต่งแล้ว (PNG)
 */
/**
 * (ตัวอย่าง) ดึงข้อมูลสำคัญจากข้อความสลิปที่ OCR ได้ ด้วย regex เบื้องต้น
 * หมายเหตุ: รูปแบบสลิปแต่ละธนาคารไม่เหมือนกัน ควรปรับ regex ให้ตรงกับ
 * ธนาคารที่ใช้งานจริง นี่เป็นเพียงตัวอย่างโครงสร้างเริ่มต้น
 *
 * @param {string} rawText - ข้อความดิบที่ได้จาก Tesseract
 * @returns {{ amount: string|null, date: string|null, time: string|null,
 *             refNo: string|null, rawText: string }}
 */
module.exports = {
  preprocessSlipImage,
  readSlipText,
  parseSlipInfo,
};

// -----------------------------------------------------------------------
// ตัวอย่างการรันตรง ๆ จาก command line:
//   node slip-ocr.js path/to/slip.jpg
// -----------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const filePath = process.argv[2];
    if (!filePath) {
      console.error('กรุณาระบุ path ของไฟล์ภาพสลิป เช่น: node slip-ocr.js ./slip.jpg');
      process.exit(1);
    }

    try {
      await fs.access(path.resolve(filePath));

      console.log('กำลังอ่านข้อมูลจากสลิป...');
      const { text, confidence } = await readSlipText(filePath, {
        onProgress: (p) => process.stdout.write(`\rความคืบหน้า: ${(p * 100).toFixed(0)}%`),
      });

      const confidenceLabel = Number.isFinite(confidence)
        ? `${confidence.toFixed(1)}%`
        : 'โมเดลไม่ได้รายงานค่า confidence';
      console.log(`\n\n=== ความมั่นใจของ OCR: ${confidenceLabel} ===`);
      console.log('=== ข้อความที่อ่านได้ (raw text) ===');
      console.log(text);

      console.log('\n=== ข้อมูลที่ดึงออกมา (ตัวอย่าง parse) ===');
      console.log(parseSlipInfo(text));
    } catch (err) {
      console.error('เกิดข้อผิดพลาด:', err.message);
      process.exit(1);
    }
  })();
}
