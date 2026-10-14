'use strict';

const ROOM_PAGE_SIZE = 20;
const FOLLOWING_PAGE_SIZE = 200;
const MAX_FOLLOWING_USERS = 2000;
const ROOM_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

function responseRooms(response) {
  const payload = response?.data;
  for (const value of [payload?.json, payload?.results, payload?.rooms]) {
    if (Array.isArray(value)) return value;
  }
  if (Array.isArray(payload?.json?.results)) return payload.json.results;
  return [];
}

function responseFollowing(response) {
  const payload = response?.data;
  for (const value of [payload?.json, payload?.results, payload?.following]) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.results)) return value.results;
  }
  return null;
}

function normalizeRoom(room, fallbackId = '') {
  if (!room || typeof room !== 'object' || Array.isArray(room)) return null;
  const id = String(room.id ?? room.room_id ?? fallbackId).trim();
  const gmeId = String(room.gme_id ?? room.gmeId ?? room.gme_user_id ?? '').trim();
  const ownerUuid = String(room.owner?.uuid ?? room.owner_uuid ?? '').trim();
  if (!ROOM_ID_PATTERN.test(id) || !gmeId) return null;
  const count = Number(room.participant_count ?? room.participants_count ?? room.count);
  const ownerName = String(room.owner?.pin_name ?? room.owner?.name ?? room.owner_name ?? '').trim();
  return {
    id,
    gmeId,
    ownerUuid: ownerUuid.length <= 128 && !/[\u0000-\u001F\u007F]/.test(ownerUuid) ? ownerUuid || null : null,
    ownerName: ownerName && ownerName.length <= 80 && !/[\u0000-\u001F\u007F]/.test(ownerName) ? ownerName : null,
    topic: String(room.topic ?? room.name ?? '').trim(),
    campus: String(room.owner?.group_shortname ?? room.campus ?? 'No Group').trim() || 'No Group',
    participantCount: Number.isInteger(count) && count >= 0 ? count : null,
    isPrivate: Boolean(room.is_private ?? room.isPrivate),
  };
}

class YelloTalkApiClient {
  constructor({ http, baseUrl = 'https://live.yellotalk.co/v1', timeoutMs = 10000 } = {}) {
    if (!http || typeof http.get !== 'function') throw new TypeError('An HTTP client with get() is required');
    this.http = http;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  requestOptions(token) {
    if (!String(token || '').trim()) throw new Error('YelloTalk account is not configured');
    return {
      timeout: this.timeoutMs,
      maxContentLength: 1024 * 1024,
      maxBodyLength: 1024 * 1024,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'ios' },
    };
  }

  async popularRooms(token, { limit = ROOM_PAGE_SIZE, offset = 0, isPrivate = false } = {}) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      is_private: String(Boolean(isPrivate)),
    });
    return this.http.get(`${this.baseUrl}/rooms/popular?${params}`, this.requestOptions(token));
  }

  async roomDetails(token, roomId) {
    const id = String(roomId || '').trim();
    if (!ROOM_ID_PATTERN.test(id)) throw new Error('Invalid room ID');
    return this.http.get(`${this.baseUrl}/rooms/${encodeURIComponent(id)}`, this.requestOptions(token));
  }

  // The current occupants of a room, as [{ uuid, name, role }]. YelloTalk
  // returns them under json.results; names come from pin_name.
  async roomParticipants(token, roomId, { max = 50 } = {}) {
    const id = String(roomId || '').trim();
    if (!ROOM_ID_PATTERN.test(id)) return [];
    const limit = Math.max(1, Math.min(50, Math.trunc(Number(max)) || 50));
    const response = await this.http.get(
      `${this.baseUrl}/rooms/${encodeURIComponent(id)}/participants?limit=${limit}&offset=0`,
      this.requestOptions(token),
    );
    const payload = response?.data;
    const results = payload?.json?.results ?? payload?.results ?? payload?.data?.results ?? [];
    const out = [];
    for (const p of Array.isArray(results) ? results : []) {
      const uuid = String(p?.uuid ?? p?.id ?? '').trim().slice(0, 128);
      const name = String(p?.pin_name ?? p?.display_name ?? p?.name ?? '')
        .replace(/[\u0000-\u001F\u007F@]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
      if (uuid && name) out.push({ uuid, name, role: String(p?.role ?? '').slice(0, 20) });
    }
    return out;
  }

  async followingPage(token, { limit = FOLLOWING_PAGE_SIZE, offset = 0 } = {}) {
    const pageSize = Math.trunc(Number(limit));
    const pageOffset = Math.trunc(Number(offset));
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > FOLLOWING_PAGE_SIZE
      || !Number.isInteger(pageOffset) || pageOffset < 0) {
      throw new Error('Invalid following-page range');
    }
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(pageOffset) });
    const response = await this.http.get(`${this.baseUrl}/users/me/follow/following?${params}`, {
      ...this.requestOptions(token), timeout: 10000,
    });
    const entries = responseFollowing(response);
    if (!entries) throw new Error('YelloTalk following response was not a list');
    return entries;
  }

  async listFollowing(token, { maxUsers = MAX_FOLLOWING_USERS } = {}) {
    const cap = Math.max(1, Math.min(MAX_FOLLOWING_USERS, Math.trunc(Number(maxUsers)) || 1));
    const usersByUuid = new Map();
    for (let offset = 0; offset < cap; offset += FOLLOWING_PAGE_SIZE) {
      const limit = Math.min(FOLLOWING_PAGE_SIZE, cap - offset);
      const entries = await this.followingPage(token, { limit, offset });
      for (const entry of entries) {
        if (entry?.is_blocked) continue;
        const target = entry?.target_user || entry?.user || entry;
        const uuid = String(target?.uuid || target?.user_uuid || '').trim();
        if (!uuid || uuid.length > 128 || /[\u0000-\u001F\u007F]/.test(uuid)) continue;
        const key = uuid.toUpperCase();
        if (usersByUuid.has(key)) continue;
        const name = String(target?.pin_name || target?.display_name || target?.name || 'Unknown')
          .replace(/[\u0000-\u001F\u007F@]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80) || 'Unknown';
        usersByUuid.set(key, { uuid, name });
      }
      if (entries.length < limit) break;
    }
    return [...usersByUuid.values()];
  }

  async createPublicRoom(token, topic) {
    const name = String(topic || '').trim();
    if (!name || name.length > 100) throw new Error('Room name is required and must be 100 characters or fewer');
    if (typeof this.http.post !== 'function') throw new TypeError('An HTTP client with post() is required');
    const response = await this.http.post(`${this.baseUrl}/rooms`, {
      category_id: 0,
      is_private: false,
      limit_speaker: 1,
      topic: name,
    }, { ...this.requestOptions(token), timeout: 12000 });
    const payload = response?.data?.json || response?.data;
    const id = String(payload?.id ?? payload?.room_id ?? '').trim();
    const gmeId = String(payload?.gme_id ?? payload?.gmeId ?? '').trim();
    if (!ROOM_ID_PATTERN.test(id) || !gmeId) {
      throw new Error('YelloTalk did not return a valid created room');
    }
    return normalizeRoom({ ...payload, id, gme_id: gmeId, topic: payload?.topic || name, is_private: false });
  }

  async listPublicRooms(token, { maxRooms = 100 } = {}) {
    const cap = Math.max(1, Math.min(200, Math.trunc(maxRooms)));
    const roomsById = new Map();
    for (let offset = 0; offset < cap; offset += ROOM_PAGE_SIZE) {
      const limit = Math.min(ROOM_PAGE_SIZE, cap - offset);
      const response = await this.popularRooms(token, { limit, offset, isPrivate: false });
      const rooms = responseRooms(response);
      for (const candidate of rooms) {
        const room = normalizeRoom(candidate);
        if (room && !room.isPrivate) roomsById.set(room.id, room);
      }
      if (rooms.length < limit) break;
    }
    return [...roomsById.values()];
  }

  async getRoom(token, roomId) {
    const response = await this.roomDetails(token, roomId);
    const payload = response?.data;
    const candidates = [payload?.json?.room, payload?.json?.data, payload?.json, payload?.room, payload?.data, payload];
    for (const candidate of candidates) {
      const room = normalizeRoom(candidate, roomId);
      if (room) return room;
    }
    return null;
  }
}

module.exports = { FOLLOWING_PAGE_SIZE, MAX_FOLLOWING_USERS, ROOM_PAGE_SIZE, YelloTalkApiClient, normalizeRoom, responseRooms };
