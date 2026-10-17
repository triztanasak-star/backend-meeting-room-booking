const express = require('express');
const validAvatar = require('../avatar');

module.exports = (context) => {
  const router = express.Router();
  const {
    db,
    jwt,
    bcrypt,
    BCRYPT_ROUNDS,
    JWT_SECRET,
    JWT_REFRESH_SECRET,
    JWT_EXPIRES_IN,
    JWT_REFRESH_EXPIRES_IN,
    authMiddleware,
    authRateLimiter,
    buildCookieOptions,
    hashRefreshToken,
    sanitizeUser,
    handleServerError,
    logActivity,
  } = context;

  // Dang ky user moi - mac dinh role 'user'. Tao Admin/Manager phai qua users.routes (requireAdmin).
  router.post('/api/auth/register', authRateLimiter, async (req, res) => {
    try {
      const { name, email, password, avatar_url } = req.body;
      if (!validAvatar(avatar_url)) return res.status(400).json({ message: 'Invalid avatar image' });
      if (!name || !email || !password) {
        return res.status(400).json({ message: 'Missing name, email or password' });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const { rows } = await db.query(
        `INSERT INTO "users" (name, email, role, password_hash, status, avatar_url)
         VALUES ($1, $2, 'user', $3, 'active', $4)
         RETURNING id, name, email, role, status, avatar_url, created_at`,
        [name, email, passwordHash, avatar_url || null],
      );

      await logActivity(req, 'REGISTER', rows[0].id, null, rows[0]);
      return res.status(201).json(sanitizeUser(rows[0]));
    } catch (error) {
      if (db.isUniqueViolation(error)) {
        return res.status(409).json({ message: 'Email already exists' });
      }
      return handleServerError(res, error, 'auth-register');
    }
  });

  router.post('/api/auth/login', authRateLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: 'Missing email or password' });
      }

      const { rows } = await db.query(
        'SELECT id, name, email, role, status, avatar_url, password_hash, created_at FROM "users" WHERE email = $1',
        [email],
      );
      if (!rows.length) return res.status(401).json({ message: 'Invalid email or password' });

      const user = rows[0];
      if (user.status !== 'active') {
        return res.status(403).json({ message: 'Account is not active' });
      }

      const passwordMatches = user.password_hash
        ? await bcrypt.compare(password, user.password_hash)
        : false;
      if (!passwordMatches) return res.status(401).json({ message: 'Invalid email or password' });

      const accessToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      const refreshToken = jwt.sign({ id: user.id }, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.query(
        `INSERT INTO "refresh_tokens" (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, hashRefreshToken(refreshToken), expiresAt],
      );

      res.cookie('dw_refresh_token', refreshToken, buildCookieOptions());
      await logActivity(req, 'LOGIN', user.id, null, { id: user.id });

      return res.json({ token: accessToken, user: sanitizeUser(user) });
    } catch (error) {
      return handleServerError(res, error, 'auth-login');
    }
  });

  router.post('/api/auth/refresh', async (req, res) => {
    try {
      const token = req.cookies?.dw_refresh_token;
      if (!token) return res.status(401).json({ message: 'No refresh token' });

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_REFRESH_SECRET);
      } catch (_err) {
        return res.status(401).json({ message: 'Invalid or expired refresh token' });
      }

      const tokenHash = hashRefreshToken(token);
      const { rows } = await db.query(
        `SELECT * FROM "refresh_tokens"
         WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
        [decoded.id, tokenHash],
      );
      if (!rows.length) return res.status(401).json({ message: 'Refresh token revoked or not found' });

      const newAccessToken = jwt.sign({ id: decoded.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      return res.json({ token: newAccessToken });
    } catch (error) {
      return handleServerError(res, error, 'auth-refresh');
    }
  });

  router.post('/api/auth/logout', authMiddleware, async (req, res) => {
    try {
      const token = req.cookies?.dw_refresh_token;
      if (token) {
        const tokenHash = hashRefreshToken(token);
        await db.query(
          'UPDATE "refresh_tokens" SET revoked_at = NOW() WHERE token_hash = $1',
          [tokenHash],
        );
      }
      res.clearCookie('dw_refresh_token', { path: '/' });
      await logActivity(req, 'LOGOUT');
      return res.json({ success: true });
    } catch (error) {
      return handleServerError(res, error, 'auth-logout');
    }
  });

  router.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
      const { rows } = await db.query(
        'SELECT id, name, email, role, status, avatar_url, created_at FROM "users" WHERE id = $1',
        [req.user.id],
      );
      if (!rows.length) return res.status(404).json({ message: 'User not found' });
      return res.json(sanitizeUser(rows[0]));
    } catch (error) {
      return handleServerError(res, error, 'auth-me');
    }
  });

  return router;
};
