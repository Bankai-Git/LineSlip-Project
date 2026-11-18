# LineSlip Project

ระบบบันทึกธุรกรรมจากภาพสลิปผ่าน LINE Messaging API ใช้ PostgreSQL เก็บข้อมูล, Typhoon OCR และ Qwen ผ่าน Ollama บนเครื่องหรือเซิร์ฟเวอร์ของผู้ใช้ โดยต้องให้ผู้ใช้ตรวจและยืนยันรายการก่อนนำไปสรุป

## ความสามารถ

- ตรวจลายเซ็น `x-line-signature` ของ LINE ก่อนรับ webhook event
- ดาวน์โหลดภาพจาก LINE, อ่านข้อความด้วย OCR provider กลาง และแยกข้อมูลสลิป
- รองรับ Typhoon OCR 1.5 ผ่าน Ollama เป็นค่าเริ่มต้น และ Tesseract เป็นทางเลือก
- ตรวจรายการซ้ำตาม LINE user, message และเลขอ้างอิง
- บันทึกสถานะ `pending` ก่อนส่งให้ยืนยันหรือแก้ไขใน LINE; สรุปนับเฉพาะ `confirmed`
- จัดข้อมูลส่วนบุคคลและรายการตาม `line_user_id`
- บันทึกไฟล์สลิปใน `slip/` และผูกพาธกับแถว PostgreSQL; ดูภาพผ่าน endpoint ที่ยืนยันตัวตนและตรวจขอบเขตผู้ใช้
- ตรวจชื่อธนาคารจากข้อความ OCR เทียบกับรายชื่อธนาคารที่ดูแลไว้ในโค้ด และแยกธนาคารผู้โอน/ผู้รับเมื่อข้อมูลพอ
- สรุปยอดด้วย SQL; Qwen ช่วยเขียนคำบรรยาย ไม่คำนวณยอด
- Dashboard มีช่วงวัน/สัปดาห์/เดือน/ปี กราฟยอดโอนและยอดรับ และหน้าดูข้อมูลดิบ
- ส่งสรุปตามเวลาที่กำหนดขณะโปรเซสทำงาน

## หลักการทำงานและ Flow

```mermaid
flowchart LR
  A[LINE ส่งภาพ] --> B[ตรวจ signature]
  B --> C[ดาวน์โหลดภาพจาก LINE]
  C --> D[บันทึกภาพไว้ใน slip/]
  C --> E[OCR interface]
  E --> F[Typhoon ผ่าน Ollama หรือ Tesseract]
  F --> G[ParseSlipInfo: ยอด วันที่ ผู้โอน ผู้รับ ธนาคาร]
  G --> H{ข้อมูลครบและไม่ซ้ำ?}
  H -->|ไม่ครบ/ไม่ใช่สลิป| I[ตอบ LINE แล้วหยุด]
  H -->|ครบ| J[(PostgreSQL: pending)]
  J --> K[ผู้ใช้ตรวจ/แก้ไข/ยืนยันใน LINE]
  K -->|ยืนยัน| L[(confirmed)]
  L --> M[SQL คำนวณสรุป]
  M --> N[Qwen เขียนคำบรรยาย]
  M --> O[Dashboard และสรุป LINE]
```

OCR ถูกครอบด้วย interface ใน `src/ocr/` เพื่อสลับ provider ได้ โค้ดปัจจุบันส่งข้อความ OCR ให้ parser; **ยังไม่มีการอ่าน/ตรวจ QR code ของสลิป** แม้แผนภาพอ้างอิงจะกล่าวถึง QR

การอนุมาน `transfer` ใช้คำหรือโครงสร้างที่บ่งชี้ว่ามีเงินออก/มีผู้โอนและผู้รับ ชื่อธนาคารเพียงอย่างเดียวไม่เพียงพอ ถ้าระบุธนาคารหรือฝ่ายผู้โอนไม่ได้ ระบบอาจเก็บเป็นค่าว่างหรือประเภท `other` เพื่อหลีกเลี่ยงการเดา

## โครงสร้างโปรเจกต์

```text
src/
  ai/                 Qwen/Ollama สำหรับคำบรรยายสรุป
  db/                 PostgreSQL pool, repository, normalization, migrations
  line/               LINE webhook, ดาวน์โหลดภาพ, workflow และข้อความ
  ocr/                interface กลางและ provider Typhoon/Tesseract
  slips/              parse ข้อมูลและจัดเก็บไฟล์สลิป
  summary/            ช่วงเวลา, SQL summary และ scheduler
public/               Dashboard และหน้าดูแถวข้อมูล
migrations/           SQL migrations ตามลำดับ
slip/                 ภาพสลิปที่รับเข้า (ห้ามนำขึ้น Git)
Remember-Project/      เอกสารอ้างอิงโครงสร้างงาน
```

## สเปกเครื่องแนะนำ

โมเดล Qwen3.5:9B บน Ollama มีขนาดดาวน์โหลดราว 6.6–7.6 GB ตามหน้า Ollama; ยังต้องเผื่อหน่วยความจำสำหรับ context, Typhoon, Node.js, PostgreSQL และระบบปฏิบัติการ [Ollama: Qwen3.5](https://ollama.com/library/qwen3.5)

| การใช้งาน | คำแนะนำ |
|---|---|
| ทดลอง/พัฒนาบน CPU | CPU 8 คอร์, RAM 32 GB, SSD ว่าง 40 GB ขึ้นไป; ใช้ได้แต่ OCR/AI อาจช้า |
| ใช้งานส่วนตัวหรือทีมเล็ก | CPU 8–12 คอร์, RAM 32–64 GB, GPU VRAM 12–16 GB, NVMe SSD 100 GB ขึ้นไป |
| มีผู้ใช้พร้อมกันหลายคน | RAM 64 GB ขึ้นไป, GPU VRAM 24 GB ขึ้นไป หรือแยก Ollama ออกจาก app/database แล้วทดสอบ throughput จริง |

โมเดล Typhoon OCR และ Qwen ใช้ทรัพยากรร่วมกันได้ การโหลดพร้อมกันอาจต้องใช้ VRAM/RAM เพิ่ม คำแนะนำเป็นจุดเริ่มต้น ไม่ใช่ข้อกำหนดรับประกันความเร็ว ควรทดสอบกับภาพสลิปจริงและจำนวนผู้ใช้เป้าหมาย

## ข้อกำหนดก่อนติดตั้ง

- Node.js 20 ขึ้นไป และ npm
- PostgreSQL ในเครื่องหรือบนเครือข่ายส่วนตัว
- Ollama ที่ติดตั้งโมเดล Typhoon OCR และ Qwen
- LINE Official Account และ Messaging API channel ที่มี Channel secret/access token
- URL HTTPS ที่ LINE เรียก webhook ได้ เช่น reverse proxy หรือ tunnel

## ติดตั้งบน Linux (Ubuntu/Debian)

### 1. ติดตั้งเครื่องมือ

ติดตั้ง Node.js 20+, PostgreSQL และ Ollama ตามคู่มือทางการของแต่ละโครงการ จากนั้นตรวจสอบ:

```bash
node --version
npm --version
psql --version
ollama --version
```

### 2. เตรียม PostgreSQL

ตัวอย่างสร้าง role/database (แทนรหัสผ่านด้วยค่าที่ปลอดภัย):

```bash
sudo -u postgres createuser --pwprompt lineslip
sudo -u postgres createdb --owner=lineslip lineslip
```

หาก PostgreSQL ใช้ peer authentication หรือกำหนดรหัสผ่านต่างจากตัวอย่าง ให้ปรับ `DATABASE_URL` ให้ตรงกับการตั้งค่าจริง

### 3. ดาวน์โหลดโปรเจกต์และตั้งค่า

```bash
git clone <GITHUB_REPOSITORY_URL>
cd LineSlip-Project
npm ci
cp .env.example .env
```

แก้ `.env` อย่างน้อย:

```dotenv
PORT=3000
HOST=127.0.0.1
LINE_CHANNEL_SECRET=<จาก LINE Developers Console>
LINE_CHANNEL_ACCESS_TOKEN=<จาก LINE Developers Console>
DATABASE_URL=postgresql://lineslip:<รหัสผ่าน>@127.0.0.1:5432/lineslip
OCR_PROVIDER=typhoon
TYPHOON_OCR_BASE_URL=http://127.0.0.1:11434/v1
TYPHOON_OCR_MODEL=scb10x/typhoon-ocr1.5-3b:latest
OLLAMA_BASE_URL=http://127.0.0.1:11434
LOCAL_AI_MODEL=qwen3.5:9b
DASHBOARD_LINE_USER_ID=<LINE userId ของเจ้าของ Dashboard>
DASHBOARD_USERNAME=<ชื่อผู้ใช้>
DASHBOARD_PASSWORD=<รหัสผ่านที่คาดเดายาก>
SUMMARY_TIMEZONE=Asia/Bangkok
SUMMARY_CRON=0 21 * * *
```

อย่าใส่เครื่องหมาย `< >` รอบค่าจริง และอย่าเผยแพร่ `.env`

### 4. ดาวน์โหลดโมเดลและ migrate

```bash
ollama pull scb10x/typhoon-ocr1.5-3b
ollama pull qwen3.5:9b
npm run db:migrate
npm start
```

ตรวจสุขภาพแอปในเครื่อง:

```bash
curl -i http://127.0.0.1:3000/health
```

### 5. เปิด HTTPS ให้ LINE เรียก

สร้าง HTTPS tunnel หรือ reverse proxy ไปยัง `127.0.0.1:3000` แล้วตั้ง Webhook URL ใน LINE Developers Console เป็น `https://<โดเมน>/webhook` กด Verify และเปิด Use webhook หากใช้ลิงก์ Dashboard ใน LINE ให้ตั้ง `DASHBOARD_PUBLIC_URL` เป็น HTTPS ด้วย

เปิด Dashboard ใน browser ที่เข้าถึงเซิร์ฟเวอร์ได้ที่ `/dashboard`; ข้อมูลดิบอยู่ที่ `/database` ทั้งสองหน้าต้องใช้ Basic Auth ตาม `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`

## ติดตั้งบน Windows (PowerShell)

### 1. ติดตั้งเครื่องมือ

ติดตั้ง Node.js 20+, PostgreSQL และ Ollama ด้วยตัวติดตั้งทางการ แล้วเปิด PowerShell ใหม่:

```powershell
node --version
npm --version
psql --version
ollama --version
```

หาก `psql` ไม่พบ ให้เพิ่มโฟลเดอร์ `PostgreSQL\<version>\bin` ลงใน PATH หรือใช้ SQL Shell (psql)

### 2. สร้างฐานข้อมูล

เปิด SQL Shell/psql ด้วยบัญชีผู้ดูแล PostgreSQL แล้วรัน:

```sql
CREATE USER lineslip WITH PASSWORD 'ใส่รหัสผ่านที่คาดเดายาก';
CREATE DATABASE lineslip OWNER lineslip;
```

### 3. ดาวน์โหลดโปรเจกต์และตั้งค่า

```powershell
git clone <GITHUB_REPOSITORY_URL>
cd LineSlip-Project
npm ci
Copy-Item .env.example .env
notepad .env
```

กรอกค่า `.env` ตามตัวอย่าง Linux ข้างต้น โดยใช้ connection string เช่น:

```dotenv
DATABASE_URL=postgresql://lineslip:รหัสผ่าน@127.0.0.1:5432/lineslip
```

ถ้ารหัสผ่านมีอักขระพิเศษใน URL ให้ URL-encode ก่อน

### 4. ดาวน์โหลดโมเดลและเริ่มระบบ

```powershell
ollama pull scb10x/typhoon-ocr1.5-3b
ollama pull qwen3.5:9b
npm run db:migrate
npm start
```

ถ้า PostgreSQL/Ollama ไม่ได้เริ่มเป็น service ให้เปิดบริการก่อนเริ่มแอป จากนั้นตรวจ `http://127.0.0.1:3000/health` และตั้ง HTTPS tunnel/reverse proxy ไปยังพอร์ต 3000 เพื่อใส่ URL ลงใน LINE Developers Console

## คำสั่ง LINE

- `/สรุปยอดรวมของวันนี้`
- `/สรุปยอดรวมของสัปดาห์นี้`
- `/สรุปยอดรวมของเดือนนี้`
- `/สรุปยอดรวมของปีนี้`

ระบบตั้งเวลาส่งสรุปเฉพาะขณะที่โปรเซสทำงาน งานที่พลาดระหว่างปิดแอปจะไม่ถูกเก็บไปทำย้อนหลัง

## OCR ทางเลือก: Tesseract

ดาวน์โหลดไฟล์ `tha.traineddata` และ `eng.traineddata` จาก [tessdata](https://github.com/tesseract-ocr/tessdata) วางไว้ที่ root โปรเจกต์ แล้วตั้ง:

```dotenv
OCR_PROVIDER=tesseract
```

## ความปลอดภัยและข้อมูล

- ห้าม commit `.env`, รูปใน `slip/`, ตัวอย่างสลิปจริง, dump ฐานข้อมูล หรือไฟล์ที่มี LINE userId
- ภาพสลิปมีข้อมูลส่วนบุคคล ให้จำกัดสิทธิ์โฟลเดอร์และสำรองข้อมูลอย่างปลอดภัย
- `/dashboard`, `/database` และ API ข้อมูลต้องผ่าน Basic Auth; ควรวางหลัง HTTPS เมื่อเข้าจากเครือข่ายภายนอก
- เก็บ Channel secret/access token และรหัสผ่าน Dashboard ไว้ใน `.env` ที่ไม่เผยแพร่
- สำรอง PostgreSQL และโฟลเดอร์ `slip/` คู่กัน เพื่อให้แถวข้อมูลยังชี้ไปยังภาพที่ถูกต้อง

ดูแผนสถาปัตยกรรมอ้างอิงที่ `Remember-Project/Remember.txt`
