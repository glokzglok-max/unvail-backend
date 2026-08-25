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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), brave: !!BRAVE_KEY, openrouter: !!OPENROUTER_KEY });
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

async function searchBrave(query, count = 5) {
  if (!BRAVE_KEY) return { images: [], error: 'No BRAVE key' };
  const res = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
  });
  if (!res.ok) return { images: [], error: `Brave ${res.status}` };
  const data = await res.json();
  return { images: (data.results || []).map(img => ({
    url: img.properties?.url || img.thumbnail?.src || img.url,
    title: img.title || '', source: img.source || ''
  }))};
}

// ============================================================
// NAMED OBJECT DETECTION
// ============================================================
const NAMED_OBJECTS = [
  { pattern: /\b(lamborghini aventador svj|aventador svj|lamborghini svj|svj)\b/i, brand: 'Lamborghini', model: 'Aventador SVJ', category: 'vehicle', searchQueries: ['Lamborghini Aventador SVJ exterior front', 'Lamborghini Aventador SVJ interior dashboard', 'Lamborghini Aventador SVJ side profile'] },
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

    // Research each named object
    for (const obj of namedObjects) {
      if (!BRAVE_KEY) { log(`Skipping ${obj.match}: no BRAVE key`); continue; }
      for (const query of obj.searchQueries) {
        log(`Researching: ${query}`);
        try {
          const searchResult = await searchBrave(query, 3);
          if (searchResult.images.length > 0) {
            const best = searchResult.images[0];
            log(`Selected: ${best.source} - ${best.title}`);
            try {
              const ref = await downloadImage(best.url);
              references.push({
                role: 'PRODUCT_REFERENCE',
                product: obj.match,
                brand: obj.brand,
                model: obj.model,
                source: best.source,
                title: best.title,
                sourceUrl: best.url,
                ...ref
              });
              log(`Downloaded: ${ref.size}b sha=${ref.sha256.slice(0, 12)}`);
            } catch (e) { log(`Download failed: ${e.message}`); }
          }
        } catch (e) { log(`Research error: ${e.message}`); }
      }
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

    let providerPrompt = cameraDesc;
    providerPrompt += `. ${scenePlan.subject}.`;
    providerPrompt += ` Location: ${locationDesc}.`;
    providerPrompt += ` Lighting: ${timeDesc}.`;
    if (scenePlan.action) providerPrompt += ` Action: ${scenePlan.action}.`;
    providerPrompt += ' Clean casual iPhone camera-roll photo. Natural smartphone exposure. Dry pavement unless rain was requested.';
    providerPrompt += ' No cinematic grading, no teal-and-orange, no wet reflective pavement, no professional lighting, no studio setup, no uniform grain overlay.';
    providerPrompt += ' The image should look like a real casual photo taken by a person with their phone, not a 3D render or advertisement.';
    providerPrompt += ' Noise should be exposure-dependent: bright areas relatively clean, dark areas with subtle luminance texture. Not uniform across the frame.';

    // Add product identity instruction
    if (namedObjects.length > 0) {
      const productNames = namedObjects.map(o => `the exact ${o.brand} ${o.model}`).join(', ');
      providerPrompt += ` Preserve the exact identity and distinctive structural features of ${productNames}. Use the attached reference images to match the real product precisely.`;
    }

    if (references.length > 0) {
      providerPrompt += ' Use the attached product reference images to preserve exact brand identity, materials, and design.';
    }

    log(`Prompt: ${providerPrompt}`);

    // === STEP 5: Call OpenRouter ===
    const body = { model: selectedModel, prompt: providerPrompt, n: 1 };
    if (aspectRatio) body.aspect_ratio = aspectRatio;

    // Attach references (Krea supports one reference)
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
      researchResults: namedObjects.map(o => ({ product: o.match, brand: o.brand, model: o.model })),
      cost: providerData.usage?.cost || null
    });

  } catch (err) {
    log(`ERROR: ${err.message}`);
    res.status(500).json({ error: err.message, requestId: rid });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`Unvail backend on port ${PORT}`));
