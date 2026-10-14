/**
 * Tencent GME AuthBuffer Generator — Node.js port of gme_auth.py
 *
 * QQ TEA cipher (CBC mode) + AuthBuffer struct packing.
 *
 * Runtime GME credentials are supplied through local environment variables.
 */

'use strict';

const crypto = require('crypto');

const GME_SDK_APP_ID = Number(process.env.GME_SDK_APP_ID || 0);
const GME_SECRET = process.env.GME_SECRET || '';
const AUTH_EXPIRE_TIME = 300; // seconds

// ---------- TEA block cipher ----------

function teaEncryptBlock(v, key) {
  const delta = 0x9e3779b9;
  let v0 = v.readUInt32BE(0);
  let v1 = v.readUInt32BE(4);
  const k0 = key.readUInt32BE(0);
  const k1 = key.readUInt32BE(4);
  const k2 = key.readUInt32BE(8);
  const k3 = key.readUInt32BE(12);

  let sum = 0;
  for (let i = 0; i < 16; i++) {
    sum = (sum + delta) >>> 0;
    v0 = (v0 + ((((v1 << 4) >>> 0) + k0) ^ ((v1 + sum) >>> 0) ^ (((v1 >>> 5) + k1) >>> 0))) >>> 0;
    v1 = (v1 + ((((v0 << 4) >>> 0) + k2) ^ ((v0 + sum) >>> 0) ^ (((v0 >>> 5) + k3) >>> 0))) >>> 0;
  }

  const out = Buffer.alloc(8);
  out.writeUInt32BE(v0, 0);
  out.writeUInt32BE(v1, 4);
  return out;
}

// ---------- XOR 8-byte blocks ----------

function xor8(a, b) {
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) out[i] = a[i] ^ b[i];
  return out;
}

// ---------- QQ TEA CBC encrypt ----------

function qqTeaEncrypt(plaintext, key) {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'utf-8') : key;

  // Padding: (fill_count + len + 7) must be multiple of 8, fill_count >= 2
  const remainder = (plaintext.length + 7 + 2) % 8;
  const fillCount = remainder === 0 ? 2 : 2 + (8 - remainder);

  const padded = Buffer.alloc(fillCount + plaintext.length + 7);
  // First byte: low 3 bits = (fillCount-2), high 5 bits = random
  padded[0] = ((fillCount - 2) & 0x07) | (crypto.randomInt(256) & 0xf8);
  // Random fill bytes
  for (let i = 1; i < fillCount; i++) padded[i] = crypto.randomInt(256);
  // Copy plaintext
  if (Buffer.isBuffer(plaintext)) {
    plaintext.copy(padded, fillCount);
  } else {
    Buffer.from(plaintext).copy(padded, fillCount);
  }
  // Trailing 7 zeros already 0 from alloc

  // CBC encryption
  const ciphertext = [];
  let prePlain = Buffer.alloc(8);
  let preCrypt = Buffer.alloc(8);

  for (let i = 0; i < padded.length; i += 8) {
    const block = padded.subarray(i, i + 8);
    const toEncrypt = xor8(xor8(block, prePlain), preCrypt);
    const encrypted = teaEncryptBlock(toEncrypt, keyBuf);
    ciphertext.push(encrypted);
    prePlain = xor8(block, preCrypt);
    preCrypt = encrypted;
  }

  return Buffer.concat(ciphertext);
}

// ---------- AuthBuffer plaintext builder ----------

function buildAuthBufferPlaintext(userId, roomId, sdkAppId = GME_SDK_APP_ID, expireTime = AUTH_EXPIRE_TIME) {
  const userIdBuf = Buffer.from(userId, 'utf-8');
  const roomIdBuf = Buffer.from(roomId, 'utf-8');

  // Total: 1 + 2 + userLen + 4 + 4 + 4 + 4 + 4 + 2 + roomLen
  const bufLen = 1 + 2 + userIdBuf.length + 4 + 4 + 4 + 4 + 4 + 2 + roomIdBuf.length;
  const buf = Buffer.alloc(bufLen);
  let offset = 0;

  // cVer (1 byte)
  buf.writeUInt8(1, offset); offset += 1;

  // wOpenIDLen (2 bytes BE)
  buf.writeUInt16BE(userIdBuf.length, offset); offset += 2;

  // strOpenID
  userIdBuf.copy(buf, offset); offset += userIdBuf.length;

  // dwSdkAppid (4 bytes BE)
  buf.writeUInt32BE(sdkAppId, offset); offset += 4;

  // dwReserved1 (0)
  buf.writeUInt32BE(0, offset); offset += 4;

  // dwExpTime
  const expTime = Math.floor(Date.now() / 1000) + expireTime;
  buf.writeUInt32BE(expTime, offset); offset += 4;

  // dwReserved2 (0xFFFFFFFF)
  buf.writeUInt32BE(0xFFFFFFFF, offset); offset += 4;

  // dwReserved3 (0)
  buf.writeUInt32BE(0, offset); offset += 4;

  // wRoomIDLen (2 bytes BE)
  buf.writeUInt16BE(roomIdBuf.length, offset); offset += 2;

  // strRoomID
  roomIdBuf.copy(buf, offset);

  return buf;
}

// ---------- Public API ----------

/**
 * Generate GME AuthBuffer as base64 string.
 * @param {string} userId
 * @param {string} roomId
 * @param {{appId?: number, secret?: string}} [credentials] defaults to the env vars
 * @returns {string} base64-encoded auth buffer
 */
function generateAuthBuffer(userId, roomId, { appId = GME_SDK_APP_ID, secret = GME_SECRET } = {}) {
  if (!Number.isSafeInteger(appId) || appId <= 0 || Buffer.byteLength(secret, 'utf8') < 16) {
    throw new Error('GME SDK credentials are not configured in the local environment');
  }
  const keyBuf = Buffer.from(secret, 'utf-8');
  if (keyBuf.length !== 16) throw new Error(`Key must be 16 bytes, got ${keyBuf.length}`);

  const plaintext = buildAuthBufferPlaintext(userId, roomId, appId);
  const ciphertext = qqTeaEncrypt(plaintext, keyBuf);
  return ciphertext.toString('base64');
}

module.exports = { generateAuthBuffer, GME_SDK_APP_ID };
