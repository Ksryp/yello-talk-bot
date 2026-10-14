'use strict';

// A tiny JSON-file user database keyed by UUID. It records only WHICH NAME each
// UUID currently uses and WHICH NAMES it has used before — no timestamps, no
// join/leave history. When a known UUID is seen with a different name, the old
// name is moved into previousNames and the current name is updated. Writes are
// debounced and atomic (write temp + rename).

const fs = require('fs');
const path = require('path');

const MAX_PREVIOUS_NAMES = 25;

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// UUIDs are case-insensitive; normalise to upper case so the same person is a
// single row regardless of how a given endpoint cased their id.
function cleanUuid(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 128 || /[\u0000-\u001F\u007F]/.test(id)) return '';
  return id.toUpperCase();
}

function dedupe(names) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.slice(-MAX_PREVIOUS_NAMES);
}

class UserDirectory {
  constructor({ filePath, fsImpl = fs, saveDelayMs = 500 } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    this.filePath = path.resolve(filePath);
    this.fs = fsImpl;
    this.saveDelayMs = saveDelayMs;
    this.users = new Map();
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.users) ? parsed.users : [];
      for (const row of rows) {
        const uuid = cleanUuid(row?.uuid);
        if (!uuid) continue;
        // Accept the current shape (previousNames) and migrate the old one
        // (nameHistory: [{ name }]).
        const previousRaw = Array.isArray(row?.previousNames)
          ? row.previousNames
          : Array.isArray(row?.nameHistory)
            ? row.nameHistory.map(entry => entry?.name)
            : [];
        this.users.set(uuid, {
          uuid,
          name: cleanName(row?.name),
          previousNames: dedupe(previousRaw.map(cleanName)),
        });
      }
    } catch { /* missing or corrupt file -> start empty */ }
  }

  // Upsert one user by UUID. Returns { uuid, isNew, changed, previousName } or
  // null if the id is unusable.
  record(uuid, name) {
    const id = cleanUuid(uuid);
    if (!id) return null;
    const nextName = cleanName(name);
    const existing = this.users.get(id);

    if (!existing) {
      this.users.set(id, { uuid: id, name: nextName, previousNames: [] });
      this.scheduleSave();
      return { uuid: id, isNew: true, changed: false, previousName: null };
    }

    if (!nextName || nextName === existing.name) {
      return { uuid: id, isNew: false, changed: false, previousName: null };
    }

    const previousName = existing.name;
    if (existing.name) existing.previousNames.push(existing.name);
    // If the new name is one they used before, drop it from the history so the
    // list stays "names NOT currently in use".
    existing.previousNames = dedupe(existing.previousNames).filter(n => n !== nextName);
    existing.name = nextName;
    this.scheduleSave();
    return { uuid: id, isNew: false, changed: true, previousName: previousName || null };
  }

  recordMany(items) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      const result = this.record(item?.uuid, item?.name);
      if (result) out.push(result);
    }
    return out;
  }

  get(uuid) { return this.users.get(cleanUuid(uuid)) || null; }
  all() { return [...this.users.values()]; }
  get size() { return this.users.size; }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, this.saveDelayMs);
    if (typeof this.saveTimer?.unref === 'function') this.saveTimer.unref();
  }

  saveNow() {
    try {
      this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload = { count: this.users.size, users: this.all() };
      const tmp = `${this.filePath}.tmp`;
      this.fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      this.fs.renameSync(tmp, this.filePath);
    } catch { /* best effort; a failed write is retried on the next change */ }
  }

  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.saveNow();
  }
}

module.exports = { UserDirectory, cleanName, cleanUuid, MAX_PREVIOUS_NAMES };
