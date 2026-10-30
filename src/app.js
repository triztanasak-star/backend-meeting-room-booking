require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');


const db = require('./db');
const notificationService = require('./services/notificationService');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD_LIKE = NODE_ENV !== 'development';

const ensureSecret = (name, minLength = 32) => {
  const value = process.env[name];
  if (value && value.length >= minLength) return value;
  if (IS_PROD_LIKE) {
    throw new Error(`${name} is required and must be at least ${minLength} chars in ${NODE_ENV}`);
  }
  return crypto.randomBytes(minLength).toString('hex');
};

const JWT_SECRET = ensureSecret('JWT_SECRET', 32);
const JWT_REFRESH_SECRET = ensureSecret('JWT_REFRESH_SECRET', 32);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const BCRYPT_ROUNDS = Number.parseInt(process.env.BCRYPT_ROUNDS, 10) || 12;

const app = express();

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// 1. Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (IS_PROD_LIKE) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// 2. CORS
const sanitizeOrigin = (value) => value.trim().replace(/\/+$/, '');

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'https://dash-board.vercel.app',
];

const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .map(sanitizeOrigin);

const allowedOrigins = envOrigins.length > 0
  ? envOrigins
  : DEFAULT_CORS_ORIGINS.map(sanitizeOrigin);

console.log('[CORS] Allowed origins:', allowedOrigins);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const normalized = sanitizeOrigin(origin);

    if (!IS_PROD_LIKE && allowedOrigins.length === 0) return callback(null, true);

    if (allowedOrigins.includes(normalized)) return callback(null, true);

    if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalized)) {
      return callback(null, true);
    }

    console.warn('[CORS] Blocked origin:', normalized);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token', 'X-Requested-With'],
  exposedHeaders: ['Authorization'],
  maxAge: 86400,
}));

app.options('/*splat', cors());

// 3. Body parser
app.use(express.json({ limit: process.env.JSON_LIMIT || '1mb' }));

// 4. Cookie parser
app.use(cookieParser());

// --- Helpers dung chung (context) ---

const handleServerError = (res, error, scope = 'server-error') => {
  console.error(`[${scope}]`, error);
  return res.status(500).json({ message: 'Internal server error' });
};

const parsePagination = (req, defaultLimit = 50, maxLimit = 200) => {
  const toIntSafe = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const page = Math.max(toIntSafe(req.query.page, 1), 1);
  const requestedLimit = Math.max(toIntSafe(req.query.limit, defaultLimit), 1);
  const limit = Math.min(requestedLimit, maxLimit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

const logActivity = async (req, action, targetId = null, oldValues = null, newValues = null) => {
  try {
    let userId = req.user ? req.user.id : null;
    if (!userId && newValues?.id) userId = newValues.id;

    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    await db.query(
      `INSERT INTO "activity_logs"
       (user_id, action, target_id, old_values, new_values, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, action, targetId, oldValues, newValues, ipAddress, userAgent],
    );
  } catch (error) {
    console.error('Loi khi ghi log:', error);
  }
};

// --- Auth middleware & permission helpers ---

const authMiddleware = async (req, res, next) => {
  let token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    token = req.cookies?.dw_access_token
         || req.cookies?.access_token
         || req.cookies?.token;
  }

  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { rows } = await db.query(
      'SELECT id, role, status FROM "users" WHERE id = $1',
      [decoded.id],
    );

    if (!rows.length) return res.status(401).json({ message: 'User not found' });

    const user = rows[0];
    if (user.status !== 'active') {
      return res.status(403).json({ message: 'Account is not active' });
    }

    req.user = { id: user.id, role: user.role };
    return next();
  } catch (_error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

const isAdmin = (req) => req.user?.role === 'admin';
const isManagerOrAdmin = (req) => ['admin', 'manager'].includes(req.user?.role);

const requireAdmin = (req, res, next) => {
  if (!isAdmin(req)) return res.status(403).json({ message: 'Admin permission required' });
  return next();
};

const requireManagerOrAdmin = (req, res, next) => {
  if (!isManagerOrAdmin(req)) {
    return res.status(403).json({ message: 'Admin or manager permission required' });
  }
  return next();
};

// --- Rate limiting (in-memory, co gioi han size) ---

const rateStore = new Map();
const RATE_STORE_MAX = 5000;

setInterval(() => {
  const now = Date.now();
  for (const [key, state] of rateStore.entries()) {
    if (state.expiresAt <= now) rateStore.delete(key);
  }
}, 5 * 60 * 1000).unref();

const createRateLimiter = ({ windowMs, maxRequests, scope }) => (req, res, next) => {
  const emailKey = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
  const key = `${scope}:${emailKey || req.ip}`;
  const now = Date.now();
  const existing = rateStore.get(key);

  if (!existing || existing.expiresAt <= now) {
    if (rateStore.size >= RATE_STORE_MAX) {
      const firstKey = rateStore.keys().next().value;
      if (firstKey) rateStore.delete(firstKey);
    }
    rateStore.set(key, { count: 1, expiresAt: now + windowMs });
    return next();
  }

  if (existing.count >= maxRequests) {
    return res.status(429).json({ message: 'Too many requests, please try again later.' });
  }

  existing.count += 1;
  return next();
};

const authRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10, scope: 'auth' });

// --- Cookie helper cho refresh token ---

const buildCookieOptions = () => ({
  httpOnly: true,
  secure: IS_PROD_LIKE,
  sameSite: IS_PROD_LIKE ? 'none' : 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

const hashRefreshToken = (token) =>
  crypto.createHmac('sha256', JWT_REFRESH_SECRET).update(token).digest('hex');

const sanitizeUser = (u) => ({
  $id: String(u.id),
  id: u.id,
  name: u.name,
  avatar_url: u.avatar_url || null,
  email: u.email,
  role: u.role,
  status: u.status,
  created_at: u.created_at,
});

const context = {
  db,
  notificationService,
  jwt,
  bcrypt,
  BCRYPT_ROUNDS,
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN,
  IS_PROD_LIKE,
  authMiddleware,
  isAdmin,
  isManagerOrAdmin,
  requireAdmin,
  requireManagerOrAdmin,
  authRateLimiter,
  buildCookieOptions,
  hashRefreshToken,
  sanitizeUser,
  handleServerError,
  parsePagination,
  logActivity,
};

// 5. Mount routes
app.use(require('./routes/auth.routes')(context));
app.use(require('./routes/users.routes')(context));
app.use(require('./routes/meetings.routes')(context));
app.use(require('./routes/vehicles.routes')(context));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    env: NODE_ENV,
    time: new Date().toISOString(),
    cors: allowedOrigins,
  });
});

// Dev-only test DB
if (!IS_PROD_LIKE) {
  app.get('/api/auth/test', async (_req, res) => {
    try {
      await db.query('SELECT NOW()');
      return res.json({ message: 'DB connection is healthy' });
    } catch (error) {
      return handleServerError(res, error, 'auth-test');
    }
  });
}

// 6. Global error handler
app.use((error, _req, res, _next) => {
  if (error?.message?.includes('CORS')) {
    return res.status(403).json({ message: 'CORS blocked this request origin' });
  }
  return handleServerError(res, error, 'unhandled-middleware');
});

const path = require('path');

// Route xử lý riêng để mở/tải file từ thư mục uploads an toàn
app.get('/uploads/:folder/:filename', (req, res) => {
  try {
    const { folder, filename } = req.params;
    const filePath = path.join(__dirname, '../uploads', folder, filename);

    res.sendFile(filePath, (err) => {
      if (err) {
        return res.status(404).json({ message: 'Không tìm thấy file trên server' });
      }
    });
  } catch (error) {
    return res.status(500).json({ message: 'Lỗi tải file' });
  }
});

module.exports = app;
