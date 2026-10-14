'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const axios = require('axios');
const cors = require('cors');
const express = require('express');
const { io } = require('socket.io-client');
const { ensureLocalConfig, normalizeConfig, saveLocalConfig } = require('./src/config/public-config');
const { ensureOwnerToken, ownerTokenMiddleware } = require('./src/http/owner-token');
const { normalizeOrigin, originIsAllowed } = require('./src/http/network-policy');
const { isPrivateLanAddress } = require('./src/http/network-policy');
const { MusicCommandDispatcher } = require('./src/commands/music-command-dispatcher');
const { AzureSpeechClient, validateVoice } = require('./src/tts/azure-speech-client');
const { TtsPlaybackService } = require('./src/tts/tts-playback-service');
const { GroqChatClient } = require('./src/ai/groq-chat-client');
const { RoomReplyService } = require('./src/ai/room-reply-service');
const { ParticipantGreetingService } = require('./src/yellotalk/participant-greeting-service');
const { GmeAdapterClient } = require('./src/music/gme-adapter-client');
const { MusicPlaybackService } = require('./src/music/music-playback-service');
const { MusicQueueService } = require('./src/music/music-queue-service');
const { MusicRequestService } = require('./src/music/music-request-service');
const { YtDlpClient } = require('./src/music/yt-dlp-client');
const { YelloTalkApiClient } = require('./src/yellotalk/api-client');
const { YelloTalkRoomSession } = require('./src/yellotalk/room-session');
const { RoomChatService } = require('./src/yellotalk/room-chat-service');
const { RoomRecoveryController } = require('./src/yellotalk/room-recovery-controller');
const { createChatRouter } = require('./src/http/chat-router');
const { createMusicRouter } = require('./src/http/music-router');
const { createRoomRouter } = require('./src/http/room-router');
const { createSettingsRouter } = require('./src/http/settings-router');

function createApp({ configPath, tokenPath, logger = console, apiClient, roomSession, musicAdapter, musicPlayback, youtubeProvider, groqChatClient: injectedGroqChatClient, createSocket = io, recoveryDelaysMs } = {}) {
  const resolvedConfigPath = path.resolve(configPath || process.env.YMB_CONFIG_PATH || './config.local.json');
  const resolvedTokenPath = path.resolve(tokenPath || process.env.YMB_OWNER_TOKEN_PATH || './owner-token.txt');
  const local = ensureLocalConfig(resolvedConfigPath);
  let config = local.config;
  const saveConfig = next => {
    config = saveLocalConfig(resolvedConfigPath, normalizeConfig(next));
    return config;
  };
  const ownerToken = ensureOwnerToken(resolvedTokenPath);
  const app = express();
  const ownerAuth = ownerTokenMiddleware(ownerToken);
  const yellotalkApi = apiClient || new YelloTalkApiClient({ http: axios });
  const gmeAdapter = musicAdapter || (config.adapter.token
    ? new GmeAdapterClient({ http: axios, baseUrl: config.adapter.baseUrl, token: config.adapter.token })
    : null);
  const youtube = youtubeProvider || new YtDlpClient({ execFile });
  const musicRequests = new MusicRequestService({ youtube, getSettings: () => config.settings });
  const queue = new MusicQueueService();
  queue.setRepeat(config.settings.repeat);
  queue.setLoop(config.settings.loop);
  const playback = musicPlayback || new MusicPlaybackService({
    requests: musicRequests,
    downloader: youtube,
    adapter: gmeAdapter,
    queue,
    getSettings: () => config.settings,
    audioDirectory: path.resolve(process.env.YMB_MUSIC_CACHE_DIR || './music-cache'),
  });
  const speechClient = config.azureTts.subscriptionKey && config.azureTts.region
    ? new AzureSpeechClient({ http: axios, subscriptionKey: config.azureTts.subscriptionKey, region: config.azureTts.region })
    : null;
  const audioDirectory = path.resolve(process.env.YMB_MUSIC_CACHE_DIR || './music-cache');
  const ttsPlayback = gmeAdapter && typeof gmeAdapter.playEffect === 'function'
    && typeof gmeAdapter.stopEffect === 'function' && typeof playback.setDucking === 'function'
    ? new TtsPlaybackService({
      speech: speechClient,
      adapter: gmeAdapter,
      playback,
      getSettings: () => config.settings,
      getOwnUuid: () => config.account.userUuid,
      audioDirectory,
    })
    : null;
  let groqChatClient = injectedGroqChatClient || null;
  if (!groqChatClient && config.groq.apiKey && config.groq.model) {
    try { groqChatClient = new GroqChatClient({ apiKey: config.groq.apiKey, model: config.groq.model }); }
    catch { groqChatClient = null; }
  }
  const persistCommandSettings = async patch => {
    if (patch.ttsEnabled === true && config.settings.ttsEnabled !== true) {
      if (!speechClient) throw Object.assign(new Error('Azure TTS is not configured'), { code: 'TTS_NOT_CONFIGURED' });
      if (!ttsPlayback || typeof gmeAdapter?.assertTtsCapabilities !== 'function') {
        throw Object.assign(new Error('The audio adapter cannot play speech effects'), { code: 'TTS_NOT_SUPPORTED' });
      }
      try { await gmeAdapter.assertTtsCapabilities(); }
      catch { throw Object.assign(new Error('The audio adapter cannot play speech effects'), { code: 'TTS_NOT_SUPPORTED' }); }
    }
    saveConfig({
      ...config,
      settings: { ...config.settings, ...patch },
    });
    playback.setRepeat(config.settings.repeat);
    playback.setLoop(config.settings.loop);
    await ttsPlayback?.applySettings(patch);
  };
  let commandDispatcher;
  let roomReplyService;
  let participantGreetingService;
  let roomChatService;
  let roomRecoveryController;
  let lastJoinedRoom = null;
  let shutdownPromise = null;
  const session = roomSession || new YelloTalkRoomSession({
    createSocket,
    onMessage: data => {
      roomChatService?.handleIncoming(data);
      if (commandDispatcher) void commandDispatcher.handle(data).catch(() => {});
      try { ttsPlayback?.handleMessage(data); } catch {}
      if (roomReplyService) void roomReplyService.handleMessage(data).catch(() => {});
    },
    onSpeakerStatus: status => {
      if (status?.joined) console.log(`[seat] bot took speaker position ${status.position}`);
      else if (status?.joining) console.log(`[seat] requesting speaker position ${Number(status.position) + 1}`);
      else console.log('[seat] bot is not on a speaker seat');
    },
    onParticipantEvent: event => {
      if (event?.type === 'join' || event?.type === 'leave') {
        const verb = event.type === 'join' ? 'joined' : 'left';
        console.log(`[room] ${event.displayName || event.uuid || 'someone'} ${verb} the room`);
      }
      if (participantGreetingService) void participantGreetingService.handleParticipantEvent(event).catch(() => {});
    },
    onManualLeave: async () => {
      roomChatService?.clear();
      lastJoinedRoom = null;
      await ttsPlayback?.stopAll();
      const playbackState = playback.snapshot();
      if (playbackState.attached) return playback.detachRoom({ stopAdapter: true });
      if (playbackState.queue?.length > 0) return playback.stop();
      return true;
    },
    onRoomEnded: () => {
      roomChatService?.clear();
      lastJoinedRoom = null;
      void (async () => {
        await ttsPlayback?.stopAll();
        await playback.detachRoom();
      })().catch(() => {});
    },
    onConnectionLost: (_reason, metadata = {}) => {
      roomChatService?.clear();
      void (async () => {
        try { await ttsPlayback?.stopAll(); } catch {}
        try { await playback.detachRoom({ preserveQueue: true }); } catch {}
        try { await gmeAdapter?.leave(); } catch {}
        if (lastJoinedRoom?.id === metadata.roomId) roomRecoveryController?.start(metadata.roomId);
      })().catch(() => {});
    },
  });
  roomChatService = new RoomChatService({
    sendMessage: message => {
      if (typeof session.sendMessage !== 'function') throw new Error('Room message sending is unavailable');
      return session.sendMessage(message);
    },
    getOwnUuid: () => config.account.userUuid,
    getOwnName: () => config.account.displayName,
  });
  participantGreetingService = new ParticipantGreetingService({
    sendMessage: message => {
      if (typeof session.sendMessage !== 'function') throw new Error('Room message sending is unavailable');
      return session.sendMessage(message);
    },
    getSettings: () => config.settings,
    getOwnUuid: () => config.account.userUuid,
  });
  commandDispatcher = new MusicCommandDispatcher({
    playback,
    sendMessage: message => {
      if (typeof session.sendMessage !== 'function') throw new Error('Room message sending is unavailable');
      return session.sendMessage(message);
    },
    getSettings: () => config.settings,
    getOwnUuid: () => config.account.userUuid,
    isTtsConfigured: () => Boolean(speechClient),
    onSettingsChange: persistCommandSettings,
  });
  if (groqChatClient) {
    roomReplyService = new RoomReplyService({
      client: groqChatClient,
      sendMessage: message => {
        if (typeof session.sendMessage !== 'function') throw new Error('Room message sending is unavailable');
        return session.sendMessage(message);
      },
      getConfig: () => config,
      getOwnUuid: () => config.account.userUuid,
      speakReply: message => ttsPlayback?.speakReply(message) || false,
    });
  }
  const hasLocalAccount = () => Boolean(config.account.jwtToken && config.account.userUuid && config.account.displayName);
  const roomActionLock = { pending: false };

  roomRecoveryController = new RoomRecoveryController({
    delaysMs: recoveryDelaysMs,
    recover: async (roomId, isCurrent) => {
      if (!isCurrent()) return false;
      if (roomActionLock.pending) throw new Error('A room action is already in progress');
      roomActionLock.pending = true;
      try {
        const room = await yellotalkApi.getRoom(config.account.jwtToken, roomId);
        if (!room || !isCurrent()) throw new Error('The previous room is unavailable');
        const connected = await session.join({ account: config.account, room, preserveQueue: true });
        if (!isCurrent()) {
          await session.leave({ preserveQueue: true }).catch(() => {});
          return false;
        }
        if (gmeAdapter) {
          try {
            if (typeof gmeAdapter.assertMusicCapabilities === 'function') await gmeAdapter.assertMusicCapabilities();
            if (config.settings.ttsEnabled) {
              if (!speechClient || typeof gmeAdapter.assertTtsCapabilities !== 'function') throw new Error('Speech effects are unavailable');
              await gmeAdapter.assertTtsCapabilities();
            }
            await gmeAdapter.join({ room: room.gmeId, user: config.account.userUuid, uuid: config.account.userUuid });
            await gmeAdapter.setVolume(config.settings.volume);
            await gmeAdapter.setRoomQuality(config.settings.roomQuality);
            await playback.attachRoom();
          } catch (error) {
            await playback.detachRoom({ preserveQueue: true }).catch(() => {});
            await gmeAdapter.leave().catch(() => {});
            await session.leave({ preserveQueue: true }).catch(() => {});
            throw error;
          }
        }
        lastJoinedRoom = room;
        return connected;
      } finally {
        roomActionLock.pending = false;
      }
    },
  });

  async function joinResolvedRoom(room, { createRoom = false, preserveQueue = false } = {}) {
    const previousRoom = session.snapshot();
    const previousRoomId = previousRoom.roomId || lastJoinedRoom?.id || null;
    const preserveQueueOnFailure = preserveQueue || (previousRoom.status === 'disconnected'
      && lastJoinedRoom?.id === room.id
      && playback.snapshot().queue.length > 0);
    if (previousRoomId && previousRoomId !== room.id) {
      await ttsPlayback?.stopAll();
      await playback.detachRoom({ stopAdapter: true, preserveQueue });
      if (gmeAdapter) {
        await gmeAdapter.leave().catch(() => {});
      }
    }
    const joinOptions = { account: config.account, room };
    if (createRoom) joinOptions.createRoom = true;
    if (preserveQueue) joinOptions.preserveQueue = true;
    const connected = await session.join(joinOptions);
    lastJoinedRoom = room;
    if (gmeAdapter) {
      try {
        if (typeof gmeAdapter.assertMusicCapabilities === 'function') await gmeAdapter.assertMusicCapabilities();
        if (config.settings.ttsEnabled) {
          if (!speechClient || typeof gmeAdapter.assertTtsCapabilities !== 'function') throw new Error('TTS is enabled but Azure or speech-effect support is unavailable');
          await gmeAdapter.assertTtsCapabilities();
        }
        await gmeAdapter.join({ room: room.gmeId, user: config.account.userUuid, uuid: config.account.userUuid });
        await gmeAdapter.setVolume(config.settings.volume);
        await gmeAdapter.setRoomQuality(config.settings.roomQuality);
        await playback.attachRoom();
      } catch (error) {
        await playback.detachRoom({ preserveQueue: preserveQueueOnFailure }).catch(() => {});
        await gmeAdapter.leave().catch(() => {});
        await session.leave({ preserveQueue: preserveQueueOnFailure }).catch(() => {});
        throw new Error(`GME audio adapter could not join the room: ${String(error?.message || 'request failed').slice(0, 160)}`);
      }
    }
    lastJoinedRoom = room;
    return connected;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      roomRecoveryController.cancel();
      while (roomActionLock.pending) await new Promise(resolve => setTimeout(resolve, 25));
      roomChatService.clear();
      try { await ttsPlayback?.stopAll(); } catch {}
      const wasAttached = playback.snapshot().attached;
      try { await playback.detachRoom({ stopAdapter: true }); } catch {}
      if (gmeAdapter && (lastJoinedRoom || wasAttached)) {
        try { await gmeAdapter.leave(); } catch {}
      }
      try { await session.leave(); } catch {}
      lastJoinedRoom = null;
      return true;
    })();
    return shutdownPromise;
  }

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      let parsed;
      try { parsed = new URL(origin); } catch { return callback(new Error('Origin is not permitted')); }
      const explicitlyAllowed = config.portalAllowedOrigins.some(value => normalizeOrigin(value) === normalizeOrigin(origin));
      const localPortal = parsed.port === '5254' && isPrivateLanAddress(parsed.hostname);
      const allowed = explicitlyAllowed || localPortal;
      return callback(allowed ? null : new Error('Origin is not permitted'), allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  }));

  app.use(createRoomRouter({
    ownerAuth,
    api: yellotalkApi,
    getConfig: () => config,
    hasLocalAccount,
    session,
    recovery: roomRecoveryController,
    roomActionLock,
    setLastJoinedRoom: room => { lastJoinedRoom = room; },
    joinResolvedRoom,
    playback,
    ttsPlayback,
    gmeAdapter,
  }));
  app.use(createChatRouter({ ownerAuth, session, roomChatService, ttsPlayback }));
  app.use(createMusicRouter({ ownerAuth, playback, getConfig: () => config, saveConfig }));
  app.use(createSettingsRouter({
    ownerAuth,
    getConfig: () => config,
    saveConfig,
    speechClient,
    ttsPlayback,
    gmeAdapter,
    playback,
    validateVoice,
    normalizeOrigin,
    originIsAllowed,
    logger,
  }));

  app.get('/api/status', (_req, res) => {
    const accountConfigured = hasLocalAccount();
    const room = session.snapshot();
    const musicState = playback.snapshot();
    res.json({
      product: 'Yello Music Bot',
      phase: accountConfigured ? 'ready' : 'setup-required',
      accountConfigured,
      connection: room.status,
      room: { id: room.roomId, name: room.roomName },
      audioAdapterConfigured: Boolean(gmeAdapter),
      playback: musicState.status,
      queueLength: musicState.queue.length,
      recovery: roomRecoveryController?.snapshot() || { status: 'idle', attempt: 0, maxAttempts: 5 },
      tts: config.settings.ttsEnabled ? (speechClient && ttsPlayback ? 'enabled' : 'unavailable') : 'disabled',
      ttsPlayback: ttsPlayback?.snapshot() || { status: 'unavailable', queued: 0, error: null },
      recentErrors: musicState.error ? [musicState.error] : [],
    });
  });

  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
    if (error?.message === 'Origin is not permitted') return res.status(403).json({ error: 'Origin is not permitted' });
    logger.error?.('HTTP request failed');
    return res.status(500).json({ error: 'Request failed' });
  });

  return { app, getConfig: () => config, ownerToken, configPath: resolvedConfigPath, tokenPath: resolvedTokenPath, shutdown };
}

function startServer(options = {}) {
  const service = createApp(options);
  const port = Number(options.port ?? process.env.PORT ?? 5353);
  const host = options.host || process.env.HOST || '0.0.0.0';
  const server = service.app.listen(port, host, () => {
    (options.logger || console).log(`Yello Music Bot local setup API listening on ${host}:${port}`);
    (options.logger || console).log(`Owner token is stored in ${service.tokenPath}`);
    (options.logger || console).log(`Local config is stored in ${service.configPath}`);
  });
  let closePromise = null;
  const close = () => {
    if (!closePromise) {
      closePromise = new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      }).then(() => service.shutdown());
    }
    return closePromise;
  };
  return { ...service, server, close };
}

if (require.main === module) {
  const service = startServer();
  let closePromise;
  const close = () => {
    if (!closePromise) {
      closePromise = service.close().catch(() => {
        console.error('Yello Music Bot shutdown cleanup failed');
      });
    }
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

module.exports = { createApp, startServer };
