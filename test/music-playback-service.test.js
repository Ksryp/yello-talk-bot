'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MusicPlaybackService } = require('../src/music/music-playback-service');

const trackA = { videoId: 'aaaaaaaaaaa', title: 'A', durationSeconds: 60, url: 'https://youtube.test/a' };
const trackB = { videoId: 'bbbbbbbbbbb', title: 'B', durationSeconds: 70, url: 'https://youtube.test/b' };

function fixture({ tracks = [trackA, trackB], download = async item => `C:\\music-cache\\${item.videoId}.m4a`, settings = {}, autoplayTracks = [], wait = async () => {} } = {}) {
  const calls = { resolved: [], downloads: [], released: [], played: [], adapter: [], volumes: [], fadeWaits: [], lifecycle: [], order: [] };
  let adapterStatus = {};
  let fakeNow = 0;
  const service = new MusicPlaybackService({
    requests: {
      async resolve(input, options) {
        calls.resolved.push({ input, options });
        return { tracks: tracks.slice(0, input === 'one' ? 1 : tracks.length), source: 'search', skippedCount: 0 };
      },
      async resolveAutoplay(item, options) {
        calls.resolved.push({ input: 'autoplay', item, options });
        return autoplayTracks;
      },
    },
    downloader: {
      async download(item, options) { calls.downloads.push({ item, options }); return download(item, options); },
      async release(file) { calls.released.push(file); calls.lifecycle.push(`release:${file}`); calls.order.push(`release:${file}`); return true; },
    },
    adapter: {
      async play(value) { calls.played.push(value); calls.lifecycle.push(`play:${value.file}`); calls.order.push(`play:${value.file}`); return { ok: true }; },
      async status() { return adapterStatus; },
      async stop() { calls.adapter.push('stop'); calls.lifecycle.push('stop'); calls.order.push('stop'); return { ok: true }; },
      async pause() { calls.adapter.push('pause'); return { ok: true }; },
      async resume() { calls.adapter.push('resume'); return { ok: true }; },
      async setVolume(value) { calls.volumes.push(value); calls.order.push(`volume:${value}`); return { ok: true }; },
    },
    getSettings: () => ({ musicFormat: 'm4a', maxTrackDurationSeconds: 3600, volume: 80, ...settings }),
    monitorIntervalMs: 10000,
    wait: async ms => { calls.fadeWaits.push(ms); fakeNow += ms; await wait(ms); },
    now: () => fakeNow,
  });
  return { service, calls, setAdapterStatus(value) { adapterStatus = value; } };
}

test('requires an attached music adapter and starts a validated resolved request', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.request('one'), { code: 'AUDIO_ADAPTER_UNAVAILABLE' });
  assert.equal(calls.resolved.length, 0);
  await service.attachRoom();
  const response = await service.request('one', { requestedBy: 'Owner' });
  assert.equal(response.added, 1);
  assert.equal(service.snapshot().status, 'playing');
  assert.equal(service.snapshot().queue.current.title, 'A');
  assert.equal('file' in service.snapshot().queue.current, false);
  assert.equal(calls.downloads[0].options.format, 'm4a');
  assert.deepEqual(calls.played, [{ file: 'C:\\music-cache\\aaaaaaaaaaa.m4a', loop: false }]);
  await service.detachRoom();
});

test('can detach for room recovery while preserving and restarting the current item from the beginning', async () => {
  const { service, calls } = fixture();
  await service.attachRoom();
  await service.request('all');
  const firstFile = calls.played[0].file;
  await service.detachRoom({ preserveQueue: true });
  assert.equal(service.snapshot().status, 'disconnected');
  assert.equal(service.snapshot().queue.current, null);
  assert.deepEqual(service.snapshot().queue.upcoming.map(item => item.title), ['A', 'B']);
  assert.deepEqual(calls.released, [firstFile]);

  await service.attachRoom();
  for (let attempt = 0; attempt < 5 && calls.played.length < 2; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls.played.length, 2);
  assert.equal(service.snapshot().queue.current.title, 'A');
  assert.deepEqual(calls.played[1], { file: firstFile, loop: false });
  await service.detachRoom();
});

test('polling a finished track releases its file and advances in queue order', async () => {
  const { service, calls, setAdapterStatus } = fixture();
  await service.attachRoom();
  await service.request('all');
  setAdapterStatus({ songFinished: true, currentFile: 'C:\\music-cache\\aaaaaaaaaaa.m4a' });
  assert.equal(await service.pollNow(), true);
  assert.equal(service.snapshot().queue.current.title, 'B');
  assert.deepEqual(calls.released, ['C:\\music-cache\\aaaaaaaaaaa.m4a']);
  assert.equal(calls.played.length, 2);
  await service.detachRoom();
});

test('stops the adapter before releasing the active file from its session cache', async () => {
  const { service, calls } = fixture({ tracks: [trackA], settings: { fadeDurationMs: 9000 } });
  await service.attachRoom();
  await service.request('one');
  const activeFile = calls.played[0].file;

  assert.deepEqual(calls.fadeWaits.slice(0, 15), Array(15).fill(100));
  assert.equal(calls.volumes[0], 20);
  assert.equal(calls.volumes[15], 80);

  await service.stop();

  assert.deepEqual(calls.lifecycle, [`play:${activeFile}`, 'stop', `release:${activeFile}`]);
  assert.deepEqual(calls.fadeWaits.slice(15), Array(15).fill(100));
  assert.equal(calls.volumes.at(-1), 0);
  assert.ok(calls.order.lastIndexOf('volume:0') < calls.order.indexOf('stop'));
  assert.deepEqual(calls.order.slice(-2), ['stop', `release:${activeFile}`]);
  await service.detachRoom();
});

test('room detach fades and stops the adapter before releasing the active file', async () => {
  const { service, calls } = fixture({ tracks: [trackA] });
  await service.attachRoom();
  await service.request('one');
  const activeFile = calls.played[0].file;
  calls.order.length = 0;

  await service.detachRoom();

  assert.deepEqual(calls.order.slice(-3), ['volume:0', 'stop', `release:${activeFile}`]);
  assert.equal(service.snapshot().status, 'disconnected');
});

test('skip fades out and releases the old track before starting the next track', async () => {
  const { service, calls } = fixture();
  await service.attachRoom();
  await service.request('all');
  const oldFile = calls.played[0].file;
  calls.order.length = 0;
  calls.volumes.length = 0;
  calls.fadeWaits.length = 0;

  await service.skip();

  assert.equal(service.snapshot().queue.current.title, 'B');
  assert.deepEqual(calls.fadeWaits.slice(0, 15), Array(15).fill(100));
  assert.deepEqual(calls.order.slice(14, 18), ['volume:0', 'stop', `release:${oldFile}`, 'volume:20']);
  assert.equal(calls.order.findIndex(item => item.startsWith('play:')), 18);
});

test('music volume changes cancel a pending fade and retain the latest requested level', async () => {
  let releaseFadeStep;
  let markFadeStepEntered;
  let blockFirstFadeStep = true;
  const fadeStepEntered = new Promise(resolve => { markFadeStepEntered = resolve; });
  const { service, calls } = fixture({
    tracks: [trackA],
    wait: async () => {
      if (!blockFirstFadeStep) return;
      blockFirstFadeStep = false;
      markFadeStepEntered();
      await new Promise(resolve => { releaseFadeStep = resolve; });
    },
  });
  await service.attachRoom();
  const request = service.request('one', { waitForPlayback: false });
  await fadeStepEntered;
  const starting = service.startPromise;
  await service.setVolume(41);
  releaseFadeStep();
  await Promise.all([request, starting]);

  assert.deepEqual(calls.volumes, [20, 41]);
  assert.equal(service.snapshot().status, 'playing');
  await service.detachRoom();
});

test('repeat restarts the same item while loop rotates it behind queued tracks', async () => {
  const repeat = fixture({ tracks: [trackA] });
  await repeat.service.attachRoom();
  await repeat.service.request('one');
  repeat.service.setRepeat(true);
  await repeat.service.handleTrackEnded(repeat.calls.played[0].file);
  assert.equal(repeat.service.snapshot().queue.current.title, 'A');
  assert.equal(repeat.calls.played.length, 2);
  await repeat.service.detachRoom();

  const loop = fixture();
  await loop.service.attachRoom();
  await loop.service.request('all');
  loop.service.setLoop(true);
  await loop.service.handleTrackEnded(loop.calls.played[0].file);
  assert.equal(loop.service.snapshot().queue.current.title, 'B');
  await loop.service.handleTrackEnded(loop.calls.played[1].file);
  assert.equal(loop.service.snapshot().queue.current.title, 'A');
  await loop.service.detachRoom();
});

test('autoplay adds one guarded mix candidate only after the current queue ends', async () => {
  const { service, calls } = fixture({
    tracks: [{ ...trackA, requestedBy: 'Listener' }],
    settings: { autoplay: true },
    autoplayTracks: [{ ...trackB, source: 'autoplay', requestedBy: 'Listener' }],
  });
  await service.attachRoom();
  await service.request('one', { requestedBy: 'Listener' });
  const firstFile = calls.played[0].file;
  await service.handleTrackEnded(firstFile);
  assert.equal(service.snapshot().queue.current.videoId, trackB.videoId);
  assert.equal(service.snapshot().queue.current.source, 'autoplay');
  assert.equal(calls.resolved[1].options.requestedBy, 'Listener');
  await service.detachRoom();
});

test('repeat precedes loop, queued tracks precede autoplay, and autoplay runs last', async () => {
  const autoplayTrack = { ...trackB, videoId: 'ccccccccccc', title: 'Autoplay', source: 'autoplay' };
  const { service, calls } = fixture({
    settings: { autoplay: true },
    autoplayTracks: [autoplayTrack],
  });
  await service.attachRoom();
  await service.request('all');
  service.setRepeat(true);
  service.setLoop(true);

  await service.handleTrackEnded(calls.played[0].file);
  assert.equal(service.snapshot().queue.current.title, 'A');
  assert.deepEqual(service.snapshot().queue.upcoming.map(item => item.title), ['B']);
  assert.equal(calls.resolved.some(item => item.input === 'autoplay'), false);

  service.setRepeat(false);
  await service.handleTrackEnded(calls.played[1].file);
  assert.equal(service.snapshot().queue.current.title, 'B');
  assert.deepEqual(service.snapshot().queue.upcoming.map(item => item.title), ['A']);

  service.setLoop(false);
  await service.handleTrackEnded(calls.played[2].file);
  assert.equal(service.snapshot().queue.current.title, 'A');
  assert.deepEqual(service.snapshot().queue.upcoming, []);

  await service.handleTrackEnded(calls.played[3].file);
  assert.equal(service.snapshot().queue.current.title, 'Autoplay');
  assert.equal(calls.resolved.at(-1).input, 'autoplay');
  await service.detachRoom();
});

test('skipping during download aborts the stale request and starts only the next track', async () => {
  let firstDownloadStarted;
  const started = new Promise(resolve => { firstDownloadStarted = resolve; });
  const { service, calls } = fixture({
    download: async (item, { signal }) => {
      if (item.videoId === trackA.videoId) {
        firstDownloadStarted();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      }
      return 'C:\\music-cache\\bbbbbbbbbbb.m4a';
    },
  });
  await service.attachRoom();
  const request = service.request('all');
  await started;
  const skip = service.skip();
  await Promise.all([request, skip]);
  assert.equal(service.snapshot().queue.current.title, 'B');
  assert.deepEqual(calls.played, [{ file: 'C:\\music-cache\\bbbbbbbbbbb.m4a', loop: false }]);
  await service.detachRoom();
});

test('a track failure is discarded rather than looped forever and stop clears state', async () => {
  const { service, calls } = fixture({
    download: async item => {
      if (item.videoId === trackA.videoId) throw new Error('network failure');
      return 'C:\\music-cache\\bbbbbbbbbbb.m4a';
    },
  });
  await service.attachRoom();
  service.setRepeat(true);
  service.setLoop(true);
  await service.request('all');
  assert.equal(service.snapshot().status, 'playing');
  assert.equal(service.snapshot().queue.current.title, 'B');
  await service.stop();
  assert.equal(service.snapshot().queue.length, 0);
  assert.equal(service.snapshot().status, 'idle');
  assert.deepEqual(calls.adapter, ['stop']);
  await service.detachRoom();
});

test('pause, resume, and volume delegate only when a room is attached', async () => {
  const { service, calls } = fixture({ tracks: [trackA] });
  await service.attachRoom();
  await service.request('one');
  assert.equal(await service.pause(), true);
  assert.equal(await service.resume(), true);
  assert.equal(await service.setVolume(62), 62);
  await assert.rejects(service.setVolume(101), { code: 'INVALID_VOLUME' });
  assert.deepEqual(calls.adapter, ['pause', 'resume']);
  assert.equal(calls.volumes.at(-1), 62);
  await service.detachRoom();
});

test('music volume changes remain relative to the persistent base during TTS ducking', async () => {
  const { service, calls } = fixture();
  await service.attachRoom();
  await service.setDucking(0.3);
  assert.equal(await service.setVolume(51), 51);
  await service.setDucking(1);
  assert.deepEqual(calls.volumes, [24, 15, 51]);
  await service.detachRoom();
});
