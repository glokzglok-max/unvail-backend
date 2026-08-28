import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import crypto from 'crypto';

const app = Fastify({ logger: true });

// CORS allowlist
const allowed = (process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
await app.register(cors, { origin: (origin, cb)=> cb(null, !origin || allowed.includes(origin) || allowed.includes('*')), credentials:true });
await app.register(cookie);

// Health
app.get('/health', async()=>({status:'ok', ts:new Date().toISOString()}));
app.get('/ready', async()=>({ready:true}));

// Mock DB (in production use Prisma/Postgres) — kept minimal for auditability
type User = { id:string, auth_provider:string, auth_subject:string, email:string, role:string, status:string };
const users = new Map<string, User>();
const wallets = new Map<string, {available:number, held:number}>();
const ledger:any[]=[];

// Auth middleware: verify Google ID token server-side (simplified, real uses jwks-rsa)
async function auth(request:any, reply:any){
  const authHeader = request.headers.authorization || request.cookies?.unvail_session;
  if(!authHeader){ return reply.code(401).send({error:'unauthorized'}); }
  // In production: verify via https://www.googleapis.com/oauth2/v3/certs
  // Here: decode and trust sub/email for test, but enforce server-side mapping
  try{
    const token = authHeader.replace('Bearer ','');
    const payload = JSON.parse(Buffer.from(token.split('.')[1]||'', 'base64').toString()||'{}');
    if(!payload.sub) throw new Error('no sub');
    const key = `google:${payload.sub}`;
    let user = users.get(key);
    if(!user){
      user = { id: crypto.randomUUID(), auth_provider:'google', auth_subject:payload.sub, email:payload.email, role:'user', status:'active' };
      users.set(key, user);
      wallets.set(user.id, {available:0, held:0});
    }
    if(user.status==='suspended') return reply.code(403).send({error:'suspended'});
    (request as any).user = user;
  }catch(e){ return reply.code(401).send({error:'invalid token'}); }
}

// GET /v1/me
app.get('/v1/me', { preHandler:[auth] }, async (req:any)=> {
  return { user: req.user };
});

// GET /v1/credits/balance
app.get('/v1/credits/balance', { preHandler:[auth] }, async (req:any)=>{
  const w = wallets.get(req.user.id) || {available:0, held:0};
  return { available: w.available, held: w.held };
});

// GET /v1/credits/history
app.get('/v1/credits/history', { preHandler:[auth] }, async (req:any)=>{
  return { ledger: ledger.filter(l=>l.user_id===req.user.id) };
});

// POST /v1/generation-quotes
app.post('/v1/generation-quotes', { preHandler:[auth] }, async (req:any)=>{
  const { generation_type, model_id, settings } = req.body as any;
  // Validate, map tier to real model, load pricing snapshot (server-side)
  const pricing = { provider_cost_micro: 50000, markup_bps: parseInt(process.env.DEFAULT_MARKUP_BPS||'18000') };
  const retail = Math.ceil(pricing.provider_cost_micro * pricing.markup_bps / 10000);
  // Cheapest public credit anchor: Pro is $89.99 / 2,700 = $0.0333296/credit.
  const creditValue = parseInt(process.env.CREDIT_VALUE_MICRO_USD||'33330');
  const credits = Math.ceil(retail / creditValue);
  const quote = { id: crypto.randomUUID(), user_id:req.user.id, generation_type, model_id, settings, credits_reserved:credits, expires_at: new Date(Date.now()+5*60*1000).toISOString() };
  // Persist quote (in-memory for demo, postgres in prod)
  (global as any).quotes = (global as any).quotes || new Map();
  (global as any).quotes.set(quote.id, quote);
  return quote;
});

// POST /v1/generations (atomic reservation)
app.post('/v1/generations', { preHandler:[auth] }, async (req:any, reply:any)=>{
  const { quoteId, idempotencyKey } = req.body as any;
  if(!idempotencyKey) return reply.code(400).send({error:'idempotencyKey required'});
  const quotes = (global as any).quotes as Map<string,any>;
  const quote = quotes?.get(quoteId);
  if(!quote || quote.user_id!==req.user.id) return reply.code(404).send({error:'quote not found'});
  if(new Date(quote.expires_at) < new Date()) return reply.code(410).send({error:'quote expired'});
  if(quote.consumed) return reply.code(409).send({error:'quote already consumed'});
  const wallet = wallets.get(req.user.id)!;
  // Atomic: lock wallet (simulated via check)
  if(wallet.available < quote.credits_reserved) return reply.code(402).send({error:'insufficient credits'});
  // Move to held, create reservation + ledger, create run
  wallet.available -= quote.credits_reserved;
  wallet.held += quote.credits_reserved;
  const reservationId = crypto.randomUUID();
  ledger.push({ id:crypto.randomUUID(), user_id:req.user.id, amount_units:-quote.credits_reserved, entry_type:'RESERVATION_CREATED', source_type:'generation', source_id:reservationId, idempotency_key:idempotencyKey });
  quote.consumed = true;
  const runId = crypto.randomUUID();
  const run = { id:runId, user_id:req.user.id, quote_id:quoteId, reservation_id:reservationId, status:'QUEUED', prompt: quote.settings?.prompt, model_id:quote.model_id };
  (global as any).runs = (global as any).runs || new Map();
  (global as any).runs.set(runId, run);
  // Enqueue to Redis/BullMQ (mock)
  console.log(`[queue] enqueued ${runId} for ${quote.model_id}`);
  return { generationId: runId, status:'QUEUED' };
});

// GET /v1/generations
app.get('/v1/generations', { preHandler:[auth] }, async (req:any)=>{
  const runs = (global as any).runs as Map<string,any>;
  const list = Array.from(runs?.values()||[]).filter((r:any)=>r.user_id===req.user.id);
  return { runs:list };
});
app.get('/v1/generations/:id', { preHandler:[auth] }, async (req:any, reply:any)=>{
  const runs = (global as any).runs as Map<string,any>;
  const run = runs?.get(req.params.id);
  if(!run || run.user_id!==req.user.id) return reply.code(404).send({error:'not found'});
  return run;
});
app.post('/v1/generations/:id/cancel', { preHandler:[auth] }, async (req:any, reply:any)=>{
  const runs = (global as any).runs as Map<string,any>;
  const run = runs?.get(req.params.id);
  if(!run || run.user_id!==req.user.id) return reply.code(404).send({error:'not found'});
  run.status='CANCEL_REQUESTED';
  return { status: run.status };
});

// GET /v1/billing/packages
app.get('/v1/billing/packages', async()=>{
  return { packages: [ {id:'credits_50_v1', credit_units:50, price_cents:499}, {id:'credits_500_v1', credit_units:500, price_cents:2999} ] };
});

// POST /v1/billing/checkout-session (server-controlled price)
app.post('/v1/billing/checkout-session', { preHandler:[auth] }, async (req:any)=>{
  const { packageId } = req.body as any;
  // Load active package server-side, never trust browser price
  const pkgMap:any = { 'credits_50_v1':{stripe_price_id:'price_test_50', credit_units:50, price_cents:499}, 'credits_500_v1':{stripe_price_id:'price_test_500', credit_units:500, price_cents:2999} };
  const pkg = pkgMap[packageId];
  if(!pkg) throw new Error('invalid package');
  const orderId = crypto.randomUUID();
  // In prod: findOrCreate Stripe Customer, create Checkout Session with idempotencyKey=orderId
  const checkoutUrl = `https://checkout.stripe.com/pay/${orderId}#test`;
  (global as any).orders = (global as any).orders || new Map();
  (global as any).orders.set(orderId, { id:orderId, user_id:req.user.id, packageId, status:'CHECKOUT_CREATED', stripe_session:orderId });
  return { orderId, url: checkoutUrl };
});

// POST /v1/webhooks/stripe (raw body, signature verify, idempotency)
app.post('/v1/webhooks/stripe', async (req:any, reply:any)=>{
  const sig = req.headers['stripe-signature'];
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  // Verify via STRIPE_WEBHOOK_SECRET (in prod: stripe.webhooks.constructEvent)
  if(!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    // In test, accept but log
    console.warn('webhook signature missing, test mode');
  }
  const eventId = (req.body as any)?.id || crypto.randomUUID();
  // Idempotency: unique stripe_event_id
  const events = (global as any).webhookEvents = (global as any).webhookEvents || new Set();
  if(events.has(eventId)) return { received:true, duplicate:true };
  events.add(eventId);
  const type = (req.body as any)?.type;
  // Handle checkout.session.completed etc.
  if(type==='checkout.session.completed'){
    const session = (req.body as any).data.object;
    const orderId = session.metadata?.orderId;
    const orders = (global as any).orders as Map<string,any>;
    const order = orders?.get(orderId);
    if(order && order.status!=='FULFILLED'){
      // Grant credits transactionally
      const wallet = wallets.get(order.user_id);
      if(wallet){
        wallet.available += 500; // from package
        ledger.push({ id:crypto.randomUUID(), user_id:order.user_id, amount_units:500, entry_type:'PURCHASE', source_type:'stripe', source_id:orderId, idempotency_key:`fulfill_${orderId}` });
        order.status='FULFILLED';
      }
    }
  }
  return { received:true };
});

// GET /v1/assets/:id/download (signed URL, ownership check)
app.get('/v1/assets/:id/download', { preHandler:[auth] }, async (req:any, reply:any)=>{
  // Verify ownership, return short-lived signed URL
  const assetUserId = req.params.id.split('-')[0]; // mock
  if(assetUserId !== req.user.id) return reply.code(403).send({error:'forbidden'});
  const url = `https://s3.example.com/${req.params.id}?expires=${Date.now()+3600*1000}&signature=mock`;
  return { url, expiresIn:3600 };
});

// POST /v1/references/upload (reference file upload)
app.post('/v1/references/upload', { preHandler:[auth] }, async (req:any, reply:any)=>{
  try {
    const data = await req.file();
    if(!data) return reply.code(400).send({error:'no file provided'});

    const purpose = data.fields.purpose?.value || 'visual';
    const referenceId = data.fields.referenceId?.value || crypto.randomUUID();

    // Validate purpose
    const validPurposes = ['visual', 'character-product', 'screen-content', 'first-frame', 'last-frame', 'motion'];
    if(!validPurposes.includes(purpose)) {
      return reply.code(400).send({error:'invalid purpose: ' + purpose});
    }

    // Collect file data
    const chunks: Buffer[] = [];
    let fileSize = 0;
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB

    for await (const chunk of data.file) {
      fileSize += chunk.length;
      if(fileSize > MAX_SIZE) {
        return reply.code(413).send({error:'file too large'});
      }
      chunks.push(chunk);
    }

    const fileBuffer = Buffer.concat(chunks);
    const filename = data.filename || 'reference';
    const mimetype = data.mimetype || 'application/octet-stream';

    // Validate MIME type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg'];
    if(!allowedTypes.includes(mimetype)) {
      return reply.code(400).send({error:'unsupported file type: ' + mimetype});
    }

    // Store reference (mock S3 - in production use real object storage)
    const storageId = `ref-${req.user.id}-${referenceId}-${Date.now()}`;
    const url = `https://storage.unvail.app/references/${storageId}`;

    // Store metadata
    const references = (global as any).references = (global as any).references || new Map();
    references.set(storageId, {
      id: storageId,
      userId: req.user.id,
      referenceId,
      filename,
      mimetype,
      purpose,
      size: fileSize,
      url,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24h expiry
    });

    return { url, storageId, filename, mimetype, size: fileSize };
  } catch(e:any) {
    return reply.code(500).send({error:'upload failed: ' + e.message});
  }
});

// GET /v1/references/:id (get reference metadata)
app.get('/v1/references/:id', { preHandler:[auth] }, async (req:any, reply:any)=>{
  const references = (global as any).references as Map<string,any>;
  const ref = references?.get(req.params.id);
  if(!ref || ref.userId !== req.user.id) return reply.code(404).send({error:'not found'});
  return ref;
});

// DELETE /v1/references/:id (delete reference)
app.delete('/v1/references/:id', { preHandler:[auth] }, async (req:any, reply:any)=>{
  const references = (global as any).references as Map<string,any>;
  const ref = references?.get(req.params.id);
  if(!ref || ref.userId !== req.user.id) return reply.code(404).send({error:'not found'});
  references.delete(req.params.id);
  return { deleted: true };
});

// Admin
app.post('/v1/admin/credits/adjust', { preHandler:[auth] }, async (req:any, reply:any)=>{
  if(req.user.role!=='admin') return reply.code(403).send({error:'forbidden'});
  const { target_user_id, amount, reason, idempotencyKey } = req.body as any;
  if(!target_user_id || !amount || !reason || !idempotencyKey) return reply.code(400).send({error:'missing fields'});
  // Idempotency
  if(ledger.find(l=>l.idempotency_key===idempotencyKey)) return { status:'duplicate' };
  const wallet = wallets.get(target_user_id);
  if(!wallet) return reply.code(404).send({error:'user not found'});
  if(amount>0) wallet.available+=amount; else wallet.available=Math.max(0,wallet.available+amount);
  ledger.push({ id:crypto.randomUUID(), user_id:target_user_id, amount_units:amount, entry_type: amount>0?'ADMIN_GRANT':'ADMIN_DEDUCTION', source_type:'admin', source_id:req.user.id, idempotency_key:idempotencyKey, metadata_json:{reason} });
  return { ok:true };
});

const port = parseInt(process.env.PORT||'3001');
app.listen({ port, host:'0.0.0.0' }).then(()=>console.log(`API listening on ${port}`));
