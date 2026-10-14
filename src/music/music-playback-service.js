'use strict';

const path = require('node:path');
const { MusicQueueService } = require('./music-queue-service');

const FADE_DURATION_MS = 1500;
const FADE_STEP_MS = 100;
const FADE_START_VOLUME = 20;

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertAdapterSuccess(result, fallback) {
  if (result?.ok === false || result?.success === false) throw new Error(fallback);
  return result;
}

class MusicPlaybackService {
  constructor({ requests, downloader, adapter, queue = new MusicQueueService(), getSettings = () => ({}), audioDirectory = path.resolve('./music-cache'), monitorIntervalMs = 1000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
    if (!requests?.resolve || !downloader?.download || !downloader?.release) {
      throw new TypeError('Music requests and an audio downloader are required');
    }
    this.requests = requests;
    this.downloader = downloader;
    this.adapter = adapter || null;
    this.queue = queue;
    this.getSettings = getSettings;
    this.audioDirectory = path.resolve(audioDirectory);
    this.monitorIntervalMs = Math.max(250, Math.min(10000, Number(monitorIntervalMs) || 1000));
    this.attached = false;
    this.status = 'idle';
    this.currentFile = null;
    this.lastError = null;
    this.monitorTimer = null;
    this.polling = false;
    this.startPromise = null;
    this.playbackController = null;
    this.baseVolume = null;
    this.duckMultiplier = 1;
    this.volumeOperation = Promise.resolve();
    this.outputVolume = null;
    this.fadeGeneration = 0;
    this.wait = wait;
    this.now = now;
  }

  snapshot() {
    return {
      status: this.status,
      attached: this.attached,
      queue: this.queue.snapshot(),
      error: this.lastError,
    };
  }

  requireAttached() {
    if (!this.attached || !this.adapter) {
      throw serviceError('AUDIO_ADAPTER_UNAVAILABLE', 'Join a room with a configured GME audio adapter first');
    }
  }

  async attachRoom() {
    if (!this.adapter) throw serviceError('AUDIO_ADAPTER_UNAVAILABLE', 'GME audio adapter is not configured');
    this.attached = true;
    this.status = 'idle';
    this.lastError = null;
    if (!this.monitorTimer) {
      this.monitorTimer = setInterval(() => { void this.pollNow(); }, this.monitorIntervalMs);
      this.monitorTimer.unref?.();
    }
    const next = this.queue.startNext();
    if (next) void this.launch(next).catch(() => {});
    return this.snapshot();
  }

  async request(input, { requestedBy = '', waitForPlayback = true } = {}) {
    this.requireAttached();
    const result = await this.requests.resolve(input, { requestedBy });
    const added = this.queue.add(result.tracks);
    if (!this.queue.current) {
      const starting = this.launch(this.queue.startNext());
      if (waitForPlayback) await starting;
      else void starting.catch(() => {});
    }
    return { added: added.length, source: result.source, skippedCount: result.skippedCount, queue: this.queue.snapshot() };
  }

  async launch(item) {
    if (!item) {
      this.status = this.attached ? 'idle' : 'disconnected';
      return false;
    }
    const operation = this.startTrack(item);
    this.startPromise = operation;
    try { return await operation; }
    finally { if (this.startPromise === operation) this.startPromise = null; }
  }

  async startTrack(item) {
    const generation = item.playbackGeneration;
    const controller = new AbortController();
    this.playbackController = controller;
    this.status = 'downloading';
    this.lastError = null;
    let file = null;
    let adapterMayBePlaying = false;
    try {
      const settings = this.getSettings() || {};
      file = await this.downloader.download(item, {
        directory: this.audioDirectory,
        format: settings.musicFormat || 'm4a',
        maxTrackDurationSeconds: settings.maxTrackDurationSeconds || 3600,
        signal: controller.signal,
      });
      if (!this.queue.isCurrentPlayback(item.queueId, generation)) {
        await this.downloader.release(file);
        return false;
      }
      this.currentFile = file;
      const fadeGeneration = this.cancelFade();
      await this.writeOutputVolume(Math.min(FADE_START_VOLUME, this.targetVolume()), 'GME adapter could not prepare playback fade');
      adapterMayBePlaying = true;
      const result = await this.adapter.play({ file, loop: false });
      assertAdapterSuccess(result, 'GME adapter could not start audio playback');
      if (!this.queue.isCurrentPlayback(item.queueId, generation)) return false;
      if (fadeGeneration === this.fadeGeneration) {
        await this.fadeTo(this.targetVolume(), FADE_DURATION_MS, fadeGeneration);
      }
      if (!this.queue.isCurrentPlayback(item.queueId, generation)) return false;
      this.status = 'playing';
      return true;
    } catch (error) {
      if (adapterMayBePlaying) {
        this.cancelFade();
        await this.adapter.stop().catch(() => {});
      }
      if (file) await this.downloader.release(file).catch(() => {});
      if (!this.queue.isCurrentPlayback(item.queueId, generation)) return false;
      this.currentFile = null;
      this.lastError = 'A track could not be downloaded or started';
      const next = this.queue.failCurrent(item.queueId, generation);
      if (next) return this.launch(next);
      this.status = 'error';
      return false;
    } finally {
      if (this.playbackController === controller) this.playbackController = null;
    }
  }

  async handleTrackEnded(filePath) {
    const endedFile = path.resolve(String(filePath || ''));
    if (!this.currentFile || endedFile !== path.resolve(this.currentFile)) return false;
    const current = this.queue.current;
    if (!current) return false;
    this.currentFile = null;
    this.status = 'transitioning';
    await this.downloader.release(filePath).catch(() => {});
    const next = this.queue.completeCurrent(current.playbackGeneration);
    if (next) return this.launch(next);
    if (this.getSettings()?.autoplay === true && typeof this.requests.resolveAutoplay === 'function') {
      try {
        const tracks = await this.requests.resolveAutoplay(current, { requestedBy: current.requestedBy });
        if (Array.isArray(tracks) && tracks.length > 0) {
          this.queue.add(tracks.slice(0, 1));
          const autoplayTrack = this.queue.startNext();
          if (autoplayTrack) return this.launch(autoplayTrack);
        }
      } catch {
        this.lastError = 'Autoplay could not find a playable YouTube track';
      }
    }
    this.status = 'idle';
    return true;
  }

  async pollNow() {
    if (!this.attached || !this.currentFile || this.polling || !this.adapter?.status) return false;
    this.polling = true;
    try {
      const state = await this.adapter.status();
      if (state?.songFinished !== true) return false;
      if (state.currentFile && path.resolve(String(state.currentFile)) !== path.resolve(this.currentFile)) return false;
      return await this.handleTrackEnded(this.currentFile);
    } catch {
      this.lastError = 'GME adapter status is temporarily unavailable';
      return false;
    } finally {
      this.polling = false;
    }
  }

  async pause() {
    this.requireAttached();
    if (!this.queue.current || this.status !== 'playing') return false;
    assertAdapterSuccess(await this.adapter.pause(), 'GME adapter could not pause playback');
    this.status = 'paused';
    return true;
  }

  async resume() {
    this.requireAttached();
    if (!this.queue.current || this.status !== 'paused') return false;
    assertAdapterSuccess(await this.adapter.resume(), 'GME adapter could not resume playback');
    this.status = 'playing';
    return true;
  }

  async skip() {
    this.requireAttached();
    const current = this.queue.current;
    const next = this.queue.skipCurrent();
    if (!current && !next) return false;
    this.cancelFade();
    const pending = this.startPromise;
    this.playbackController?.abort();
    if (pending) await pending.catch(() => {});
    if (currentFileIsOwned(this.currentFile)) {
      const oldFile = this.currentFile;
      this.currentFile = null;
      await this.fadeTo(0, FADE_DURATION_MS, this.cancelFade()).catch(() => {});
      await this.adapter.stop().catch(() => {});
      await this.downloader.release(oldFile).catch(() => {});
    }
    this.status = this.attached ? 'idle' : 'disconnected';
    return next ? this.launch(next) : true;
  }

  async stop() {
    const oldFile = this.currentFile;
    const pending = this.startPromise;
    this.queue.stop();
    this.cancelFade();
    this.playbackController?.abort();
    if (pending) await pending.catch(() => {});
    this.currentFile = null;
    this.status = this.attached ? 'idle' : 'disconnected';
    if (oldFile && this.adapter) {
      await this.fadeTo(0, FADE_DURATION_MS, this.cancelFade()).catch(() => {});
      await this.adapter.stop().catch(() => {});
      await this.downloader.release(oldFile).catch(() => {});
    }
    return true;
  }

  async setVolume(volume) {
    this.requireAttached();
    const value = Number(volume);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw serviceError('INVALID_VOLUME', 'Music volume must be between 0 and 100');
    const base = Math.round(value);
    this.cancelFade();
    this.baseVolume = base;
    await this.enqueueVolumeUpdate(base, this.duckMultiplier, 'GME adapter could not change volume');
    return base;
  }

  async setDucking(multiplier = 1) {
    this.requireAttached();
    const value = Number(multiplier);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Music ducking must be between 0 and 1');
    const settings = this.getSettings() || {};
    const base = Number.isFinite(this.baseVolume) ? this.baseVolume : Math.max(0, Math.min(100, Number(settings.volume) || 0));
    this.baseVolume = base;
    this.duckMultiplier = value;
    this.cancelFade();
    await this.enqueueVolumeUpdate(base, value, 'GME adapter could not apply speech ducking');
    return value;
  }

  enqueueVolumeUpdate(baseVolume, multiplier, fallback) {
    return this.writeOutputVolume(Math.round(baseVolume * multiplier), fallback);
  }

  writeOutputVolume(volume, fallback = 'GME adapter could not change volume') {
    const target = Math.max(0, Math.min(100, Math.round(volume)));
    const operation = this.volumeOperation.catch(() => {}).then(async () => {
      const response = await this.adapter.setVolume(target);
      assertAdapterSuccess(response, fallback);
      this.outputVolume = target;
    });
    this.volumeOperation = operation.catch(() => {});
    return operation;
  }

  targetVolume() {
    const settings = this.getSettings() || {};
    const base = Number.isFinite(this.baseVolume)
      ? this.baseVolume
      : Math.max(0, Math.min(100, Math.round(Number(settings.volume) || 0)));
    return Math.round(base * this.duckMultiplier);
  }

  cancelFade() {
    this.fadeGeneration += 1;
    return this.fadeGeneration;
  }

  async fadeTo(targetVolume, durationMs = FADE_DURATION_MS, generation = this.cancelFade()) {
    const target = Math.max(0, Math.min(100, Math.round(targetVolume)));
    const start = Number.isFinite(this.outputVolume) ? this.outputVolume : target;
    if (durationMs <= 0 || start === target) {
      if (generation !== this.fadeGeneration) return false;
      await this.writeOutputVolume(target);
      return generation === this.fadeGeneration;
    }
    const steps = Math.max(1, Math.ceil(durationMs / FADE_STEP_MS));
    const stepDurationMs = durationMs / steps;
    const startedAt = this.now();
    for (let step = 1; step <= steps; step += 1) {
      const remainingMs = (stepDurationMs * step) - (this.now() - startedAt);
      if (remainingMs > 0) await this.wait(remainingMs);
      if (generation !== this.fadeGeneration) return false;
      const volume = Math.round(start + ((target - start) * step / steps));
      await this.writeOutputVolume(volume, 'GME adapter could not apply playback fade');
    }
    return generation === this.fadeGeneration;
  }

  async setRoomQuality(quality) {
    this.requireAttached();
    if (!this.adapter.setRoomQuality) throw serviceError('UNSUPPORTED_ROOM_QUALITY', 'GME adapter cannot change room quality');
    assertAdapterSuccess(await this.adapter.setRoomQuality(quality), 'GME adapter could not change room quality');
    return quality;
  }

  setRepeat(enabled) { return this.queue.setRepeat(enabled); }
  setLoop(enabled) { return this.queue.setLoop(enabled); }
  removeUpcoming(position) { return this.queue.removeUpcoming(position); }
  clearUpcoming() { return this.queue.clearUpcoming(); }

  async detachRoom({ stopAdapter = true, preserveQueue = false } = {}) {
    const oldFile = this.currentFile;
    const pending = this.startPromise;
    this.attached = false;
    this.cancelFade();
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    if (preserveQueue) this.queue.suspendCurrent();
    else this.queue.stop();
    this.playbackController?.abort();
    if (pending) await pending.catch(() => {});
    this.currentFile = null;
    this.status = 'disconnected';
    if (oldFile && this.adapter) {
      await this.fadeTo(0, FADE_DURATION_MS, this.cancelFade()).catch(() => {});
      if (stopAdapter) await this.adapter.stop().catch(() => {});
    } else if (stopAdapter && this.adapter) {
      await this.adapter.stop().catch(() => {});
    }
    if (oldFile) await this.downloader.release(oldFile).catch(() => {});
    return true;
  }
}

function currentFileIsOwned(filePath) {
  return typeof filePath === 'string' && filePath.length > 0;
}

module.exports = { FADE_DURATION_MS, MusicPlaybackService };
