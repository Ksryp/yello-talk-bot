'use strict';

const YELLOWTALK_SOCKET_URL = 'https://live.yellotalk.co:8443';
const DEFAULT_JOIN_TIMEOUT_MS = 15000;
const DEFAULT_LEAVE_TIMEOUT_MS = 1200;
const DEFAULT_MESSAGE_TIMEOUT_MS = 5000;
const MAX_ROOM_MESSAGE_LENGTH = 800;
const MAX_TRACKED_PARTICIPANTS = 500;

function normalizeRoom(room = {}) {
  const id = String(room.id || room.room_id || '').trim();
  const gmeId = String(room.gme_id || room.gmeId || '').trim();
  if (!id || !gmeId) throw new Error('Room is missing its room ID or GME ID');
  return {
    id,
    gmeId,
    topic: String(room.topic || room.name || '').trim(),
    campus: String(room.owner?.group_shortname || room.campus || 'No Group').trim() || 'No Group',
    ownerUuid: String(room.ownerUuid || room.owner?.uuid || room.owner_uuid || '').trim() || null,
  };
}

function participantCount(payload) {
  const list = participantList(payload);
  if (list) return list.length;
  const count = Number(payload?.count ?? payload?.participant_count);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function participantList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const value of [payload?.participants, payload?.results, payload?.json?.results]) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function participantSnapshot(payload) {
  const participants = participantList(payload);
  if (!participants || participants.length > MAX_TRACKED_PARTICIPANTS) return null;
  const snapshot = new Map();
  for (const participant of participants) {
    const id = String(participant?.uuid || participant?.user_uuid || participant?.id || '').trim().slice(0, 128);
    if (!id) return null;
    const displayName = String(participant?.pin_name || participant?.display_name || participant?.name || '')
      .replace(/[\u0000-\u001F\u007F@]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    snapshot.set(id, displayName);
  }
  return snapshot;
}

function speakerList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const value of [payload?.speakers, payload?.results, payload?.json?.speakers, payload?.data?.speakers]) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

const SEAT_COUNT = 10;

function slotIsLocked(item) {
  return item != null && (item.role === 'locked' || item.locked === true
    || String(item.pin_name || item.name || '').trim() === '🔒');
}

function slotUuid(item) {
  return String(item?.uuid || item?.user_uuid || '').trim();
}

// Normalizes YelloTalk's speaker_changed array into exactly SEAT_COUNT
// 1-indexed seats: an open seat is a null entry (or an unlocked entry with no
// occupant), a locked seat has role "locked", an occupied seat carries a uuid.
function seatMap(speakers, ownUuid) {
  const seats = Array.from({ length: SEAT_COUNT }, (_, i) => ({ position: i + 1, state: 'open', uuid: null, name: null, isBot: false }));
  speakers.forEach((item, index) => {
    const position = item && Number.isInteger(Number(item.position)) && Number(item.position) > 0 ? Number(item.position) : index + 1;
    const seat = seats[position - 1];
    if (!seat || item == null) return;
    const uuid = slotUuid(item);
    if (slotIsLocked(item) && !uuid) { seat.state = 'locked'; return; }
    if (!uuid) return;
    seat.state = 'occupied';
    seat.uuid = uuid;
    seat.name = String(item.pin_name || item.name || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 40) || null;
    seat.isBot = uuid === String(ownUuid);
  });
  return seats;
}

function emitWithTimeout(socket, event, payload, timeoutMs) {
  let cancel;
  const pending = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${event} acknowledgement timed out`)), timeoutMs);
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response);
    };
    cancel = reason => finish(new Error(String(reason || `${event} cancelled`)));
    try {
      socket.emit(event, payload, response => finish(null, response));
    } catch (error) {
      finish(error);
    }
  });
  pending.cancel = cancel;
  return pending;
}

class YelloTalkRoomSession {
  constructor({
    createSocket,
    onMessage = () => {},
    onParticipantCount = () => {},
    onParticipantEvent = () => {},
    onSpeakerStatus = () => {},
    onStatus = () => {},
    onRoomEnded = () => {},
    onConnectionLost = () => {},
    onManualLeave = () => {},
    connectTimeoutMs = DEFAULT_JOIN_TIMEOUT_MS,
    leaveTimeoutMs = DEFAULT_LEAVE_TIMEOUT_MS,
    messageTimeoutMs = DEFAULT_MESSAGE_TIMEOUT_MS,
  } = {}) {
    if (typeof createSocket !== 'function') throw new TypeError('createSocket is required');
    this.createSocket = createSocket;
    this.callbacks = { onMessage, onParticipantCount, onParticipantEvent, onSpeakerStatus, onStatus, onRoomEnded, onConnectionLost, onManualLeave };
    this.connectTimeoutMs = connectTimeoutMs;
    this.leaveTimeoutMs = leaveTimeoutMs;
    this.messageTimeoutMs = messageTimeoutMs;
    this.generation = 0;
    this.session = null;
  }

  get status() {
    return this.session?.status || 'disconnected';
  }

  snapshot() {
    return {
      status: this.status,
      roomId: this.session?.room.id || null,
      roomName: this.session?.room.topic || null,
    };
  }

  async join({ account, room, preserveQueue = false, createRoom = false } = {}) {
    if (!account?.jwtToken || !account?.userUuid || !account?.displayName) {
      throw new Error('Local account JWT, UUID, and display name are required');
    }
    const roomInfo = normalizeRoom(room);
    if (this.session) await this.leave({ preserveQueue });

    const generation = ++this.generation;
    const socket = this.createSocket(YELLOWTALK_SOCKET_URL, {
      auth: { token: account.jwtToken },
      transports: ['websocket'],
      reconnection: false,
    });
    const session = {
      socket,
      generation,
      room: roomInfo,
      account: { userUuid: String(account.userUuid), displayName: String(account.displayName) },
      status: 'connecting',
      handlers: [],
      speakerJoined: false,
      speakerJoinPending: false,
      createRoom: Boolean(createRoom),
      // The room owner already holds the host slot, so it never auto-climbs
      // onto a speaker seat; seat changes then come only from the owner portal.
      isHost: Boolean(createRoom) || (Boolean(roomInfo.ownerUuid) && roomInfo.ownerUuid === String(account.userUuid)),
      autoSeat: !(Boolean(createRoom) || (Boolean(roomInfo.ownerUuid) && roomInfo.ownerUuid === String(account.userUuid))),
      seats: null,
      participants: null,
    };
    this.session = session;
    this.callbacks.onStatus(this.snapshot());

    const isCurrent = () => this.session === session && this.generation === generation;
    const listen = (event, handler) => {
      session.handlers.push([event, handler]);
      socket.on(event, handler);
    };
    const detach = () => {
      for (const [event, handler] of session.handlers) {
        if (typeof socket.off === 'function') socket.off(event, handler);
        else if (typeof socket.removeListener === 'function') socket.removeListener(event, handler);
      }
      session.handlers = [];
    };
    const fail = error => {
      if (!isCurrent()) return;
      session.status = 'error';
      detach();
      session.cancelJoin?.(error);
      session.pendingCreateAck?.cancel(error.message);
      session.pendingJoinAck?.cancel(error.message);
      session.pendingSpeakerAck?.cancel(error.message);
      socket.disconnect?.();
      this.session = null;
      this.callbacks.onStatus({ status: 'error', roomId: roomInfo.id, roomName: roomInfo.topic || null });
      throw error;
    };

    let connectHandler = null;
    const joined = new Promise((resolve, reject) => {
      let settled = false;
      let joinStarted = false;
      const timeout = setTimeout(() => finish(new Error('YelloTalk room join timed out')), this.connectTimeoutMs * (createRoom ? 2 : 1));
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      session.cancelJoin = error => finish(error || new Error('YelloTalk room join cancelled'));
      const onConnect = async () => {
        if (!isCurrent() || joinStarted) return;
        joinStarted = true;
        const payload = {
          room: roomInfo.id,
          uuid: account.userUuid,
          avatar_id: 0,
          gme_id: roomInfo.gmeId,
          campus: roomInfo.campus,
          pin_name: account.displayName,
        };
        try {
          if (createRoom) {
            const createAck = emitWithTimeout(socket, 'create_room', {
              room: roomInfo.id,
              uuid: account.userUuid,
              limit_speaker: 1,
            }, this.connectTimeoutMs);
            session.pendingCreateAck = createAck;
            let createResponse;
            try { createResponse = await createAck; }
            finally { if (session.pendingCreateAck === createAck) session.pendingCreateAck = null; }
            if (!isCurrent()) return;
            if (createResponse?.result !== 200) {
              finish(new Error(createResponse?.description || 'YelloTalk rejected room activation'));
              return;
            }
            payload.role = 'host';
            payload.gme_role = 'host';
            payload.audio_role = 'host';
          }
          const pendingAck = emitWithTimeout(socket, 'join_room', payload, this.connectTimeoutMs);
          session.pendingJoinAck = pendingAck;
          let response;
          try { response = await pendingAck; }
          finally { if (session.pendingJoinAck === pendingAck) session.pendingJoinAck = null; }
          if (!isCurrent()) return;
          if (response?.result !== 200) {
            finish(new Error(response?.description || 'YelloTalk rejected the room join'));
            return;
          }
          session.status = 'joined';
          this.callbacks.onStatus(this.snapshot());
          finish(null, this.snapshot());
        } catch (error) {
          finish(error);
        }
      };
      connectHandler = onConnect;
      listen('connect', onConnect);
      listen('connect_error', error => finish(error instanceof Error ? error : new Error('YelloTalk connection failed')));
      listen('disconnect', reason => {
        if (!isCurrent()) return;
        const wasJoined = session.status === 'joined';
        const error = new Error(String(reason || 'YelloTalk disconnected before room join completed'));
        if (wasJoined) {
          session.status = 'disconnected';
          session.participants?.clear();
          session.participants = null;
          this.session = null;
          detach();
          this.callbacks.onStatus({ status: 'disconnected', roomId: null, roomName: null });
          this.callbacks.onConnectionLost(error.message, { status: 'disconnected', roomId: roomInfo.id, roomName: roomInfo.topic || null });
        }
        finish(error);
      });
    });

    listen('new_message', data => {
      if (isCurrent() && session.status === 'joined') {
        void Promise.resolve(this.callbacks.onMessage(data)).catch(() => {});
      }
    });
    listen('participant_changed', data => {
      if (!isCurrent() || session.status !== 'joined') return;
      const count = participantCount(data);
      if (count != null) this.callbacks.onParticipantCount(count);
      const next = participantSnapshot(data);
      if (!next) {
        session.participants?.clear();
        session.participants = null;
        return;
      }
      const previous = session.participants;
      session.participants = next;
      if (!previous) return;

      const joined = [...next].filter(([id]) => !previous.has(id));
      const left = [...previous].filter(([id]) => !next.has(id));
      if (joined.length + left.length !== 1) return;
      const [type, change] = joined.length ? ['join', joined[0]] : ['leave', left[0]];
      const [uuid, displayName] = change;
      if (uuid === String(account.userUuid) || !displayName) return;
      void Promise.resolve(this.callbacks.onParticipantEvent({ type, uuid, displayName })).catch(() => {});
    });
    listen('speaker_changed', data => {
      if (!isCurrent() || session.status !== 'joined') return;
      const speakers = speakerList(data);
      if (!speakers) return;
      session.seats = seatMap(speakers, account.userUuid);
      const ownSlot = speakers.find(item => String(item?.uuid || item?.user_uuid || '') === String(account.userUuid));
      if (ownSlot) {
        session.speakerJoined = true;
        this.callbacks.onSpeakerStatus({ joined: true, position: Number(ownSlot.position) || 0 });
        return;
      }
      session.speakerJoined = false;
      this.callbacks.onSpeakerStatus({ joined: false, position: null });
      if (!session.autoSeat || session.speakerJoinPending) return;
      // An open seat is either a null array entry or an object with no occupant
      // and not locked. YelloTalk positions are 1-indexed; a null entry's
      // position is its array index + 1, and occupied/locked entries carry an
      // explicit `position`.
      let emptyIndex = -1;
      for (let i = 0; i < speakers.length; i++) {
        const item = speakers[i];
        const isOpen = item == null
          || (item.role !== 'locked' && item.locked !== true
            && !String(item.uuid || item.user_uuid || '').trim()
            && String(item.pin_name || item.name || '').trim().toLowerCase() !== '🔒');
        if (isOpen) { emptyIndex = i; break; }
      }
      if (emptyIndex < 0) return;

      session.speakerJoinPending = true;
      const slot = speakers[emptyIndex];
      const position = slot && Number.isInteger(Number(slot.position))
        ? Number(slot.position)
        : emptyIndex + 1;
      const pendingAck = emitWithTimeout(socket, 'join_speaker', {
        room: roomInfo.id,
        uuid: account.userUuid,
        position,
      }, this.connectTimeoutMs);
      session.pendingSpeakerAck = pendingAck;
      void pendingAck.then(response => {
        if (!isCurrent() || session.status !== 'joined') return;
        if (response?.result === 200) this.callbacks.onSpeakerStatus({ joined: false, joining: true, position: position - 1 });
        else this.callbacks.onSpeakerStatus({ joined: false, position: null, error: 'Speaker slot request was rejected' });
      }).catch(() => {
        if (isCurrent()) this.callbacks.onSpeakerStatus({ joined: false, position: null, error: 'Speaker slot request failed' });
      }).finally(() => {
        session.speakerJoinPending = false;
        if (session.pendingSpeakerAck === pendingAck) session.pendingSpeakerAck = null;
      });
    });
    for (const event of ['live_end', 'end_live']) {
      listen(event, data => {
        if (!isCurrent()) return;
        const endedRoomId = roomInfo.id;
        session.status = 'ended';
        session.participants?.clear();
        session.participants = null;
        detach();
        session.cancelJoin?.(new Error('YelloTalk room ended'));
        session.pendingCreateAck?.cancel('YelloTalk room ended');
        session.pendingJoinAck?.cancel('YelloTalk room ended');
        session.pendingSpeakerAck?.cancel('YelloTalk room ended');
        socket.disconnect?.();
        this.session = null;
        this.callbacks.onStatus(this.snapshot());
        this.callbacks.onRoomEnded({ roomId: endedRoomId, event, data });
      });
    }

    try {
      if (socket.connected) void connectHandler?.();
      return await joined;
    } catch (error) {
      if (isCurrent()) fail(error);
      throw error;
    }
  }

  seatsSnapshot() {
    const session = this.session;
    if (!session || session.status !== 'joined') return null;
    return {
      roomId: session.room.id,
      isHost: session.isHost,
      autoSeat: session.autoSeat,
      seats: session.seats ? session.seats.map(seat => ({ ...seat })) : null,
    };
  }

  async seatAction(action, position) {
    const session = this.session;
    if (!session || session.status !== 'joined' || !session.socket.connected) {
      throw new Error('Join a YelloTalk room before changing seats');
    }
    const target = Number(position);
    if (!Number.isInteger(target) || target < 1 || target > SEAT_COUNT) throw new Error(`Seat position must be 1-${SEAT_COUNT}`);
    const room = session.room.id;
    const uuid = session.account.userUuid;
    const seats = session.seats || [];
    const ownSeat = seats.find(seat => seat.isBot);
    const emit = (event, payload) => emitWithTimeout(session.socket, event, payload, this.messageTimeoutMs).then(response => {
      if (response?.result !== 200) throw new Error(response?.description || `YelloTalk rejected ${event}`);
      return response;
    });
    // Any owner seat action takes over from the automatic seat climber.
    session.autoSeat = false;
    if (action === 'take') {
      if (ownSeat?.position === target) return { position: target };
      if (ownSeat) await emit('leave_speaker', { room, uuid, position: ownSeat.position });
      await emit('join_speaker', { room, uuid, position: target });
      return { position: target };
    }
    if (action === 'leave') {
      if (!ownSeat) return { position: null };
      await emit('leave_speaker', { room, uuid, position: ownSeat.position });
      return { position: null };
    }
    if (action === 'unlock') { await emit('unlock_speaker', { room, position: target }); return { position: target }; }
    if (action === 'lock') { await emit('lock_speaker', { room, position: target }); return { position: target }; }
    throw new Error('Unknown seat action');
  }

  async sendMessage(message) {
    const session = this.session;
    const text = String(message || '').trim();
    if (!session || session.status !== 'joined' || !session.socket.connected) {
      throw new Error('Join a YelloTalk room before sending a message');
    }
    if (!text || text.length > MAX_ROOM_MESSAGE_LENGTH) {
      throw new Error(`Room messages must contain 1-${MAX_ROOM_MESSAGE_LENGTH} characters`);
    }
    return emitWithTimeout(session.socket, 'new_message', {
      message: text,
      room: session.room.id,
      uuid: session.account.userUuid,
      pin_name: session.account.displayName,
      avatar_id: 0,
    }, this.messageTimeoutMs);
  }

  async leave({ preserveQueue = false } = {}) {
    const session = this.session;
    if (!session) return false;
    this.generation++;
    this.session = null;
    session.status = 'leaving';
    session.participants?.clear();
    session.participants = null;
    session.cancelJoin?.(new Error('YelloTalk room join cancelled'));
    session.pendingCreateAck?.cancel('YelloTalk room join cancelled');
    session.pendingJoinAck?.cancel('YelloTalk room join cancelled');
    session.pendingSpeakerAck?.cancel('YelloTalk room leave cancelled');
    for (const [event, handler] of session.handlers) {
      if (typeof session.socket.off === 'function') session.socket.off(event, handler);
      else if (typeof session.socket.removeListener === 'function') session.socket.removeListener(event, handler);
    }
    session.handlers = [];
    this.callbacks.onStatus(this.snapshot());
    try {
      if (session.socket.connected) {
        await emitWithTimeout(session.socket, 'leave_room', { room: session.room.id }, this.leaveTimeoutMs).catch(() => {});
      }
    } finally {
      session.socket.disconnect?.();
      if (!preserveQueue) await this.callbacks.onManualLeave({ roomId: session.room.id });
    }
    return true;
  }
}

module.exports = {
  DEFAULT_JOIN_TIMEOUT_MS,
  DEFAULT_MESSAGE_TIMEOUT_MS,
  MAX_ROOM_MESSAGE_LENGTH,
  SEAT_COUNT,
  YELLOWTALK_SOCKET_URL,
  YelloTalkRoomSession,
  normalizeRoom,
};
