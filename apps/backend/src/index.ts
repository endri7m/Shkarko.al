import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase } from './database';
import jobsRouter from './routes/jobs';
import { apiRateLimiter } from './middleware/rateLimit';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Enable CORS with preflight supports
app.use(cors({
  origin: '*', // In production, replace with specific domain origins
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Express parses JSON and urlencoded payloads
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global rate limiting for API endpoint routes
app.use('/api', apiRateLimiter);

// Bind Job conversion routes
app.use('/api/jobs', jobsRouter);
app.use('/api/v1/convert', jobsRouter);

// Basic health check route
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// Root route - confirms server is reachable
app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'Server is running', version: '1.0.0' });
});

// Global Error Handling Middleware (Enterprise boundary)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled Server Error:', err);

  const status = err.status || 500;
  const message = err.message || 'An unexpected server error occurred. Please try again.';

  res.status(status).json({
    error: message,
    code: err.code || 'INTERNAL_SERVER_ERROR',
  });
});

// Start DB connection & listen
async function startServer() {
  try {
    await initDatabase();
    
    app.listen(Number(port), '0.0.0.0', () => {
      console.log(`[SonicFlow Backend] API Server listening on 0.0.0.0:${port}`);
    });
  } catch (error) {
    console.error('Fatal: Server startup failed due to database connection issue:', error);
    process.exit(1);
  }
}

startServer();
