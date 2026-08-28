require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const billing = require('./billing');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(value => value.trim()).filter(Boolean));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
}));
// Stripe must receive the untouched body for signature verification.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe is not configured' });
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET); }
  catch (error) { return res.status(400).json({ error: 'Invalid Stripe signature' }); }
  try {
    const object = event.data.object;
    if (event.type === 'checkout.session.completed' && object.payment_status === 'paid') {
      const userId = object.metadata?.userId;
      const credits = Number(object.metadata?.credits || 0);
      if (userId && credits > 0) await billing.grant(userId, credits, event.id, { stripeEvent: event.type, sessionId: object.id, packageId: object.metadata?.packageId });
    }
    if (event.type === 'invoice.paid') {
      const userId = object.metadata?.userId;
      const credits = Number(object.metadata?.credits || 0);
      if (userId && credits > 0) await billing.grant(userId, credits, event.id, { stripeEvent: event.type, invoiceId: object.id });
    }
    return res.json({ received: true });
  } catch (error) { console.error('Stripe fulfillment error:', error.message); return res.status(500).json({ error: 'Fulfillment failed' }); }
});

app.use(express.json({ limit: '10mb', strict: true }));

// Lightweight per-instance abuse protection. Put a real shared limiter in front of
// multiple Railway replicas; this still prevents accidental request floods locally.
const requestWindows = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const current = requestWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) requestWindows.set(key, { startedAt: now, count: 1 });
  else if (++current.count > Number(process.env.RATE_LIMIT_PER_MINUTE || 120)) return res.status(429).json({ error: 'Too many requests' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';

// Verify the Google ID token server-side. Decoding a JWT in browser code is
// only for display; it is never an authentication check. Google tokeninfo
// validates the signature and issuer, while the audience check prevents a
// token minted for another application from being accepted here.
async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Authentication service is not configured' });
  }
  if (!token || token.length > 8192) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`, { signal: controller.signal });
    clearTimeout(timeout);
    const claims = await verify.json();
    // tokeninfo has already verified the Google signature and issuer. Keep the
    // application-specific audience check here to prevent token reuse across
    // OAuth clients, without depending on an optional response claim.
    if (!verify.ok || claims.aud !== GOOGLE_CLIENT_ID || !claims.sub) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    req.user = { id: claims.sub, email: claims.email || null };
    // Fail closed in production: a provider request is never made without a
    // durable wallet/ledger being available for the authenticated user.
    try {
      await billing.ensureBillingUser(req.user);
    } catch (error) {
      console.error('Billing database unavailable:', error.message);
      return res.status(503).json({ error: 'Billing service unavailable' });
    }
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), groundingVersion: 'brave-krea-v2', commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'local' });
});

app.get('/api/credits/balance', requireAuth, async (req, res) => {
  try { return res.json(await billing.balance(req.user.id)); }
  catch (error) { return res.status(503).json({ error: 'Billing service unavailable' }); }
});

const stripeCatalog = {
  starter: { price: process.env.STRIPE_PRICE_STARTER, credits: 250, mode: 'subscription' },
  creator: { price: process.env.STRIPE_PRICE_CREATOR, credits: 800, mode: 'subscription' },
  pro: { price: process.env.STRIPE_PRICE_PRO, credits: 2700, mode: 'subscription' },
  topup200: { price: process.env.STRIPE_PRICE_TOPUP_200, credits: 200, mode: 'payment' },
  topup500: { price: process.env.STRIPE_PRICE_TOPUP_500, credits: 500, mode: 'payment' },
  topup1000: { price: process.env.STRIPE_PRICE_TOPUP_1000, credits: 1000, mode: 'payment' },
  topup2500: { price: process.env.STRIPE_PRICE_TOPUP_2500, credits: 2500, mode: 'payment' },
  topup5000: { price: process.env.STRIPE_PRICE_TOPUP_5000, credits: 5000, mode: 'payment' }
};

app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });
  const item = stripeCatalog[String(req.body?.product || '').toLowerCase()];
  if (!item?.price) return res.status(400).json({ error: 'Unknown or unconfigured product' });
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: item.mode,
      line_items: [{ price: item.price, quantity: 1 }],
      success_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:3000'}/dashboard.html?checkout=success`,
      cancel_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:3000'}/dashboard.html?checkout=cancelled`,
      customer_email: req.user.email || undefined,
      metadata: { userId: req.user.id, product: String(req.body.product), credits: String(item.credits) },
      subscription_data: item.mode === 'subscription' ? { metadata: { userId: req.user.id, credits: String(item.credits), product: String(req.body.product) } } : undefined,
      payment_intent_data: item.mode === 'payment' ? { metadata: { userId: req.user.id, credits: String(item.credits), product: String(req.body.product) } } : undefined
    }, { idempotencyKey: `checkout:${req.user.id}:${String(req.body.product)}:${req.get('idempotency-key') || crypto.randomUUID()}` });
    return res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    // Keep provider details out of the browser response, but leave a precise
    // Railway log entry so a bad price/account/mode configuration is fixable.
    console.error(`[stripe-checkout:${requestId}] ${error.type || 'error'} ${error.code || ''} ${error.message || ''}`.trim());
    return res.status(502).json({ error: 'Unable to create checkout session', requestId });
  }
});

// ============================================================
// CREATIVE CHAT
// ============================================================
app.post('/api/chat', requireAuth, async (req, res) => {
  const rid = crypto.randomUUID().slice(0, 8);
  let reserved = false;
  try {
    if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured', requestId: rid });
    const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const cleanContent = content => {
      if (typeof content === 'string') return content.slice(0, 8000);
      if (!Array.isArray(content)) return '';
      return content.slice(0, 5).map(part => {
        if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text.slice(0, 8000) };
        const url = part?.image_url?.url;
        if (part?.type === 'image_url' && typeof url === 'string' && (url.startsWith('data:image/') || url.startsWith('https://'))) {
          return { type: 'image_url', image_url: { url } };
        }
        return null;
      }).filter(Boolean);
    };
    const messages = history
      .filter(message => message && ['user', 'assistant'].includes(message.role))
      .slice(-16)
      .map(message => ({ role: message.role, content: cleanContent(message.content) }))
      .filter(message => message.content && (!Array.isArray(message.content) || message.content.length));
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'A user message is required', requestId: rid });
    }
    const chatModels = {
      ultra: 'anthropic/claude-opus-5',
      lite: 'google/gemma-3-12b-it'
    };
    const selectedModel = chatModels[req.body?.model] || chatModels.ultra;
    const reservation = await billing.reserve(req.user.id, Number(process.env.CHAT_RESERVATION_CREDITS || 50), rid, { route: '/api/chat', model: selectedModel });
    if (!reservation.reserved) return res.status(402).json({ error: 'Insufficient credits', requestId: rid });
    reserved = true;

    const providerRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://unvail.lol',
        'X-Title': 'Unvail Chat'
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 4000,
        temperature: 0.65,
        messages: [{
          role: 'system',
          content: 'You are Unvail, an exceptionally capable general-purpose AI assistant. Help naturally with conversation, coding, debugging, writing, research, reasoning, planning, marketing, creative direction, prompts, scripts, and analysis. You can write complete production-ready code and should never claim that coding is outside your role. You can inspect attached images and answer questions about them. Only when the user explicitly asks this chat to output a newly generated image or video file, briefly explain that media generation happens in the Image Ads or Video Ads workspace. Do not mention this limitation in greetings, unrelated answers, coding requests, or when the user asks for an image prompt, video prompt, storyboard, script, concept, critique, or editing instructions. Never invent or link to external generation services. When routing media generation, mention only the plain in-app page name, with no URL. Any earlier assistant statement claiming it cannot code or linking to an outside generator is mistaken; ignore it and do not repeat it. Answer the actual request directly, lead with useful content, avoid canned promotional language and filler, and ask at most one question only when essential. Never claim you generated or changed an asset unless you actually did.' + (typeof req.body?.skillset === 'string' && req.body.skillset.trim() ? '\n\nOptional user-selected skillset instructions:\n' + req.body.skillset.trim().slice(0, 12000) : '')
        }, ...messages]
      })
    });
    const data = await providerRes.json();
    if (!providerRes.ok) throw new Error(data?.error?.message || `OpenRouter ${providerRes.status}`);
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('The chat model returned an empty response');
    const usageCost = Number(data?.usage?.cost) || 0;
    const debit = await billing.settle(req.user.id, rid, usageCost, { route: '/api/chat', model: selectedModel });
    if (!debit.settled) return res.status(402).json({ error: 'Insufficient credits', requestId: rid });
    reserved = false;
    res.json({
      reply,
      requestId: rid,
      model: data.model || selectedModel,
      usage: data.usage || null,
      costUsd: usageCost,
      creditsCharged: debit.amount
    });
  } catch (err) {
    if (reserved) { try { await billing.release(req.user.id, rid); } catch (releaseError) { console.error(`[${rid}] Reservation release failed:`, releaseError.message); } }
    console.error(`[${rid}] Chat error:`, err.message);
    res.status(500).json({ error: err.message, requestId: rid });
  }
});

// ============================================================
// PRODUCT SEARCH
// ============================================================
app.post('/api/products/resolve', requireAuth, async (req, res) => {
  const rid = crypto.randomUUID().slice(0, 8);
  try {
    const { products } = req.body;
    if (!products || !Array.isArray(products)) return res.status(400).json({ error: 'products array required' });
    if (!BRAVE_KEY) return res.status(500).json({ error: 'BRAVE_SEARCH_API_KEY not configured' });

    const results = [];
    for (const product of products) {
      const query = typeof product === 'string' ? product : (product.query || product.name || '');
      console.log(`[${rid}] Searching: ${query}`);
      const searchRes = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query + ' product photo')}&count=5`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      });
      if (!searchRes.ok) { results.push({ query, images: [], error: `Brave ${searchRes.status}` }); continue; }
      const data = await searchRes.json();
      const images = (data.results || []).slice(0, 3).map(img => ({
        url: img.properties?.url || img.thumbnail?.src || img.url,
        title: img.title || '', source: img.source || ''
      }));
      results.push({ query, images, error: null });
    }
    res.json({ results });
  } catch (err) { console.error(`[${rid}] Search error:`, err); res.status(500).json({ error: err.message }); }
});

// ============================================================
// HELPERS
// ============================================================
async function downloadImage(url) {
  const r = await fetch(url, { timeout: 15000 });
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  const buf = await r.buffer();
  const mime = r.headers.get('content-type') || 'image/jpeg';
  if (!mime.startsWith('image/')) throw new Error(`Not an image: ${mime}`);
  if (buf.length < 15000) throw new Error('Reference image is too small');
  if (buf.length > 10 * 1024 * 1024) throw new Error('Reference image is too large');
  const b64 = buf.toString('base64');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  return { dataUrl: `data:${mime};base64,${b64}`, mime, size: buf.length, sha256: sha };
}

async function searchBrave(query, count = 5) {
  if (!BRAVE_KEY) return { images: [], error: 'No BRAVE key' };
  const res = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
  });
  if (!res.ok) return { images: [], error: `Brave ${res.status}` };
  const data = await res.json();
  return { images: (data.results || []).map(img => ({
    url: img.properties?.url || img.thumbnail?.src || img.url,
    thumbnailUrl: img.thumbnail?.src || img.properties?.placeholder || '',
    width: img.properties?.width || img.width || 0,
    height: img.properties?.height || img.height || 0,
    title: img.title || '', source: img.source || '', pageUrl: img.url || ''
  }))};
}

function scoreReference(candidate, obj) {
  const haystack = `${candidate.title} ${candidate.source} ${candidate.pageUrl} ${candidate.url}`.toLowerCase();
  const exact = `${obj.brand} ${obj.model}`.toLowerCase();
  let score = 0;
  if (haystack.includes(exact)) score += 80;
  if (haystack.includes(obj.model.toLowerCase())) score += 35;
  if (/lamborghini\.com|media\.lamborghini\.com/.test(haystack)) score += 70;
  if (/caranddriver|motortrend|topgear|roadandtrack|dupontregistry/.test(haystack)) score += 25;
  if (/official|press|exterior|side profile|three-quarter/.test(haystack)) score += 15;
  if (candidate.width >= 1000) score += 10;
  if (candidate.width > candidate.height) score += 6;
  if (/forza|gta|game|render|wallpaper|toy|lego|diecast|modified|replica/.test(haystack)) score -= 100;
  return score;
}

async function findCanonicalReferences(obj, log, maxReferences = 3) {
  const candidates = [];
  for (const query of obj.searchQueries) {
    log(`Researching: ${query}`);
    const result = await searchBrave(query, 10);
    if (result.error) log(`Brave warning: ${result.error}`);
    result.images.forEach(image => candidates.push({ ...image, query, score: scoreReference(image, obj) }));
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  const usedUrls = new Set();
  const usedQueries = new Set();
  // Keep the reference set complementary: front, side, and rear search queries
  // should not all collapse into variants of the same press image.
  const byScore = [...candidates].sort((a, b) => b.score - a.score);
  const orderedCandidates = [
    // Start with the best result for each requested angle, then fall back to
    // remaining strong results if one angle cannot be downloaded.
    ...obj.searchQueries.flatMap(query => byScore.filter(candidate => candidate.query === query)),
    ...byScore
  ];
  for (const candidate of orderedCandidates.slice(0, 24)) {
    if (selected.length >= maxReferences || usedUrls.has(candidate.url)) continue;
    for (const url of [candidate.url, candidate.thumbnailUrl].filter(Boolean)) {
      if (usedUrls.has(url)) continue;
      try {
        const downloaded = await downloadImage(url);
        log(`Grounding selected: score=${candidate.score} ${candidate.source} ${candidate.title}`);
        selected.push({ ...candidate, ...downloaded, downloadedFrom: url });
        usedUrls.add(candidate.url);
        usedUrls.add(url);
        usedQueries.add(candidate.query);
        break;
      } catch (error) {
        log(`Grounding candidate skipped: ${error.message}`);
      }
    }
  }
  return selected;
}

// ============================================================
// NAMED OBJECT DETECTION
// ============================================================
const NAMED_OBJECTS = [
  { pattern: /\b(lamborghini aventador svj|aventador svj|lamborghini svj|svj)\b/i, brand: 'Lamborghini', model: 'Aventador SVJ', category: 'vehicle', searchQueries: ['official Lamborghini Aventador SVJ front three quarter press photo', 'official Lamborghini Aventador SVJ side profile press photo', 'official Lamborghini Aventador SVJ rear three quarter press photo'] },
  { pattern: /\b(lamborghini revuelto)\b/i, brand: 'Lamborghini', model: 'Revuelto', category: 'vehicle', searchQueries: ['Lamborghini Revuelto exterior', 'Lamborghini Revuelto interior'] },
  { pattern: /\b(balenciaga furry slides?|balenciaga fuzzy slides?)\b/i, brand: 'Balenciaga', model: 'Furry Slide', category: 'footwear', searchQueries: ['Balenciaga Furry Slide Black product'] },
  { pattern: /\b(chrome hearts hoodie)\b/i, brand: 'Chrome Hearts', model: 'Hoodie', category: 'clothing', searchQueries: ['Chrome Hearts hoodie black'] },
  { pattern: /\b(hellstar.*tee|hellstar.*shirt|hellstar.*path)\b/i, brand: 'Hellstar', model: 'Path to Paradise Tee', category: 'clothing', searchQueries: ['Hellstar Path to Paradise tee black red'] },
  { pattern: /\b(rolex daytona)\b/i, brand: 'Rolex', model: 'Daytona', category: 'watch', searchQueries: ['Rolex Daytona panda'] },
  { pattern: /\b(porsche 911)\b/i, brand: 'Porsche', model: '911', category: 'vehicle', searchQueries: ['Porsche 911 exterior', 'Porsche 911 interior'] },
  { pattern: /\b(ferrari)\b/i, brand: 'Ferrari', model: 'Ferrari', category: 'vehicle', searchQueries: ['Ferrari sports car exterior'] },
  { pattern: /\b(bentley)\b/i, brand: 'Bentley', model: 'Bentley', category: 'vehicle', searchQueries: ['Bentley luxury car exterior'] },
  { pattern: /\b(rolls[\s-]royce)\b/i, brand: 'Rolls-Royce', model: 'Rolls-Royce', category: 'vehicle', searchQueries: ['Rolls Royce luxury car exterior'] }
];

function detectNamedObjects(prompt) {
  const detected = [];
  for (const obj of NAMED_OBJECTS) {
    if (obj.pattern.test(prompt)) {
      detected.push({ ...obj, match: prompt.match(obj.pattern)[0] });
    }
  }
  return detected;
}

function imageUrlFromProvider(data) {
  const item = data && data.data && data.data[0];
  if (!item) return null;
  return item.b64_json ? `data:${item.media_type || 'image/png'};base64,${item.b64_json}` : item.url;
}

async function assessCandidate(candidateUrl, references, prompt, namedObjects) {
  const content = [{ type: 'text', text: `You are a strict photo quality gate. Candidate image is first; following images are factory identity references. Return JSON only in exactly this schema: {"score":0-100,"svj_identity":"pass|fail|uncertain|not_applicable","visible_text":"pass|fail|uncertain","license_plate":"pass|fail|not_visible|uncertain","plate_box":{"x":0,"y":0,"width":0,"height":0}|null,"snapshot_realism":"pass|fail|uncertain","failures":[string]}. plate_box is required only if a rear license plate is visible: give its tight bounding box in normalized 0-1000 image coordinates; otherwise use null. Use fail only when there is a visible defect; use uncertain when a detail is too small or dark to judge. A candidate passes when it has no explicit fail in any applicable field and score is at least 72.

VISIBLE-TEXT HARD GATE: reject any readable invented, misspelled, malformed, glowing, warped, or nonsensical text: badges, pump headers, prices, storefront signs, labels, screens, or plates. Tiny, naturally out-of-focus, motion-blurred, or distant background text does not need to be readable and may pass; it must not visibly resemble fake glyphs. Never forgive close-up badge errors.

LICENSE-PLATE HARD GATE: mark license_plate pass only for a small, unlit, non-blooming physical plate with a coherent one-line 5-8 character alphanumeric sequence. Mark fail for blank/washed-out plates, distorted characters, invented glyphs, texture-like writing, or conspicuously glowing plates. If it is naturally obscured, out of frame, or too distant to read, use not_visible.

SVJ IDENTITY HARD GATE: when an Aventador SVJ is requested, mark svj_identity pass only if its visible body matches the supplied references. A visible rear requires the fixed ALA wing, high central triple exhaust, angular diffuser, and thin Y-shaped taillights. Reject a generic Aventador, Revuelto, or any wrong exhaust/rear layout.

SNAPSHOT HARD GATE: reject glossy automotive-ad/studio composition, impossible reflections, or obviously generated lighting. User request: ${prompt}` }, { type: 'image_url', image_url: { url: candidateUrl } }];
  references.slice(0, 3).forEach(ref => content.push({ type: 'image_url', image_url: { url: ref.dataUrl } }));
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Unvail Quality Gate' },
      body: JSON.stringify({ model: 'google/gemini-3.7-flash', messages: [{ role: 'user', content }], temperature: 0, response_format: { type: 'json_object' } })
    });
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    const text = Array.isArray(raw) ? raw.map(part => part.text || '').join('') : raw;
    const result = JSON.parse(text || '{}');
    const needsSvj = namedObjects.some(object => object.model === 'Aventador SVJ');
    const identityPass = !needsSvj || result.svj_identity !== 'fail';
    const textPass = result.visible_text !== 'fail';
    const platePass = result.license_plate !== 'fail';
    const realismPass = result.snapshot_realism !== 'fail';
    const score = Number(result.score) || 0;
    const failures = Array.isArray(result.failures) ? result.failures : [];
    if (!identityPass) failures.push('SVJ identity did not pass');
    if (!textPass) failures.push('Visible text did not pass');
    if (!platePass) failures.push('License plate did not pass');
    if (!realismPass) failures.push('Snapshot realism did not pass');
    const rawBox = result.plate_box;
    const validBox = rawBox && [rawBox.x, rawBox.y, rawBox.width, rawBox.height].every(value => Number.isFinite(Number(value))) && Number(rawBox.width) > 0 && Number(rawBox.height) > 0;
    const plateBox = validBox ? { x: Math.max(0, Math.min(1000, Number(rawBox.x))), y: Math.max(0, Math.min(1000, Number(rawBox.y))), width: Math.max(1, Math.min(1000, Number(rawBox.width))), height: Math.max(1, Math.min(1000, Number(rawBox.height))) } : null;
    return { pass: identityPass && textPass && platePass && realismPass && score >= 72, score, failures, plateBox, costUsd: Number(data?.usage?.cost) || 0 };
  } catch (error) {
    // Never fail open: an ungraded output is lower priority than a graded one.
    return { pass: false, score: 0, failures: [`QA unavailable: ${error.message}`], costUsd: 0 };
  }
}

// ============================================================
// LARP GENERATION
// ============================================================
app.post('/api/larp/generate', requireAuth, async (req, res) => {
  const rid = crypto.randomUUID().slice(0, 8);
  const log = (msg) => console.log(`[${rid}] ${msg}`);
  let reserved = false;
  log('LARP GENERATION STARTED');

  try {
    const { prompt, realismPrompt, referenceImageUrl, model, aspectRatio, dryRun } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required', requestId: rid });
    if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured', requestId: rid });

    const selectedModel = model || 'google/gemini-3-pro-image-preview';
    log(`Model: ${selectedModel}`);

    // === STEP 1: Parse scene ===
    const p = prompt.toLowerCase();
    const scenePlan = {
      camera_operator: 'friend',
      camera_operator_visible: false,
      camera_view: 'first-person phone-camera POV',
      location: 'unknown',
      time: 'day',
      action: '',
      products: []
    };

    if (/\b(friend recording|friend record|someone filming|friend took|my friend)\b/i.test(p)) {
      scenePlan.camera_view = 'first-person phone-camera POV';
      scenePlan.camera_operator_visible = false;
    } else if (/\b(mirror|selfie)\b/i.test(p)) {
      scenePlan.camera_view = 'mirror reflection';
    } else if (/\b(I took|looking down|my phone)\b/i.test(p)) {
      scenePlan.camera_view = 'first-person holder POV';
    }

    if (/\b(gas station|pump|canopy)\b/i.test(p)) scenePlan.location = 'gas station';
    else if (/\b(bedroom)\b/i.test(p)) scenePlan.location = 'bedroom';
    else if (/\b(hotel|resort)\b/i.test(p)) scenePlan.location = 'hotel';
    else if (/\b(garage|parking)\b/i.test(p)) scenePlan.location = 'garage';
    else if (/\b(street|road|city|miami)\b/i.test(p)) scenePlan.location = 'urban street';

    if (/\b(night|dark|evening|midnight|dusk)\b/i.test(p)) scenePlan.time = 'night';
    if (/\b(rev|revving|engine)\b/i.test(p)) scenePlan.action = 'revving the engine';

    // === STEP 2: Detect named objects ===
    const namedObjects = detectNamedObjects(prompt);
    scenePlan.products = namedObjects.map(o => o.match);
    log(`Named objects: ${scenePlan.products.join(', ') || 'none'}`);

    // === STEP 3: Research and collect references ===
    const references = [];

    // User uploaded reference
    if (referenceImageUrl) {
      try {
        const ref = await downloadImage(referenceImageUrl);
        references.push({ role: 'USER_REFERENCE', ...ref, source: 'user upload' });
        log(`User ref: ${ref.size}b sha=${ref.sha256.slice(0, 12)}`);
      } catch (e) { log(`User ref failed: ${e.message}`); }
    }

    // Qwen can take multiple image references. Use complementary factory views so
    // a novel viewpoint does not turn the vehicle into a generic supercar.
    for (const obj of namedObjects) {
      if (references.length > 0) break;
      if (!BRAVE_KEY) { log(`Skipping ${obj.match}: no BRAVE key`); continue; }
      try {
        const matches = await findCanonicalReferences(obj, log);
        for (const match of matches) {
          references.push({ role: 'PRODUCT_REFERENCE', product: obj.match, brand: obj.brand, model: obj.model, sourceUrl: match.url, ...match });
        }
      } catch (e) { log(`Research error: ${e.message}`); }
    }

    log(`Total references: ${references.length}`);

    // === STEP 4: Build concise provider prompt ===
    const cameraDesc = scenePlan.camera_view === 'first-person phone-camera POV'
      ? 'Casual handheld photo from a friend standing several feet away, holding a regular iPhone at chest height. The friend is invisible behind the camera. Normal 1x iPhone main camera, approximately 24-28mm equivalent. Camera is about 5-8 feet from the subject.'
      : scenePlan.camera_view === 'mirror reflection'
      ? 'Mirror selfie showing the person holding the phone.'
      : 'Handheld phone camera perspective, normal distance.';

    const locationDesc = scenePlan.location === 'gas station' ? 'ordinary gas station with canopy, pumps, dry pavement, and normal concrete' :
      scenePlan.location === 'bedroom' ? 'ordinary bedroom with wooden floor' :
      scenePlan.location === 'hotel' ? 'hotel room interior' :
      scenePlan.location === 'garage' ? 'indoor parking garage' :
      scenePlan.location === 'urban street' ? 'urban street scene' : scenePlan.location;

    const timeDesc = scenePlan.time === 'night' ? 'nighttime: bright overhead canopy lights partially clipping to white, darker background streets, naturally mixed exposure, shadows under the vehicle remain dark' : 'natural daylight';

    let providerPrompt = (realismPrompt || prompt).trim();

    // Add product identity instruction
    if (namedObjects.length > 0) {
      const productNames = namedObjects.map(o => `the exact ${o.brand} ${o.model}`).join(', ');
      providerPrompt += ` Preserve the exact identity and distinctive structural features of ${productNames}.`;
    }

    if (references.length > 0) {
      providerPrompt += ' Use the attached image only as an identity reference for factory shape, panels, vents, lights, wheels, wing, and proportions. Ignore its setting, angle, crop, lighting, and photographic style.';
    }

    log(`Prompt: ${providerPrompt}`);

    if (dryRun) {
      const ref = references[0];
      return res.json({
        dryRun: true,
        model: selectedModel,
        scenePlan: { camera: scenePlan.camera_view, location: scenePlan.location, time: scenePlan.time, products: scenePlan.products },
        providerPrompt,
        referencesAttached: references.length,
        selectedReferences: references.map(ref => ({ product: ref.product, brand: ref.brand, model: ref.model, source: ref.source, title: ref.title, sourceUrl: ref.sourceUrl, downloadedFrom: ref.downloadedFrom, score: ref.score, width: ref.width, height: ref.height, size: ref.size, sha256: ref.sha256 }))
      });
    }

    const reservation = await billing.reserve(req.user.id, Number(process.env.IMAGE_RESERVATION_CREDITS || 500), rid, { route: '/api/larp/generate', model: selectedModel });
    if (!reservation.reserved) return res.status(402).json({ error: 'Insufficient credits', requestId: rid });
    reserved = true;

    // === STEP 5: Call OpenRouter ===
    const body = { model: selectedModel, prompt: providerPrompt, resolution: selectedModel === 'google/gemini-3-pro-image-preview' ? '2K' : '1K' };
    if (aspectRatio) body.aspect_ratio = aspectRatio;

    // Qwen Image 3 Pro accepts up to four references; keep product views together.
    if (references.length > 0) {
      body.input_references = references.slice(0, 4).map(ref => ({ type: 'image_url', image_url: { url: ref.dataUrl } }));
      log(`Attached ${body.input_references.length} reference image(s)`);
    }

    const generateCandidate = async () => {
      const providerRes = await fetch('https://openrouter.ai/api/v1/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Unvail Larp' },
        body: JSON.stringify(body)
      });
      const providerData = await providerRes.json();
      if (!providerRes.ok) throw new Error(providerData.error?.message || 'Provider error');
      const imageUrl = imageUrlFromProvider(providerData);
      if (!imageUrl) throw new Error('Provider returned no image');
      return { imageUrl, cost: Number(providerData.usage?.cost) || 0 };
    };

    // Generate two alternatives, then use vision QA only to rank them. Never discard a
    // paid generation solely because the reviewer is uncertain about a dark/tiny detail.
    const generated = await Promise.all([generateCandidate(), generateCandidate()]);
    const assessed = await Promise.all(generated.map(async candidate => ({ ...candidate, qa: await assessCandidate(candidate.imageUrl, references, prompt, namedObjects) })));
    assessed.sort((a, b) => (Number(b.qa.pass) - Number(a.qa.pass)) || b.qa.score - a.qa.score);
    const best = assessed[0];
    const imageUrl = best.imageUrl;
    const totalCost = assessed.reduce((sum, candidate) => sum + candidate.cost + (Number(candidate.qa?.costUsd) || 0), 0);
    log(`Quality review selected score=${best.qa.score} pass=${best.qa.pass}; alternate=${assessed[1]?.qa.score ?? '?'}; cost=$${totalCost || '?'}`);

    const debit = await billing.settle(req.user.id, rid, totalCost, { route: '/api/larp/generate', model: selectedModel });
    if (!debit.settled) return res.status(402).json({ error: 'Insufficient credits', requestId: rid });
    reserved = false;
    res.json({
      imageUrl, model: selectedModel, requestId: rid,
      groundingVersion: 'brave-krea-v2',
      scenePlan: { camera: scenePlan.camera_view, location: scenePlan.location, time: scenePlan.time, products: scenePlan.products },
      referencesAttached: references.length,
      researchResults: namedObjects.map(o => ({ product: o.match, brand: o.brand, model: o.model })),
      cost: totalCost || null,
      costUsd: totalCost || 0,
      creditsCharged: debit.amount,
      qualityMode: { candidates: 2, passed: best.qa.pass, score: best.qa.score, failures: best.qa.failures },
      plateBox: best.qa.plateBox || null
    });

  } catch (err) {
    if (reserved) { try { await billing.release(req.user.id, rid); } catch (releaseError) { log(`Reservation release failed: ${releaseError.message}`); } }
    log(`ERROR: ${err.message}`);
    res.status(500).json({ error: err.message, requestId: rid });
  }
});

const PORT = process.env.PORT || 3001;
billing.initializeSchema()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Unvail backend on port ${PORT}`)))
  .catch(error => {
    // Keep health diagnostics available, but protected routes fail closed until
    // the database is reachable and migrations can run.
    console.error(`Billing schema initialization failed: ${error.message}`);
    app.listen(PORT, '0.0.0.0', () => console.log(`Unvail backend on port ${PORT} (billing unavailable)`));
  });
