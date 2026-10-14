'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { generateAuthBuffer } = require('../../adapters/web-h5/auth');

const ROOT = path.resolve(__dirname, '../..');
const PAGE_FILE = path.join(ROOT, 'adapters/web-h5/listen.html');
const SDK_FILE = path.join(ROOT, 'adapters/web-h5/sdk/WebRTCService.js');
const TICKETS_PER_MINUTE = 30;

// Reads GME_SDK_APP_ID / GME_SDK_KEY from the owner's local .env.gme. Read per
// request so edits take effect without a restart; the key never leaves this
// process — listeners only receive a short-lived authBuffer.
function readGmeCredentials(envFile) {
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); } catch { return null; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const appId = Number(values.GME_SDK_APP_ID);
  const secret = values.GME_SDK_KEY || '';
  if (!Number.isSafeInteger(appId) || appId <= 0 || Buffer.byteLength(secret, 'utf8') !== 16) return null;
  return { appId, secret };
}

// Public listener page: anyone who can reach the API can open /listen and hear
// the bot's GME room (the owner's own GME app). Tickets are receive-only by
// convention of the page, expire in 5 minutes, and are rate limited per IP.
function createListenRouter({ gmeAdapter, envFile = path.join(ROOT, '.env.gme') } = {}) {
  const router = express.Router();
  const recent = new Map();

  function rateLimited(ip) {
    const now = Date.now();
    const hits = (recent.get(ip) || []).filter(t => now - t < 60_000);
    hits.push(now);
    recent.set(ip, hits);
    if (recent.size > 1000) for (const [key, value] of recent) if (!value.some(t => now - t < 60_000)) recent.delete(key);
    return hits.length > TICKETS_PER_MINUTE;
  }

  router.get(['/listen', '/listen/'], (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(PAGE_FILE);
  });

  router.get('/listen/sdk.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('application/javascript').sendFile(SDK_FILE);
  });

  router.get('/listen/ticket', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'ขอบ่อยเกินไป ลองใหม่ในอีกสักครู่' });
    if (!gmeAdapter) return res.status(503).json({ error: 'บอทยังไม่ได้ต่อ audio adapter' });
    const credentials = readGmeCredentials(envFile);
    if (!credentials) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า GME ใน .env.gme' });
    let state;
    try { state = await gmeAdapter.status(); } catch { return res.status(503).json({ error: 'ติดต่อ audio adapter ไม่ได้' }); }
    const roomId = String(state?.room || '').trim();
    if (!state?.inRoom || !roomId) return res.status(409).json({ error: 'บอทยังไม่ได้อยู่ในห้อง' });
    // Numeric openId in the same 31-bit space the bot app uses (GME rejects
    // non-numeric ids on Android); a random draw makes collisions negligible.
    const openId = String(crypto.randomInt(100_000, 2 ** 31 - 1));
    const authBuffer = generateAuthBuffer(openId, roomId, credentials);
    return res.json({ appId: credentials.appId, roomId, openId, authBuffer, playing: state.status === 'playing' });
  });

  return router;
}

module.exports = { createListenRouter, readGmeCredentials };
