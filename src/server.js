require('dotenv').config();

const express = require('express');
const { middleware, SignatureValidationFailed } = require('@line/bot-sdk');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { createLineMessenger } = require('./line/messaging');
const { createSlipWorkflow } = require('./line/slip-workflow');
const { createQwenSummarizer } = require('./ai/qwen-ollama');
const { createSummaryService } = require('./summary/service');
const { localDateInTimezone, startSummaryScheduler } = require('./summary/scheduler');
const { SLIP_DIR } = require('./slips/image-store');

const channelSecret = process.env.LINE_CHANNEL_SECRET;

if (!channelSecret || channelSecret.startsWith('replace-with-')) {
  throw new Error('LINE_CHANNEL_SECRET is required. Copy .env.example to .env and configure it.');
}

function createApp({ onEvent = async () => {}, summaryService, dashboardLineUserId, slips } = {}) {
  const app = express();

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  function requireDashboardAuth(req, res, next) {
    const username = process.env.DASHBOARD_USERNAME;
    const password = process.env.DASHBOARD_PASSWORD;
    if (!username || !password || username.startsWith('replace-with-') || password.startsWith('replace-with-')) {
      return res.status(503).json({ error: { code: 'DASHBOARD_AUTH_NOT_CONFIGURED', message: 'Dashboard credentials are not configured' } });
    }
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    let suppliedUsername = '';
    let suppliedPassword = '';
    if (scheme === 'Basic' && encoded) {
      try {
        [suppliedUsername, suppliedPassword] = Buffer.from(encoded, 'base64').toString('utf8').split(/:(.*)/s, 2);
      } catch { /* handled as invalid credentials */ }
    }
    const matches = (supplied, expected) => {
      const actualBuffer = Buffer.from(supplied);
      const expectedBuffer = Buffer.from(expected);
      return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
    };
    if (!matches(suppliedUsername, username) || !matches(suppliedPassword, password)) {
      res.set('WWW-Authenticate', 'Basic realm="LineSlip Dashboard", charset="UTF-8"');
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Dashboard authentication required' } });
    }
    next();
  }

  app.get('/dashboard', requireDashboardAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
  });

  app.get('/database', requireDashboardAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '../public/database.html'));
  });

  app.get('/api/dashboard/slips', requireDashboardAuth, async (req, res) => {
    if (!slips || !dashboardLineUserId || dashboardLineUserId.startsWith('replace-with-')) {
      return res.status(503).json({ error: { code: 'DATABASE_VIEW_NOT_CONFIGURED', message: 'Database view is not configured' } });
    }
    const date = req.query.date || null;
    if (date) {
      const parsedDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? new Date(`${date}T00:00:00.000Z`)
        : null;
      if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        return res.status(400).json({ error: { code: 'INVALID_DATE', message: 'date must use YYYY-MM-DD' } });
      }
    }
    const status = req.query.status || 'all';
    if (!['all', 'pending', 'confirmed'].includes(status)) {
      return res.status(400).json({ error: { code: 'INVALID_STATUS', message: 'status must be all, pending, or confirmed' } });
    }
    const pageText = req.query.page || '1';
    if (typeof pageText !== 'string' || !/^[1-9]\d{0,5}$/.test(pageText)) {
      return res.status(400).json({ error: { code: 'INVALID_PAGE', message: 'page must be a positive integer' } });
    }
    const page = Number(pageText);
    const pageSize = 50;
    try {
      res.set('Cache-Control', 'no-store');
      const result = await slips.listDashboardSlips({
        lineUserId: dashboardLineUserId,
        date,
        status: status === 'all' ? null : status,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return res.json({ ...result, page, pageSize });
    } catch (error) {
      console.error('Dashboard database view failed:', error.message);
      return res.status(500).json({ error: { code: 'DATABASE_VIEW_FAILED', message: 'Could not load database rows' } });
    }
  });

  app.delete('/api/dashboard/slips/:id', requireDashboardAuth, async (req, res) => {
    if (!slips || !dashboardLineUserId || dashboardLineUserId.startsWith('replace-with-')) {
      return res.status(503).json({ error: { code: 'DATABASE_VIEW_NOT_CONFIGURED', message: 'Database view is not configured' } });
    }
    if (!/^[1-9]\d*$/.test(req.params.id)) {
      return res.status(400).json({ error: { code: 'INVALID_SLIP_ID', message: 'id must be a positive integer' } });
    }
    try {
      const deleted = await slips.deleteDashboardSlip({ id: req.params.id, lineUserId: dashboardLineUserId });
      res.set('Cache-Control', 'no-store');
      if (!deleted) return res.status(404).json({ error: { code: 'SLIP_NOT_FOUND', message: 'รายการไม่พบแล้ว' } });
      return res.sendStatus(204);
    } catch (error) {
      console.error('Dashboard slip deletion failed:', error.message);
      return res.status(500).json({ error: { code: 'SLIP_DELETE_FAILED', message: 'ลบรายการไม่สำเร็จ' } });
    }
  });

  app.get('/api/dashboard/slips/:id/image', requireDashboardAuth, async (req, res) => {
    if (!slips || !dashboardLineUserId || !/^[1-9]\d*$/.test(req.params.id)) return res.sendStatus(404);
    const image = await slips.getSlipImage({ id: req.params.id, lineUserId: dashboardLineUserId });
    if (!image?.image_path || path.basename(image.image_path) !== image.image_path) return res.sendStatus(404);
    res.set('Cache-Control', 'private, no-store');
    res.type(image.image_mime_type || 'application/octet-stream');
    return res.sendFile(path.join(SLIP_DIR, image.image_path), (error) => { if (error && !res.headersSent) res.sendStatus(404); });
  });

  app.get('/api/dashboard/summary', requireDashboardAuth, async (req, res) => {
    if (!summaryService || !dashboardLineUserId || dashboardLineUserId.startsWith('replace-with-')) {
      return res.status(503).json({ error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'Set DASHBOARD_LINE_USER_ID to scope the dashboard' } });
    }
    const timeZone = process.env.SUMMARY_TIMEZONE || 'Asia/Bangkok';
    const date = req.query.date || await slips.getLatestConfirmedDate({ lineUserId: dashboardLineUserId }) || localDateInTimezone(timeZone);
    const parsedDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(`${date}T00:00:00.000Z`)
      : null;
    if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ error: { code: 'INVALID_DATE', message: 'date must use YYYY-MM-DD' } });
    }
    const period = req.query.period || 'day';
    if (!['day', 'week', 'month', 'year'].includes(period)) {
      return res.status(400).json({ error: { code: 'INVALID_PERIOD', message: 'period must be day, week, month, or year' } });
    }
    try {
      res.set('Cache-Control', 'no-store');
      return res.json(await summaryService.buildPeriodSummary({ lineUserId: dashboardLineUserId, period, date }));
    } catch (error) {
      console.error('Dashboard summary failed:', error.message);
      return res.status(500).json({ error: { code: 'SUMMARY_FAILED', message: 'Could not load the summary' } });
    }
  });

  app.post('/webhook', middleware({ channelSecret }), (req, res) => {
    const events = req.body?.events;
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: { code: 'INVALID_WEBHOOK_BODY', message: 'Expected an events array' } });
    }

    // Acknowledge only after the SDK has validated the signature and parsed JSON.
    res.sendStatus(200);
    setImmediate(() => {
      for (const event of events) {
        Promise.resolve().then(() => onEvent(event)).catch((error) => {
          console.error('LINE event processing failed:', error.message);
        });
      }
    });
  });

  app.use((error, req, res, _next) => {
    if (error instanceof SignatureValidationFailed) {
      return res.status(401).json({ error: { code: 'INVALID_LINE_SIGNATURE', message: 'Webhook signature verification failed' } });
    }
    if (req.path === '/webhook') {
      console.error('LINE webhook request failed:', error.message);
      return res.status(400).json({ error: { code: 'INVALID_WEBHOOK', message: 'Webhook request could not be processed' } });
    }
    console.error(error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { createPool } = require('./db/pool');
  const { createSlipRepository } = require('./db/slip-repository');
  const pool = createPool();
  const slips = createSlipRepository(pool);
  const messenger = createLineMessenger(process.env.LINE_CHANNEL_ACCESS_TOKEN);
  const summaryService = createSummaryService({ slips, summarizer: createQwenSummarizer() });
  const workflow = createSlipWorkflow({ slips, messenger, summaryService });
  const dashboardLineUserId = process.env.DASHBOARD_LINE_USER_ID;
  const app = createApp({ onEvent: workflow.handleEvent, summaryService, dashboardLineUserId, slips });
  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => console.log(`LINE slip app listening on http://${host}:${port}`));
  const summaryTask = startSummaryScheduler({ slips, summaryService, messenger });

  const shutdown = () => server.close(async () => {
    summaryTask.stop();
    await pool.end();
    process.exit(0);
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { createApp, app: createApp() };
