const express = require('express');
const validAvatar = require('../avatar');

module.exports = (context) => {
  const router = express.Router();
  const {
    db,
    bcrypt,
    BCRYPT_ROUNDS,
    authMiddleware,
    requireAdmin,
    requireManagerOrAdmin,
    isAdmin,
    sanitizeUser,
    handleServerError,
    parsePagination,
    logActivity,
  } = context;

  // List users - Admin/Manager (Manager can du danh sach user de giao task)
  router.get('/api/users', authMiddleware, requireManagerOrAdmin, async (req, res) => {
    try {
      const { page, limit, offset } = parsePagination(req);

      const [countResult, rowsResult] = await Promise.all([
        db.query('SELECT COUNT(*)::int AS total FROM "users"'),
        db.query(
          'SELECT id, name, email, role, status, avatar_url, created_at FROM "users" ORDER BY id DESC LIMIT $1 OFFSET $2',
          [limit, offset],
        ),
      ]);

      return res.json({
        documents: rowsResult.rows.map(sanitizeUser),
        total: countResult.rows[0].total,
        page,
        limit,
      });
    } catch (error) {
      return handleServerError(res, error, 'users-list');
    }
  });

  // Get own profile or (if admin) any user
  router.get('/api/users/:id', authMiddleware, async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      if (!isAdmin(req) && targetId !== req.user.id) {
        return res.status(403).json({ message: 'No permission to view this user' });
      }

      const { rows } = await db.query(
        'SELECT id, name, email, role, status, avatar_url, created_at FROM "users" WHERE id = $1',
        [targetId],
      );
      if (!rows.length) return res.status(404).json({ message: 'User not found' });
      return res.json(sanitizeUser(rows[0]));
    } catch (error) {
      return handleServerError(res, error, 'users-get');
    }
  });

  // Create user - Admin only (can set any role, incl. admin/manager)
  router.post('/api/users', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const { name, email, password, role, avatar_url } = req.body;
      if (!validAvatar(avatar_url)) return res.status(400).json({ message: 'Invalid avatar image' });
      if (!name || !email || !password || !role) {
        return res.status(400).json({ message: 'Missing name, email, password or role' });
      }
      if (!['admin', 'manager', 'user'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const { rows } = await db.query(
        `INSERT INTO "users" (name, email, role, password_hash, status, avatar_url)
         VALUES ($1, $2, $3, $4, 'active', $5)
         RETURNING id, name, email, role, status, avatar_url, created_at`,
        [name, email, role, passwordHash, avatar_url || null],
      );

      await logActivity(req, 'CREATE_USER', rows[0].id, null, rows[0]);
      return res.status(201).json(sanitizeUser(rows[0]));
    } catch (error) {
      if (db.isUniqueViolation(error)) {
        return res.status(409).json({ message: 'Email already exists' });
      }
      return handleServerError(res, error, 'users-create');
    }
  });

  // Update user - Admin only (role, status, name, email); chong leo thang: chi admin moi vao day duoc.
  router.put('/api/users/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      const { name, email, role, status } = req.body;

      if (role && !['admin', 'manager', 'user'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role' });
      }
      if (status && !['active', 'disabled'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }

      const existing = await db.query('SELECT * FROM "users" WHERE id = $1', [targetId]);
      if (!existing.rows.length) return res.status(404).json({ message: 'User not found' });

      const { rows } = await db.query(
        `UPDATE "users"
         SET name = COALESCE($1, name),
             email = COALESCE($2, email),
             role = COALESCE($3, role),
             status = COALESCE($4, status)
         WHERE id = $5
         RETURNING id, name, email, role, status, avatar_url, created_at`,
        [name, email, role, status, targetId],
      );

      await logActivity(req, 'UPDATE_USER', targetId, existing.rows[0], rows[0]);
      return res.json(sanitizeUser(rows[0]));
    } catch (error) {
      if (db.isUniqueViolation(error)) {
        return res.status(409).json({ message: 'Email already exists' });
      }
      return handleServerError(res, error, 'users-update');
    }
  });

  // Disable user (soft) - Admin only, khong xoa vat ly de giu FK lich su (projects.manager_id, digital_works...)
  router.delete('/api/users/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      const existing = await db.query('SELECT * FROM "users" WHERE id = $1', [targetId]);
      if (!existing.rows.length) return res.status(404).json({ message: 'User not found' });

      const { rows } = await db.query(
        `UPDATE "users" SET status = 'disabled' WHERE id = $1
         RETURNING id, name, email, role, status, avatar_url, created_at`,
        [targetId],
      );

      await logActivity(req, 'DISABLE_USER', targetId, existing.rows[0], rows[0]);
      return res.json({ success: true });
    } catch (error) {
      return handleServerError(res, error, 'users-disable');
    }
  });

  return router;
};
