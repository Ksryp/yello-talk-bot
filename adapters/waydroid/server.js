#!/usr/bin/env node
'use strict';
/**
 * GME Waydroid Bot adapter.
 *
 * Same HTTP control API as the native C++ / redroid adapters (so the main
 * bot-server's GmeAdapterClient talks to it unchanged), but drives the native
 * GME Android SDK running inside a Waydroid (Android-in-LXC) container.
 *
 *   bot-server ──HTTP──▶ this adapter (:PORT on 127.0.0.1)
 *                           ├─ copy <song> into the mapped Waydroid data dir
 *                           │    (host ~/.local/share/waydroid/data/local/tmp
 *                           │     == container /data/local/tmp)
 *                           └─ `waydroid shell -- nc 127.0.0.1 9099`
 *                                 └▶ GmeBot app (com.gmebot.test) ──▶ GME SDK ──▶ room
 *
 * Why not adb like the redroid adapter? Networked adb to Waydroid over the
 * bridge is unreliable here (shell/sync services stall, state flaps offline),
 * and the app's control port binds container-localhost only (Android drops
 * inbound to it from the bridge). `waydroid shell` (lxc-attach) is the one
 * stable path into the container, so every call goes through it.
 *
 * Usage: node server.js --port 9876 --bot-id <id>
 * Env:
 *   GME_ADAPTER_TOKEN            shared secret with the bot-server (required unless GME_ADAPTER_AUTH_REQUIRED=false)
 *   WAYDROID_APP_PKG             app package (default com.gmebot.test)
 *   WAYDROID_APP_DEVICE_PORT     in-app control port (default 9099)
 *   WAYDROID_DATA_DIR            host path mapped to container /data
 *                                (default ~/.local/share/waydroid/data)
 *   WAYDROID_SHELL               shell command prefix (default "sudo -n waydroid shell --")
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { isAdapterRequestAuthorized } = require('../../src/music/adapter-security');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

const PORT = parseInt(arg('--port', '9876'), 10);
const BOT_ID = arg('--bot-id', 'waydroid-1');
const APP_PKG = process.env.WAYDROID_APP_PKG || 'com.gmebot.test';
const APP_ACTIVITY = `${APP_PKG}/com.gmebot.test.MainActivity`;
// The app derives its device control port from the trailing digits of its
// package name (base package -> 9099), matching the redroid build convention.
const PKG_SUFFIX = (APP_PKG.match(/(\d+)$/) || [, '0'])[1];
const APP_DEVICE_PORT = parseInt(process.env.WAYDROID_APP_DEVICE_PORT || String(9099 + parseInt(PKG_SUFFIX, 10)), 10);
const DATA_DIR = process.env.WAYDROID_DATA_DIR || path.join(os.homedir(), '.local/share/waydroid/data');
const DEVICE_TMP = '/data/local/tmp';
const SONG_BASENAME = `gmesong${PKG_SUFFIX}`;
const SHELL = (process.env.WAYDROID_SHELL || 'sudo -n waydroid shell --').split(/\s+/);
const ADAPTER_TOKEN = String(process.env.GME_ADAPTER_TOKEN || '').trim();
const ADAPTER_AUTH_REQUIRED = process.env.GME_ADAPTER_AUTH_REQUIRED !== 'false';

function log(m) { console.log(`[${BOT_ID}] ${m}`); }

// Run a command inside the Waydroid container. `input` (if given) is written to
// stdin. Resolves with { code, stdout, stderr } and never rejects.
function containerExec(argv, { input = null, timeout = 28000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(SHELL[0], SHELL.slice(1).concat(argv), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeout);
    child.stdout.on('data', (c) => { stdout = Buffer.concat([stdout, c]); });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.toString('utf8'), stderr }); });
    if (input != null) { child.stdin.write(input); }
    child.stdin.end();
  });
}

// Speak the app's tiny HTTP control protocol over `nc 127.0.0.1 <devport>`.
// The app reads one request line + headers + Content-Length body and answers
// with `Connection: close`, so nc returns the whole response then exits.
async function appCall(method, path_, body) {
  const data = body ? JSON.stringify(body) : '';
  const req = data
    ? `${method} ${path_} HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`
    : `${method} ${path_} HTTP/1.0\r\n\r\n`;
  const r = await containerExec(['nc', '127.0.0.1', String(APP_DEVICE_PORT)], { input: req });
  const sep = r.stdout.indexOf('\r\n\r\n');
  const payload = sep >= 0 ? r.stdout.slice(sep + 4) : r.stdout;
  try { return JSON.parse(payload || '{}'); }
  catch (_) { throw new Error(`app ${method} ${path_} returned non-JSON (code ${r.code}): ${(payload || r.stderr || '').slice(0, 200)}`); }
}

// Make sure the app is running and its control server answers. `fresh`
// force-restarts it so it never carries a stale room.
async function ensureApp(fresh) {
  if (fresh) { await containerExec(['am', 'force-stop', APP_PKG]); await new Promise(r => setTimeout(r, 500)); }
  await containerExec(['am', 'start', '-n', APP_ACTIVITY]);
  for (let i = 0; i < 40; i++) {
    try { await appCall('GET', '/status'); return true; } catch (_) { await new Promise(r => setTimeout(r, 500)); }
  }
  return false;
}

// Copy a host audio file into the container by writing it into the mapped data
// directory. `sudo cp` preserves nothing we need; the app only reads the file.
async function pushSong(hostFile, ext) {
  const deviceFile = `${DEVICE_TMP}/${SONG_BASENAME}${ext}`;
  const hostTarget = path.join(DATA_DIR, 'local/tmp', `${SONG_BASENAME}${ext}`);
  const r = await containerExec(['sh', '-c', `cat > '${deviceFile}' && chmod 644 '${deviceFile}'`], {
    input: fs.readFileSync(hostFile), timeout: 60000,
  });
  if (r.code !== 0) throw new Error(`push failed (code ${r.code}): ${r.stderr.slice(0, 200)}`);
  return { deviceFile, hostTarget };
}

let state = { currentFile: null, loop: false };
let lastVol = 25; // GME native scale 0-200; the app resets its field to 100 on restart
let songPoll = null;

function startSongPoll() {
  if (songPoll) return;
  songPoll = setInterval(async () => {
    try {
      const s = await appCall('GET', '/status');
      if (s && s.songFinished && state.currentFile) {
        const f = state.currentFile; state.currentFile = null;
        log(`song finished: ${f}`);
      }
    } catch (_) { /* app briefly unreachable */ }
  }, 1000);
}

const server = http.createServer((req, res) => {
  if (ADAPTER_AUTH_REQUIRED && !isAdapterRequestAuthorized(req, ADAPTER_TOKEN, { required: true })) {
    res.statusCode = ADAPTER_TOKEN ? 401 : 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('WWW-Authenticate', 'GME-Adapter');
    return res.end(JSON.stringify({ ok: false, error: ADAPTER_TOKEN ? 'Invalid GME adapter token' : 'GME adapter authentication is not configured' }));
  }
  const u = url.parse(req.url, true);
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    let j = {}; try { if (body) j = JSON.parse(body); } catch (_) {}
    res.setHeader('Content-Type', 'application/json');
    try {
      if (u.pathname === '/status') {
        let s = {}; try { s = await appCall('GET', '/status'); } catch (_) {}
        return res.end(JSON.stringify({ botId: BOT_ID, adapter: 'android-waydroid', protocolVersion: 2, status: s.status || 'idle', room: s.room, user: null, currentFile: s.currentFile, loop: state.loop, volume: s.volume, roomType: s.roomType, roomQuality: s.roomQuality, inRoom: s.inRoom, songFinished: s.songFinished, error: s.error }));
      }
      if (u.pathname === '/capabilities') {
        return res.end(JSON.stringify({
          botId: BOT_ID, adapter: 'android-waydroid', protocolVersion: 2, sdkVersion: 'android-native',
          authenticated: ADAPTER_AUTH_REQUIRED ? !!ADAPTER_TOKEN : true,
          features: { status: true, health: true, playMusic: true, effects: false, roomQuality: true },
          endpoints: ['/status', '/health', '/capabilities', '/join', '/play', '/stop', '/pause', '/resume', '/volume', '/room-quality', '/leave'],
          notes: ['Android SDK control is reached through `waydroid shell -- nc` into the container.'],
        }));
      }
      if (u.pathname === '/health') {
        let s = {}; try { s = await appCall('GET', '/status'); } catch (_) {}
        return res.end(JSON.stringify({
          botId: BOT_ID, adapter: 'android-waydroid', state: s.inRoom ? 'ready' : 'idle', reachable: true, ready: true,
          inRoom: !!s.inRoom, playing: s.status === 'playing', room: s.room || null, audioEnabled: !!s.inRoom,
          audioEvidence: 'unknown', lastAudioAtMs: null, audioSilenceMs: null, audioEmpty: null, reconnecting: false,
          lastError: s.error || null, observedAtMs: Date.now(),
        }));
      }
      if (u.pathname === '/join' && req.method === 'POST') {
        const { room, user } = j;
        if (!room || !user) return res.end(JSON.stringify({ error: 'room and user required' }));
        await ensureApp(true);
        log(`join room=${room} user=${user}`);
        // GME's auth identifier MUST equal the Init openId (= user). Always auth as `user`.
        const r = await appCall('POST', '/join', { room: String(room), user: String(user), uuid: String(user) });
        if (r.inRoom) startSongPoll();
        return res.end(JSON.stringify({ ok: !!r.inRoom, inRoom: !!r.inRoom, status: r.status, room, user, error: r.error }));
      }
      if (u.pathname === '/play' && req.method === 'POST') {
        const host = j.file;
        if (!host || !fs.existsSync(host)) return res.end(JSON.stringify({ error: 'file not found: ' + host }));
        const ext = (path.extname(host) || '.mp3').toLowerCase();
        log(`play ${host} (loop=${!!j.loop})`);
        let pushed;
        try { pushed = await pushSong(host, ext); } catch (e) { return res.end(JSON.stringify({ error: e.message })); }
        state.currentFile = host; state.loop = !!j.loop;
        const r = await appCall('POST', '/play', { file: pushed.deviceFile, loop: !!j.loop });
        try { await appCall('POST', '/volume', { vol: lastVol }); } catch (_) {}
        log(`play -> ${APP_PKG} startRc=${r.startRc} ok=${r.ok} vol=${lastVol}`);
        return res.end(JSON.stringify({ ok: !!r.ok, status: 'playing', file: host, startRc: r.startRc }));
      }
      if (['/stop', '/pause', '/resume', '/leave'].includes(u.pathname) && req.method === 'POST') {
        if (u.pathname === '/leave') state.currentFile = null;
        const r = await appCall('POST', u.pathname, {});
        return res.end(JSON.stringify(r));
      }
      if (u.pathname === '/volume' && req.method === 'POST') {
        const vv = parseInt(j.vol, 10);
        if (!isNaN(vv)) lastVol = Math.max(0, Math.min(200, vv));
        const r = await appCall('POST', '/volume', { vol: lastVol });
        return res.end(JSON.stringify({ ...r, vol: lastVol }));
      }
      if (u.pathname === '/room-quality' && req.method === 'POST') {
        const quality = String(j.quality || '').toLowerCase();
        if (!['fluency', 'standard', 'highquality'].includes(quality)) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ success: false, error: 'quality must be fluency, standard, or highquality' }));
        }
        const r = await appCall('POST', '/room-quality', { quality });
        if (r && r.success === false) res.statusCode = 409;
        return res.end(JSON.stringify(r));
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'unknown endpoint' }));
    } catch (e) {
      res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.on('error', (e) => { log('HTTP server error: ' + e.message); });

ensureApp()
  .then((ok) => server.listen(PORT, '127.0.0.1', () => log(`waydroid adapter listening on ${PORT} -> ${APP_PKG} (container nc :${APP_DEVICE_PORT}, app ${ok ? 'ready' : 'not ready yet'})`)))
  .catch((e) => { log('ensureApp failed: ' + e.message); server.listen(PORT, '127.0.0.1', () => log(`waydroid adapter listening on ${PORT} (app not ready yet)`)); });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
