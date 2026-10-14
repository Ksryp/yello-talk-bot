'use strict';

const express = require('express');

function createRoomRouter({
  ownerAuth,
  api,
  getConfig,
  hasLocalAccount,
  session,
  recovery,
  roomActionLock,
  setLastJoinedRoom,
  joinResolvedRoom,
  playback,
  ttsPlayback,
  gmeAdapter,
  userDirectory,
} = {}) {
  const router = express.Router();
  const recordUsers = items => { try { userDirectory?.recordMany(items); } catch { /* best effort */ } };

  router.get('/api/rooms', ownerAuth, async (_req, res) => {
    if (!hasLocalAccount()) return res.status(409).json({ error: 'Configure a local YelloTalk account first' });
    try {
      const rooms = await api.listPublicRooms(getConfig().account.jwtToken);
      recordUsers(rooms.map(room => ({ uuid: room.ownerUuid, name: room.ownerName })));
      return res.json({ rooms });
    } catch {
      return res.status(502).json({ error: 'Could not load the YelloTalk room list' });
    }
  });

  router.post('/api/rooms/create', ownerAuth, async (req, res) => {
    if (!hasLocalAccount()) return res.status(409).json({ error: 'Configure the local YelloTalk JWT, UUID, and display name first' });
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
    if (!topic || topic.length > 100) return res.status(400).json({ error: 'Room name is required and must be 100 characters or fewer' });
    if (roomActionLock.pending) return res.status(409).json({ error: 'A room action is already in progress' });
    roomActionLock.pending = true;
    try {
      const room = await api.createPublicRoom(getConfig().account.jwtToken, topic);
      recovery.cancel();
      const connected = await joinResolvedRoom(room, { createRoom: true });
      return res.status(201).json({ room, connected });
    } catch (error) {
      const message = String(error?.message || 'Could not create the YelloTalk room').slice(0, 240);
      return res.status(502).json({ error: message });
    } finally {
      roomActionLock.pending = false;
    }
  });

  router.get('/api/room/:roomId/participants', ownerAuth, async (req, res) => {
    if (!hasLocalAccount()) return res.status(409).json({ error: 'Configure a local YelloTalk account first' });
    const roomId = String(req.params.roomId || '').trim();
    if (!/^[A-Za-z0-9]{1,64}$/.test(roomId)) return res.status(400).json({ error: 'A valid room ID is required' });
    try {
      const participants = await api.roomParticipants(getConfig().account.jwtToken, roomId, { max: 50 });
      recordUsers(participants);
      return res.json({ participants });
    } catch {
      return res.status(502).json({ error: 'Could not load room participants' });
    }
  });

  router.post('/api/room/auto-join', ownerAuth, (req, res) => {
    if (!hasLocalAccount()) return res.status(409).json({ error: 'Configure the local YelloTalk JWT, UUID, and display name first' });
    const mode = String(req.body?.mode || 'following');
    if (!['following', 'public'].includes(mode)) return res.status(400).json({ error: 'Auto-join mode must be following or public' });
    return res.status(409).json({ error: 'Auto-join is disabled until speaker availability can be verified before joining' });
  });

  router.post('/api/room/join', ownerAuth, async (req, res) => {
    if (!hasLocalAccount()) return res.status(409).json({ error: 'Configure the local YelloTalk JWT, UUID, and display name first' });
    const roomId = String(req.body?.roomId || '').trim();
    if (!/^[A-Za-z0-9]{1,64}$/.test(roomId)) return res.status(400).json({ error: 'A valid room ID is required' });
    if (roomActionLock.pending) return res.status(409).json({ error: 'A room action is already in progress' });
    roomActionLock.pending = true;
    try {
      const room = await api.getRoom(getConfig().account.jwtToken, roomId);
      if (!room) return res.status(404).json({ error: 'Room was not found or is missing its voice ID' });
      recovery.cancel();
      const connected = await joinResolvedRoom(room);
      return res.json({ connected });
    } catch (error) {
      const message = String(error?.message || 'Could not join the YelloTalk room').slice(0, 240);
      return res.status(502).json({ error: message });
    } finally {
      roomActionLock.pending = false;
    }
  });

  router.get('/api/room/seats', ownerAuth, (_req, res) => {
    const seats = typeof session.seatsSnapshot === 'function' ? session.seatsSnapshot() : null;
    return res.json({ connected: Boolean(seats), ...(seats || {}) });
  });

  router.post('/api/room/seat', ownerAuth, async (req, res) => {
    const action = String(req.body?.action || '');
    if (!['take', 'leave', 'unlock', 'lock'].includes(action)) return res.status(400).json({ error: 'Seat action must be take, leave, unlock, or lock' });
    if (session.snapshot().status !== 'joined') return res.status(409).json({ error: 'Join a room before changing seats' });
    try {
      const result = await session.seatAction(action, req.body?.position ?? 1);
      return res.json({ ok: true, action, ...result });
    } catch (error) {
      return res.status(502).json({ error: String(error?.message || 'Seat action failed').slice(0, 200) });
    }
  });

  router.post('/api/room/leave', ownerAuth, async (_req, res) => {
    if (roomActionLock.pending) return res.status(409).json({ error: 'A room action is already in progress' });
    roomActionLock.pending = true;
    try {
      recovery.cancel();
      await ttsPlayback?.stopAll();
      await playback.detachRoom({ stopAdapter: true });
      if (gmeAdapter) {
        await gmeAdapter.leave().catch(() => {});
      }
      const left = await session.leave();
      setLastJoinedRoom(null);
      return res.json({ left });
    } catch {
      return res.status(502).json({ error: 'Could not leave the YelloTalk room cleanly' });
    } finally {
      roomActionLock.pending = false;
    }
  });

  return router;
}

module.exports = { createRoomRouter };
