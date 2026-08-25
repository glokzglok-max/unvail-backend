require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: true, credentials: true }));

const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), braveConfigured: !!BRAVE_KEY, openrouterConfigured: !!OPENROUTER_KEY });
});

// ============================================================
// PRODUCT SEARCH
// ============================================================
app.post('/api/products/resolve', async (req, res) => {
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
  const b64 = buf.toString('base64');
  const mime = r.headers.get('content-type') || 'image/jpeg';
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  return { dataUrl: `data:${mime};base64,${b64}`, mime, size: buf.length, sha256: sha };
}

// ============================================================
// LARP GENERATION
// ============================================================
app.post('/api/larp/generate', async (req, res) => {
  const rid = crypto.randomUUID().slice(0, 8);
  const log = (msg) => console.log(`[${rid}] ${msg}`);
  log('LARP GENERATION STARTED');

  try {
    const { prompt, referenceImageUrl, model, aspectRatio } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required', requestId: rid });
    if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured', requestId: rid });

    const selectedModel = model || 'krea/krea-2-large';
    log(`Model: ${selectedModel}`);
    log(`Prompt: ${prompt}`);

    // === STEP 1: Parse scene plan ===
    const p = prompt.toLowerCase();
    const scenePlan = {
      camera_operator: 'friend',
      camera_operator_visible: false,
      camera_device: 'ordinary recent iPhone main camera',
      camera_view: 'first-person phone-camera POV',
      subject: prompt,
      action: '',
      location: 'unknown',
      time: 'day',
      products: []
    };

    // Camera role interpretation
    if (/\b(friend recording|friend record|someone filming|friend took|my friend)\b/i.test(p)) {
      scenePlan.camera_operator = 'friend';
      scenePlan.camera_operator_visible = false;
      scenePlan.camera_view = 'first-person phone-camera POV';
    } else if (/\b(mirror|selfie)\b/i.test(p)) {
      scenePlan.camera_view = 'mirror reflection';
      scenePlan.camera_operator_visible = true;
    } else if (/\b(security|cctv|surveillance)\b/i.test(p)) {
      scenePlan.camera_view = 'fixed security camera';
    } else if (/\b(I took|looking down|my phone)\b/i.test(p)) {
      scenePlan.camera_view = 'first-person holder POV';
    }

    // Location
    if (/\b(gas station|pump|canopy)\b/i.test(p)) scenePlan.location = 'gas station';
    else if (/\b(bedroom|bed room)\b/i.test(p)) scenePlan.location = 'bedroom';
    else if (/\b(hotel|resort)\b/i.test(p)) scenePlan.location = 'hotel';
    else if (/\b(garage|parking)\b/i.test(p)) scenePlan.location = 'garage';
    else if (/\b(street|road|city|miami)\b/i.test(p)) scenePlan.location = 'urban street';

    // Time
    if (/\b(night|dark|evening|midnight|dusk)\b/i.test(p)) scenePlan.time = 'night';

    // Action
    if (/\b(rev|revving|engine)\b/i.test(p)) scenePlan.action = 'revving the engine';

    // === STEP 2: Detect and research products ===
    const productPatterns = [
      { regex: /\b(balenciaga furry slides?|balenciaga fuzzy slides?|furry slides?)\b/i, query: 'Balenciaga Furry Slide Black product photo' },
      { regex: /\b(chrome hearts hoodie)\b/i, query: 'Chrome Hearts hoodie black product photo' },
      { regex: /\b(hellstar.*tee|hellstar.*shirt|hellstar.*path)\b/i, query: 'Hellstar Path to Paradise tee black red product photo' },
      { regex: /\b(lamborghini.*svj|svj|aventador svj)\b/i, query: 'Lamborghini Aventador SVJ product photo' },
      { regex: /\b(lamborghini revuelto)\b/i, query: 'Lamborghini Revuelto product photo' },
      { regex: /\b(louis vuitton.*sneaker|lv.*sneaker)\b/i, query: 'Louis Vuitton sneaker product photo' },
      { regex: /\b(rolex daytona)\b/i, query: 'Rolex Daytona product photo' }
    ];

    const detectedProducts = [];
    for (const pat of productPatterns) {
      const match = prompt.match(pat.regex);
      if (match) detectedProducts.push({ match: match[0], query: pat.query });
    }
    scenePlan.products = detectedProducts.map(p => p.match);
    log(`Products detected: ${scenePlan.products.join(', ') || 'none'}`);

    // === STEP 3: Download references ===
    const references = [];

    // User uploaded reference
    if (referenceImageUrl) {
      try {
        const ref = await downloadImage(referenceImageUrl);
        references.push({ role: 'USER_REFERENCE', ...ref, source: 'user upload' });
        log(`User ref: ${ref.size}b sha=${ref.sha256.slice(0, 12)}`);
      } catch (e) { log(`User ref failed: ${e.message}`); }
    }

    // Research products
    for (const product of detectedProducts) {
      if (!BRAVE_KEY) { log(`Skipping research for ${product.match}: no BRAVE key`); continue; }
      log(`Researching: ${product.query}`);
      try {
        const searchRes = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(product.query)}&count=5`, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
        });
        if (!searchRes.ok) { log(`Brave failed: ${searchRes.status}`); continue; }
        const data = await searchRes.json();
        const images = (data.results || []).slice(0, 3);
        log(`Found ${images.length} images for ${product.match}`);

        if (images.length > 0) {
          const best = images[0];
          const imgUrl = best.properties?.url || best.thumbnail?.src || best.url;
          log(`Selected: ${best.source} - ${best.title}`);
          try {
            const ref = await downloadImage(imgUrl);
            references.push({ role: 'PRODUCT_REFERENCE', product: product.match, source: best.source, title: best.title, sourceUrl: imgUrl, ...ref });
            log(`Downloaded: ${ref.size}b sha=${ref.sha256.slice(0, 12)}`);
          } catch (e) { log(`Download failed: ${e.message}`); }
        }
      } catch (e) { log(`Research error: ${e.message}`); }
    }

    log(`Total references: ${references.length}`);

    // === STEP 4: Build concise provider prompt ===
    const cameraDesc = scenePlan.camera_view === 'first-person phone-camera POV'
      ? 'First-person view from the friend\'s iPhone camera looking at the subject. The friend is behind the camera and not visible.'
      : scenePlan.camera_view === 'mirror reflection'
      ? 'Mirror reflection showing the person holding the phone.'
      : 'Handheld phone camera perspective.';

    const locationDesc = scenePlan.location === 'gas station' ? 'ordinary gas station with canopy, pumps, and pavement' :
      scenePlan.location === 'bedroom' ? 'ordinary bedroom with wooden floor' :
      scenePlan.location === 'hotel' ? 'hotel room interior' :
      scenePlan.location === 'garage' ? 'indoor parking garage' :
      scenePlan.location === 'urban street' ? 'urban street scene' : scenePlan.location;

    const timeDesc = scenePlan.time === 'night' ? 'nighttime lighting with bright canopy lights and naturally dark surrounding areas' : 'natural daylight';

    let providerPrompt = cameraDesc;
    providerPrompt += `. ${scenePlan.subject}.`;
    providerPrompt += ` Location: ${locationDesc}.`;
    providerPrompt += ` Lighting: ${timeDesc}.`;
    if (scenePlan.action) providerPrompt += ` Action: ${scenePlan.action}.`;
    providerPrompt += ' Clean handheld iPhone camera-roll framing, natural smartphone exposure, realistic depth, casual composition.';
    providerPrompt += ' No cinematic grading, no teal-and-orange, no wet pavement, no professional lighting, no studio setup.';
    providerPrompt += ' The image should look like a real photo taken by a person with their phone.';

    if (references.length > 0) {
      providerPrompt += ' Use the attached product reference images to preserve exact brand identity, materials, and design.';
    }

    log(`Prompt: ${providerPrompt}`);

    // === STEP 5: Call OpenRouter ===
    const body = { model: selectedModel, prompt: providerPrompt, n: 1 };
    if (aspectRatio) body.aspect_ratio = aspectRatio;

    // Attach first reference
    if (references.length > 0) {
      body.reference_image = references[0].dataUrl;
      log(`Attached ref: ${references[0].role} ${references[0].size}b sha=${references[0].sha256.slice(0, 12)}`);
    }

    const providerRes = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Unvail Larp' },
      body: JSON.stringify(body)
    });

    const providerData = await providerRes.json();
    if (!providerRes.ok) {
      log(`Provider error: ${JSON.stringify(providerData.error || providerData).slice(0, 200)}`);
      return res.status(providerRes.status).json({ error: providerData.error?.message || 'Provider error', requestId: rid });
    }

    let imageUrl = null;
    if (providerData.data?.[0]) {
      imageUrl = providerData.data[0].b64_json ? `data:${providerData.data[0].media_type || 'image/png'};base64,${providerData.data[0].b64_json}` : providerData.data[0].url;
    }

    log(`Done. Cost: $${providerData.usage?.cost || '?'}`);

    res.json({
      imageUrl, model: selectedModel, requestId: rid,
      scenePlan: { camera: scenePlan.camera_view, location: scenePlan.location, time: scenePlan.time, products: scenePlan.products },
      referencesAttached: references.length,
      researchResults: detectedProducts.map(p => ({ product: p.match, query: p.query })),
      cost: providerData.usage?.cost || null
    });

  } catch (err) {
    log(`ERROR: ${err.message}`);
    res.status(500).json({ error: err.message, requestId: rid });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`Unvail backend on port ${PORT}`));
