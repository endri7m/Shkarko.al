import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import dotenv from 'dotenv';
import jobsRouter from './routes/jobs';

dotenv.config();

// Ensure download dir exists
const DOWNLOAD_DIR = '/tmp/converted';
try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync('/tmp/raw', { recursive: true }); } catch {}

const app = express();
const port = Number(process.env.PORT) || 5000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve converted MP3s directly — frontend downloads from here
app.use('/downloads', express.static(DOWNLOAD_DIR));

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
