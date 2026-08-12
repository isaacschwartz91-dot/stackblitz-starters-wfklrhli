import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';

export function createApp() {
  const app = express();

  // Behind a load balancer, trust the proxy so req.ip and rate limits see the
  // real client address rather than the balancer's.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    // Labels and the tracking page are self-contained HTML with inline styles
    // and data: images; the default CSP would block both.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
  if (!config.isTest) app.use(morgan(config.logFormat));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', env: config.env, time: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/orders', orderRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
