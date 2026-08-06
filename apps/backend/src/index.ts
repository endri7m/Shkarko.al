import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase } from './database';
import jobsRouter from './routes/jobs';
import { apiRateLimiter } from './middleware/rateLimit';
import { initQueue } from './queue';

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 5000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', apiRateLimiter);
app.use('/api/jobs', jobsRouter);
app.use('/api/v1/convert', jobsRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'Server is running', version: '1.0.0' });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled Server Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'An unexpected server error occurred.',
    code: err.code || 'INTERNAL_SERVER_ERROR',
  });
});

// ---------------------------------------------------------------------------
// Start listening FIRST so Railway health checks pass immediately,
// then init DB and queue in the background.
// ---------------------------------------------------------------------------
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[SonicFlow Backend] Listening on 0.0.0.0:${port}`);

  // Non-blocking background init — server is already accepting requests
  Promise.resolve()
    .then(() => initDatabase())
    .then(() => {
      initQueue();
      console.log('[SonicFlow Backend] Database and queue ready.');
    })
    .catch((err) => {
      console.error('[SonicFlow Backend] Background init error (non-fatal):', err.message);
      // Don't crash — DB fallback is already handled inside initDatabase()
    });
});

// Graceful shutdown on SIGTERM (Railway sends this before killing the container)
process.on('SIGTERM', () => {
  console.log('[SonicFlow Backend] SIGTERM received — shutting down gracefully...');
  server.close(() => {
    console.log('[SonicFlow Backend] HTTP server closed.');
    process.exit(0);
  });
  // Force exit after 10s if connections don't drain
  setTimeout(() => process.exit(0), 10_000).unref();
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
