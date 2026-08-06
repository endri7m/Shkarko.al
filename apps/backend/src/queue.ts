// Queue system replaced by in-memory job tracking in routes/jobs.ts
// This file is kept as a stub to avoid breaking any remaining imports.

export const initQueue = (): void => {
  console.log('[Queue] Using in-memory job tracking (no Redis/BullMQ).');
};
