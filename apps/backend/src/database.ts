import { Pool } from 'pg';
import { ConversionJob, JobStatus, SourceType } from '@sonicflow/shared';
import dotenv from 'dotenv';

// Load environment variables before parsing databaseUrl
dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://sonicflow_user:sonicflow_password@localhost:5432/sonicflow?sslmode=disable';

console.log('[Database] Loaded DATABASE_URL:', databaseUrl.replace(/:[^:@]+@/, ':****@'));

export let useMemoryDb = false;
const memoryDb = new Map<string, ConversionJob>();

// Strip sslmode from URL — we control SSL via the ssl object below to avoid conflicts
const cleanDatabaseUrl = databaseUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');

const isRemoteDb =
  databaseUrl.includes('supabase') ||
  databaseUrl.includes('neon.tech') ||
  databaseUrl.includes('elephantsql') ||
  databaseUrl.includes('pooler') ||
  process.env.DB_SSL === 'true' ||
  process.env.NODE_ENV === 'production';

export const pool = new Pool({
  connectionString: cleanDatabaseUrl,
  connectionTimeoutMillis: 8000,
  // Always use rejectUnauthorized: false for remote hosted DBs (Supabase uses self-signed certs)
  ssl: isRemoteDb ? { rejectUnauthorized: false } : undefined,
});

/**
 * Initialize Postgres database structure. Creates the Enum type and the Table if they do not exist.
 * Automatically falls back to in-memory store if DB is offline after retries.
 */
export async function initDatabase(): Promise<void> {
  let retries = 3;
  let delay = 1500;
  let clientConnected = false;

  while (retries > 0) {
    try {
      console.log(`[Database] Attempting to connect... (Attempts remaining: ${retries})`);
      const testClient = await pool.connect();
      testClient.release();
      clientConnected = true;
      console.log('[Database] PostgreSQL connected successfully.');
      break;
    } catch (error: any) {
      retries--;
      console.warn(`[Database] Connection failed: ${error.message}`);
      if (retries === 0) {
        console.warn('[Database] Unreachable after retries. Activating IN-MEMORY fallback — conversions will still work.');
        useMemoryDb = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 1.5;
    }
  }

  if (!clientConnected) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create custom job_status ENUM if it does not exist
    const enumExists = await client.query(`
      SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status')
    `);
    
    if (!enumExists.rows[0].exists) {
      await client.query(`
        CREATE TYPE job_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')
      `);
    }

    // Create conversion_jobs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversion_jobs (
        id UUID PRIMARY KEY,
        source_type VARCHAR(50) NOT NULL,
        source_name VARCHAR(255) NOT NULL,
        source_url TEXT,
        bitrate INTEGER NOT NULL DEFAULT 320,
        sample_rate INTEGER NOT NULL DEFAULT 44100,
        status job_status NOT NULL DEFAULT 'PENDING',
        progress INTEGER NOT NULL DEFAULT 0,
        s3_key VARCHAR(512),
        error_message TEXT,
        file_size BIGINT,
        duration INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexing for fast queries
    await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_status ON conversion_jobs(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON conversion_jobs(created_at)');

    await client.query('COMMIT');
    console.log('[Database] PostgreSQL database schema verified.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Database] Failed to verify PostgreSQL schema:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Helper to map DB row keys to JS camelCase properties.
 */
function mapRowToJob(row: any): ConversionJob {
  return {
    id: row.id,
    sourceType: row.source_type as SourceType,
    sourceName: row.source_name,
    sourceUrl: row.source_url || undefined,
    bitrate: row.bitrate,
    sampleRate: row.sample_rate,
    status: row.status as JobStatus,
    progress: row.progress,
    s3Key: row.s3_key || undefined,
    errorMessage: row.error_message || undefined,
    fileSize: row.file_size ? parseInt(row.file_size, 10) : undefined,
    duration: row.duration || undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function createJob(
  id: string,
  sourceType: SourceType,
  sourceName: string,
  sourceUrl?: string,
  bitrate: number = 320,
  sampleRate: number = 44100
): Promise<ConversionJob> {
  if (useMemoryDb) {
    const job: ConversionJob = {
      id,
      sourceType,
      sourceName,
      sourceUrl,
      bitrate,
      sampleRate,
      status: 'PENDING',
      progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    memoryDb.set(id, job);
    return job;
  }

  const query = `
    INSERT INTO conversion_jobs (id, source_type, source_name, source_url, bitrate, sample_rate, status, progress)
    VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 0)
    RETURNING *
  `;
  const values = [id, sourceType, sourceName, sourceUrl || null, bitrate, sampleRate];
  const result = await pool.query(query, values);
  return mapRowToJob(result.rows[0]);
}

export async function getJob(id: string): Promise<ConversionJob | null> {
  if (useMemoryDb) {
    return memoryDb.get(id) || null;
  }

  const query = `SELECT * FROM conversion_jobs WHERE id = $1`;
  const result = await pool.query(query, [id]);
  if (result.rows.length === 0) return null;
  return mapRowToJob(result.rows[0]);
}

export async function updateJobProgress(
  id: string,
  progress: number,
  status: JobStatus,
  s3Key?: string,
  errorMessage?: string,
  fileSize?: number,
  duration?: number,
  sourceName?: string
): Promise<void> {
  if (useMemoryDb) {
    const job = memoryDb.get(id);
    if (job) {
      job.progress = progress;
      job.status = status;
      if (s3Key) job.s3Key = s3Key;
      if (errorMessage) job.errorMessage = errorMessage;
      if (fileSize) job.fileSize = fileSize;
      if (duration) job.duration = duration;
      if (sourceName) job.sourceName = sourceName;
      job.updatedAt = new Date().toISOString();
      memoryDb.set(id, job);
    }
    return;
  }

  const query = `
    UPDATE conversion_jobs
    SET progress = $2,
        status = $3,
        s3_key = COALESCE($4, s3_key),
        error_message = COALESCE($5, error_message),
        file_size = COALESCE($6, file_size),
        duration = COALESCE($7, duration),
        source_name = COALESCE($8, source_name),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
  `;
  const values = [
    id,
    progress,
    status,
    s3Key || null,
    errorMessage || null,
    fileSize || null,
    duration || null,
    sourceName || null
  ];
  await pool.query(query, values);
}
