import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
const queue = new Queue('generations', { connection: redis });

// Durable worker: survives restarts, no duplicate provider calls
const worker = new Worker('generations', async job=>{
  const { generationId, prompt, modelId } = job.data;
  console.log(`[worker] start ${generationId} model ${modelId}`);
  // 1. Load run, confirm reservation exists (postgres)
  // 2. Call OpenRouter/provider with idempotencyKey=job.id
  // 3. Persist provider_request_id, track start/completion, handle timeout (30s image, 120s video)
  // 4. Download result, store to S3 private bucket (object_key = generationId + ext), record checksum
  // 5. Finalize reservation: move held->spent, release unused, ledger entries, mark COMPLETED
  // 6. On failure: release reservation, mark FAILED, do not charge
  // Mock success
  await new Promise(r=>setTimeout(r, 2000));
  console.log(`[worker] completed ${generationId}`);
  return { status:'COMPLETED', cost_micro: 50000 };
}, { connection: redis, concurrency: 2, lockDuration: 30000 });

worker.on('failed', (job, err)=> console.error(`[worker] failed ${job?.id}`, err));
worker.on('completed', job=> console.log(`[worker] done ${job.id}`));

// Graceful shutdown + drain
process.on('SIGTERM', async()=>{ await worker.close(); await queue.close(); process.exit(0); });
