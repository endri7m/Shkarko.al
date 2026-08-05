import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase } from './database';
import jobsRouter from './routes/jobs';
import { apiRateLimiter } from './middleware/rateLimit';
import { initQueue } from './queue';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

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

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'Server is running', version: '1.0.0' });
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled Server Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'An unexpected server error occurred.',
    code: err.code || 'INTERNAL_SERVER_ERROR',
  });
});

async function startServer() {
  try {
    await initDatabase();

    // Explicitly start the in-process job queue/worker
    initQueue();

    app.listen(Number(port), '0.0.0.0', () => {
      console.log(`[SonicFlow Backend] API Server listening on 0.0.0.0:${port}`);
    });
  } catch (error) {
    console.error('Fatal: Server startup failed:', error);
    process.exit(1);
  }
}

startServer();
