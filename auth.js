// Auth helpers — JWT signing + verification middleware
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here';
const TOKEN_TTL  = '7d';

// Sign a JWT for an admin account
function signToken(account) {
  return jwt.sign(
    { id: account.id, username: account.username, role: account.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Express middleware: require a valid `Authorization: Bearer <token>` header
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { signToken, requireAuth, bcrypt };
