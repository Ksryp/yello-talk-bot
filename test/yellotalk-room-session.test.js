'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { YelloTalkRoomSession, YELLOWTALK_SOCKET_URL } = require('../src/yellotalk/room-session');

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.connected = false;
    this.emitted = [];
  }

  on(event, callback) {
    const set = this.listeners.get(event) || new Set();
    set.add(callback);
    this.listeners.set(event, set);
    return this;
  }

  off(event, callback) {
    this.listeners.get(event)?.delete(callback);
    return this;
  }

  trigger(event, ...args) {
    for (const callback of this.listeners.get(event) || []) callback(...args);
  }

  emit(event, payload, callback) {
    this.emitted.push({ event, payload });
    if (event === 'create_room' || event === 'join_room') callback({ result: 200, room: payload.room });
    else if (['join_speaker', 'leave_speaker', 'lock_speaker', 'unlock_speaker'].includes(event)) callback({ result: 200 });
    else if (event === 'new_message') callback({ result: 200 });
    else if (event === 'leave_room') callback({ result: 200 });
    return this;
  }

  connect() {
    this.connected = true;
    this.trigger('connect');
  }

  disconnect() {
    this.connected = false;
    this.trigger('disconnect', 'client disconnect');
  }
}

function createFixture(options = {}) {
  const sockets = [];
  const calls = { messages: [], participantCounts: [], participantEvents: [], speakerStatuses: [], statuses: [], ended: [], lost: [], manualLeaves: [] };
  const session = new YelloTalkRoomSession({
    createSocket: (...args) => {
      const socket = new FakeSocket();
      sockets.push({ socket, args });
      queueMicrotask(() => socket.connect());
      return socket;
    },
    onMessage: value => calls.messages.push(value),
    onParticipantCount: value => calls.participantCounts.push(value),
    onParticipantEvent: value => calls.participantEvents.push(value),
    onSpeakerStatus: value => calls.speakerStatuses.push(value),
    onStatus: value => calls.statuses.push(value),
    onRoomEnded: value => calls.ended.push(value),
    onConnectionLost: (...value) => calls.lost.push(value),
    onManualLeave: value => calls.manualLeaves.push(value),
    ...options,
  });
  return { session, sockets, calls };
}

const account = { jwtToken: 'private-test-token', userUuid: 'private-test-id', displayName: 'Local bot' };
const room = { id: 'room-1', gme_id: 'gme-1', topic: 'Music room', owner: { group_shortname: 'Campus' } };

test('connects one room using the local account and joins with minimal speaker identity', async () => {
  const { session, sockets } = createFixture();
  const status = await session.join({ account, room });
  assert.equal(status.status, 'joined');
  assert.deepEqual(sockets[0].args, [YELLOWTALK_SOCKET_URL, {
    auth: { token: 'private-test-token' },
    transports: ['websocket'],
    reconnection: false,
  }]);
  assert.deepEqual(sockets[0].socket.emitted[0], {
    event: 'join_room',
    payload: {
      room: 'room-1', uuid: 'private-test-id', avatar_id: 0,
      gme_id: 'gme-1', campus: 'Campus', pin_name: 'Local bot',
    },
  });
  assert.deepEqual(session.snapshot(), { status: 'joined', roomId: 'room-1', roomName: 'Music room' });
});

test('activates a newly-created room before joining it as host', async () => {
  const { session, sockets } = createFixture();
  await session.join({ account, room, createRoom: true });
  const emitted = sockets[0].socket.emitted;
  assert.deepEqual(emitted[0], {
    event: 'create_room',
    payload: { room: 'room-1', uuid: 'private-test-id', limit_speaker: 1 },
  });
  assert.deepEqual(emitted[1], {
    event: 'join_room',
    payload: {
      room: 'room-1', uuid: 'private-test-id', avatar_id: 0,
      gme_id: 'gme-1', campus: 'Campus', pin_name: 'Local bot',
      role: 'host', gme_role: 'host', audio_role: 'host',
    },
  });
  await session.leave();
});

test('does not join a newly-created room when create_room activation is rejected', async () => {
  const socket = new FakeSocket();
  socket.emit = (event, payload, callback) => {
    socket.emitted.push({ event, payload });
    if (event === 'create_room') callback({ result: 403, description: 'not owner' });
    return socket;
  };
  const session = new YelloTalkRoomSession({ createSocket: () => socket });
  const joining = session.join({ account, room, createRoom: true });
  socket.connect();
  await assert.rejects(joining, /not owner/);
  assert.deepEqual(socket.emitted.map(item => item.event), ['create_room']);
  assert.equal(session.status, 'disconnected');
});

test('forwards live chat/counts and only a single-member delta, not room history or a roster', async () => {
  const { session, sockets, calls } = createFixture();
  await session.join({ account, room });
  const socket = sockets[0].socket;
  socket.trigger('new_message', { pin_name: 'Member', message: '.play song' });
  socket.trigger('participant_changed', { participants: [{ uuid: 'one', pin_name: 'One' }, { uuid: 'two', pin_name: 'Two' }] });
  socket.trigger('participant_changed', { participants: [{ uuid: 'one', pin_name: 'One' }, { uuid: 'two', pin_name: 'Two' }, { uuid: 'three', pin_name: 'Three' }] });
  socket.trigger('participant_changed', { participants: [{ uuid: 'two', pin_name: 'Two' }, { uuid: 'three', pin_name: 'Three' }] });
  socket.trigger('participant_changed', { participants: [{ uuid: 'three', pin_name: 'Three' }, { uuid: 'four', pin_name: 'Four' }] });
  socket.trigger('load_message', { messages: [{ message: 'old history' }] });
  assert.deepEqual(calls.messages, [{ pin_name: 'Member', message: '.play song' }]);
  assert.deepEqual(calls.participantCounts, [2, 3, 2, 2]);
  assert.deepEqual(calls.participantEvents, [
    { type: 'join', uuid: 'three', displayName: 'Three' },
    { type: 'leave', uuid: 'one', displayName: 'One' },
  ]);
});

test('participant baseline suppresses existing members, bot echoes, and incomplete snapshots', async () => {
  const { session, sockets, calls } = createFixture();
  await session.join({ account, room });
  const socket = sockets[0].socket;
  socket.trigger('participant_changed', { participants: [{ uuid: 'private-test-id', pin_name: 'Local bot' }, { uuid: 'already-here', pin_name: 'Existing' }] });
  socket.trigger('participant_changed', { participants: [{ uuid: 'private-test-id', pin_name: 'Local bot' }, { uuid: 'already-here', pin_name: 'Existing' }, { uuid: 'new-user', pin_name: '@New User' }] });
  socket.trigger('participant_changed', { participants: [{ pin_name: 'Unidentified' }] });
  assert.deepEqual(calls.participantEvents, [{ type: 'join', uuid: 'new-user', displayName: 'New User' }]);
  await session.leave();
});

test('sends only a bounded room message using the local bot identity', async () => {
  const { session, sockets } = createFixture();
  await session.join({ account, room });
  await session.sendMessage('Music is ready.');
  const emitted = sockets[0].socket.emitted.find(item => item.event === 'new_message');
  assert.deepEqual(emitted, {
    event: 'new_message',
    payload: {
      message: 'Music is ready.',
      room: 'room-1',
      uuid: 'private-test-id',
      pin_name: 'Local bot',
      avatar_id: 0,
    },
  });
  assert.equal(JSON.stringify(emitted).includes('private-test-token'), false);
  await assert.rejects(session.sendMessage('x'.repeat(801)), /1-800 characters/);
  await session.leave();
  await assert.rejects(session.sendMessage('Too late'), /Join a YelloTalk room/);
});

test('automatically requests an available speaker slot and waits for authoritative confirmation', async () => {
  const { session, sockets, calls } = createFixture();
  await session.join({ account, room });
  const socket = sockets[0].socket;
  socket.trigger('speaker_changed', { speakers: [
    { uuid: 'another-member', position: 0, pin_name: 'Member', locked: false },
    { position: 1, pin_name: 'Empty', locked: false },
  ] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(socket.emitted.some(item => item.event === 'join_speaker'
    && item.payload.position === 2
    && item.payload.room === 'room-1'));
  assert.equal(calls.speakerStatuses.at(-1).joining, true);

  socket.trigger('speaker_changed', { speakers: [
    { uuid: 'private-test-id', position: 1, pin_name: 'Local bot', locked: false },
  ] });
  assert.deepEqual(calls.speakerStatuses.at(-1), { joined: true, position: 1 });
});

test('a host never auto-climbs onto a speaker seat', async () => {
  const { session, sockets } = createFixture();
  await session.join({ account, room, createRoom: true });
  const socket = sockets[0].socket;
  socket.trigger('speaker_changed', [null, { role: 'locked', pin_name: '🔒', uuid: null, position: 2 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.emitted.some(item => item.event === 'join_speaker'), false);
  assert.equal(session.seatsSnapshot().isHost, true);
  await session.leave();
});

test('joining a room the bot owns also skips the automatic seat', async () => {
  const { session, sockets } = createFixture();
  await session.join({ account, room: { ...room, owner: { uuid: 'private-test-id' } } });
  sockets[0].socket.trigger('speaker_changed', [null]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets[0].socket.emitted.some(item => item.event === 'join_speaker'), false);
  await session.leave();
});

test('maps speaker_changed into ten 1-indexed seats', async () => {
  const { session, sockets } = createFixture();
  await session.join({ account, room, createRoom: true });
  sockets[0].socket.trigger('speaker_changed', [
    null,
    { role: 'locked', pin_name: '🔒', uuid: null, position: 2 },
    { role: 'speaker', pin_name: 'Member', uuid: 'another-member', position: 3 },
    { role: 'speaker', pin_name: 'Local bot', uuid: 'private-test-id', position: 4 },
  ]);
  const { seats } = session.seatsSnapshot();
  assert.equal(seats.length, 10);
  assert.deepEqual(seats.slice(0, 4).map(seat => [seat.position, seat.state, seat.isBot]), [
    [1, 'open', false], [2, 'locked', false], [3, 'occupied', false], [4, 'occupied', true],
  ]);
  assert.equal(seats[9].state, 'open');
  await session.leave();
});

test('owner seat actions move, leave, and unlock seats and stop auto-seating', async () => {
  const { session, sockets } = createFixture();
  await session.join({ account, room });
  const socket = sockets[0].socket;
  socket.trigger('speaker_changed', [{ role: 'speaker', pin_name: 'Local bot', uuid: 'private-test-id', position: 1 }, null]);
  socket.emitted.length = 0;

  await session.seatAction('take', 2);
  assert.deepEqual(socket.emitted.map(item => [item.event, item.payload]), [
    ['leave_speaker', { room: 'room-1', uuid: 'private-test-id', position: 1 }],
    ['join_speaker', { room: 'room-1', uuid: 'private-test-id', position: 2 }],
  ]);
  assert.equal(session.seatsSnapshot().autoSeat, false);

  socket.emitted.length = 0;
  await session.seatAction('unlock', 5);
  assert.deepEqual(socket.emitted.map(item => [item.event, item.payload]), [['unlock_speaker', { room: 'room-1', position: 5 }]]);

  socket.trigger('speaker_changed', [null, null]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.emitted.some(item => item.event === 'join_speaker'), false);
  await assert.rejects(session.seatAction('take', 11), /1-10/);
  await session.leave();
});

test('manual leave emits leave_room and clears room-bound queue through callback', async () => {
  const { session, sockets, calls } = createFixture();
  await session.join({ account, room });
  assert.equal(await session.leave(), true);
  assert.equal(session.status, 'disconnected');
  assert.ok(sockets[0].socket.emitted.some(item => item.event === 'leave_room'));
  assert.deepEqual(calls.manualLeaves, [{ roomId: 'room-1' }]);
});

test('manual leave cancels an in-flight room join and its outstanding acknowledgement', async () => {
  const socket = new FakeSocket();
  socket.emit = (event, payload, callback) => {
    socket.emitted.push({ event, payload });
    if (event !== 'join_room') callback({ result: 200 });
    return socket;
  };
  const session = new YelloTalkRoomSession({ createSocket: () => socket, connectTimeoutMs: 5000 });
  const joining = session.join({ account, room });
  socket.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.emitted[0].event, 'join_room');
  assert.equal(await session.leave(), true);
  await assert.rejects(joining, /cancelled/);
  assert.equal(session.status, 'disconnected');
});

test('connection loss reports recovery without invoking the manual-clear callback', async () => {
  const { session, sockets, calls } = createFixture();
  await session.join({ account, room });
  sockets[0].socket.trigger('disconnect', 'transport close');
  assert.equal(session.status, 'disconnected');
  assert.equal(calls.lost[0][0], 'transport close');
  assert.deepEqual(calls.manualLeaves, []);
});

test('recovery join preserves queue while a manual room change clears it', async () => {
  const { session, calls } = createFixture();
  await session.join({ account, room });
  await session.join({ account, room, preserveQueue: true });
  assert.deepEqual(calls.manualLeaves, []);
  await session.join({ account, room: { ...room, id: 'room-2', topic: 'Other room' } });
  assert.deepEqual(calls.manualLeaves, [{ roomId: 'room-1' }]);
});

test('rejects missing local credentials and incomplete room identities before connecting', async () => {
  const { session, sockets } = createFixture();
  await assert.rejects(session.join({ account: {}, room }), /Local account/);
  await assert.rejects(session.join({ account, room: { id: 'room-1' } }), /GME ID/);
  assert.equal(sockets.length, 0);
});
