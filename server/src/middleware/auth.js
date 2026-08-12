import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.fullName },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

function readBearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

/** Rejects the request unless it carries a valid, unexpired token. */
export function authenticate(req, _res, next) {
  const token = readBearerToken(req);
  if (!token) {
    next(unauthorized('Missing bearer token'));
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, role: payload.role, fullName: payload.name };
    next();
  } catch (err) {
    next(
      unauthorized(
        err.name === 'TokenExpiredError' ? 'Session expired, sign in again' : 'Invalid token',
      ),
    );
  }
}

/** Route guard: `requireRole('admin', 'dispatcher')`. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(
        forbidden(
          `This action requires one of the following roles: ${roles.join(', ')}`,
        ),
      );
      return;
    }
    next();
  };
}

export const requireAdmin = requireRole('admin');
export const requireStaff = requireRole('admin', 'dispatcher');
export const requireAnyRole = requireRole('admin', 'dispatcher', 'driver');
