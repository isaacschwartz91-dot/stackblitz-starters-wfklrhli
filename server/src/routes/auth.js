import { Router } from 'express';
import { z } from 'zod';

import { unauthorized } from '../lib/errors.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { signToken } from '../middleware/auth.js';
import * as users from '../repositories/userRepository.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
}).strict();

const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1).max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  role: z.enum(['admin', 'dispatcher', 'driver']),
  phone: z.string().max(40).optional(),
}).strict();

const updateUserSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  phone: z.string().max(40).nullable().optional(),
  role: z.enum(['admin', 'dispatcher', 'driver']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
}).strict();

router.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await users.findByEmailWithHash(email);

  // Compare against a dummy hash when the user is missing so a wrong email and
  // a wrong password take the same amount of time.
  const hash = user?.passwordHash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
  const passwordMatches = await users.verifyPassword(password, hash);

  if (!user || !passwordMatches || !user.isActive) {
    throw unauthorized('Incorrect email or password');
  }

  const { passwordHash: _ignored, ...safeUser } = user;
  res.json({ token: signToken(safeUser), user: safeUser });
});

router.get('/me', authenticate, async (req, res) => {
  const user = await users.findById(req.user.id);
  if (!user || !user.isActive) throw unauthorized('Account is no longer active');
  res.json({ user });
});

// --- User administration ---------------------------------------------------

router.get('/users', authenticate, async (req, res) => {
  // Dispatchers need the driver list to assign work; only admins see everyone.
  if (req.user.role === 'admin') {
    res.json({ users: await users.list({ includeInactive: req.query.includeInactive === 'true' }) });
    return;
  }
  res.json({ users: await users.list({ role: 'driver' }) });
});

router.get('/drivers', authenticate, async (_req, res) => {
  res.json({ drivers: await users.listDriversWithLoad() });
});

router.post('/users', authenticate, requireAdmin, async (req, res) => {
  const data = createUserSchema.parse(req.body);
  res.status(201).json({ user: await users.create(data) });
});

router.patch('/users/:id', authenticate, requireAdmin, async (req, res) => {
  const patch = updateUserSchema.parse(req.body);
  res.json({ user: await users.update(req.params.id, patch) });
});

export default router;
