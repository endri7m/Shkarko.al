import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initCookies } from './pipeline';
import jobsRouter from './routes/jobs';

dotenv.config();
initCookies();

const app  = express();
const port = Number(process.env.PORT) || 5000;

const corsOptions = { origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Range', 'Authorization'] };

// Handle ALL preflight requests before any route
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Static MP3 file serving — explicit headers so browser <audio> + download work
// ---------------------------------------------------------------------------
const audioHeaders = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Accept-Ranges',  'bytes');
  res.setHeader('Content-Type',   'audio/mpeg');
  res.setHeader('Cache-Control',  'no-cache');
  next();
};

app.use('/downloads',         audioHeaders, express.static('/tmp/shkarko-al/converted', { maxAge: 0 }));
app.use('/api/v1/downloads',  audioHeaders, express.static('/tmp/shkarko-al/converted', { maxAge: 0 }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/',       (_req, res) => res.json({ status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.use('/api/jobs',      jobsRouter);
app.use('/api/v1/convert', jobsRouter);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// Bind port first so Railway health check passes immediately
app.listen(port, '0.0.0.0', () => {
  console.log(`[Backend] Listening on 0.0.0.0:${port}`);
});
