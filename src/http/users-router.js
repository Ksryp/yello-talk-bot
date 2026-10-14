'use strict';

const express = require('express');

// Owner-token-protected access to the UUID-keyed user database that is filled
// whenever the bot fetches names from YelloTalk.
function createUsersRouter({ ownerAuth, userDirectory } = {}) {
  if (typeof ownerAuth !== 'function') throw new TypeError('ownerAuth middleware is required');
  if (!userDirectory) throw new TypeError('userDirectory is required');
  const router = express.Router();

  // GET /api/users?q=&limit= — all known users. `q` matches the current name,
  // any previously used name, or the UUID.
  router.get('/api/users', ownerAuth, (req, res) => {
    const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit, 10) || 500));
    const q = String(req.query.q || '').trim().toLowerCase();
    let users = userDirectory.all();
    if (q) {
      users = users.filter(u => u.name.toLowerCase().includes(q)
        || u.uuid.toLowerCase().includes(q)
        || u.previousNames.some(n => n.toLowerCase().includes(q)));
    }
    users.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ count: userDirectory.size, returned: Math.min(users.length, limit), users: users.slice(0, limit) });
  });

  // GET /api/users/:uuid — one user with full name history.
  router.get('/api/users/:uuid', ownerAuth, (req, res) => {
    const user = userDirectory.get(req.params.uuid);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ user });
  });

  return router;
}

module.exports = { createUsersRouter };
