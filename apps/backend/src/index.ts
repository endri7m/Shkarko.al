import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import dotenv from 'dotenv';
import { initCookies } from './pipeline';
import jobsRouter from './routes/jobs';

dotenv.config();

// Write YouTube cookies from env var to disk immediately after env is loaded
initCookies();

const app = express();
const port = Number(process.env.PORT) || 5000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve converted MP3s with explicit CORS so browser <audio> can load them
app.use('/downloads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Accept-Ranges', 'bytes');
  next();
}, express.static('/tmp/shkarko-al/converted', { maxAge: 0 }));

// Also expose under /api/v1/downloads for consistency
app.use('/api/v1/downloads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  next();
}, express.static('/tmp/shkarko-al/converted', { maxAge: 0 }));

app.get('/', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.use('/api/jobs', jobsRouter);
app.use('/api/v1/convert', jobsRouter);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// PORT BINDING FIRST — before any async work so Railway health check passes
app.listen(port, '0.0.0.0', () => {
  console.log(`[Backend] Listening on 0.0.0.0:${port}`);
});
