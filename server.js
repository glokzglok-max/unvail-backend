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
  res.json({ status: 'ok', timestamp: new Date().toISOString(), brave: !!BRAVE_KEY, openrouter: !!OPENROUTER_KEY, groundingVersion: 'brave-krea-v2', commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'local' });
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
  const content = [{ type: 'text', text: `You are a fail-closed photo quality gate. Candidate image is first; following images are factory identity references. Return JSON only in exactly this schema: {"score":0-100,"svj_identity":"pass|fail|not_applicable","visible_text":"pass|fail","license_plate":"pass|fail|not_visible","snapshot_realism":"pass|fail","failures":[string]}. Do not infer details that are not visibly clear. A candidate passes only if every applicable field is pass, its rear plate is not_visible or pass, and score is at least 80.

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
    const identityPass = !needsSvj || result.svj_identity === 'pass';
    const textPass = result.visible_text === 'pass';
    const platePass = result.license_plate === 'pass' || result.license_plate === 'not_visible';
    const realismPass = result.snapshot_realism === 'pass';
    const score = Number(result.score) || 0;
    const failures = Array.isArray(result.failures) ? result.failures : [];
    if (!identityPass) failures.push('SVJ identity did not pass');
    if (!textPass) failures.push('Visible text did not pass');
    if (!platePass) failures.push('License plate did not pass');
    if (!realismPass) failures.push('Snapshot realism did not pass');
    return { pass: identityPass && textPass && platePass && realismPass && score >= 80, score, failures };
  } catch (error) {
    // Never fail open: an ungraded output is lower priority than a graded one.
    return { pass: false, score: 0, failures: [`QA unavailable: ${error.message}`] };
  }
}

// ============================================================
// LARP GENERATION
// ============================================================
app.post('/api/larp/generate', async (req, res) => {
  const rid = crypto.randomUUID().slice(0, 8);
  const log = (msg) => console.log(`[${rid}] ${msg}`);
  log('LARP GENERATION STARTED');

  try {
    const { prompt, realismPrompt, referenceImageUrl, model, aspectRatio, dryRun } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required', requestId: rid });
    if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured', requestId: rid });

    const selectedModel = model || 'google/gemini-3-pro-image';
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

    // === STEP 5: Call OpenRouter ===
    const body = { model: selectedModel, prompt: providerPrompt, resolution: selectedModel === 'google/gemini-3-pro-image' ? '2K' : '1K' };
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

    // Quality mode deliberately uses exactly three independent candidates.
    const generated = await Promise.all([generateCandidate(), generateCandidate(), generateCandidate()]);
    const assessed = await Promise.all(generated.map(async candidate => ({ ...candidate, qa: await assessCandidate(candidate.imageUrl, references, prompt, namedObjects) })));
    assessed.sort((a, b) => (Number(b.qa.pass) - Number(a.qa.pass)) || b.qa.score - a.qa.score);
    const best = assessed[0];
    if (!best.qa.pass) {
      log(`Quality gate rejected all three candidates; best score=${best.qa.score}`);
      return res.status(422).json({ error: 'No candidate passed the realistic-image quality gate. Please retry.', requestId: rid, qualityMode: { candidates: 3, passed: false, score: best.qa.score, failures: best.qa.failures } });
    }
    const imageUrl = best.imageUrl;
    const totalCost = assessed.reduce((sum, candidate) => sum + candidate.cost, 0);
    log(`Quality gate selected score=${best.qa.score} pass=${best.qa.pass}; rejected=${assessed.filter(c => !c.qa.pass).length}; cost=$${totalCost || '?'}`);

    res.json({
      imageUrl, model: selectedModel, requestId: rid,
      groundingVersion: 'brave-krea-v2',
      scenePlan: { camera: scenePlan.camera_view, location: scenePlan.location, time: scenePlan.time, products: scenePlan.products },
      referencesAttached: references.length,
      researchResults: namedObjects.map(o => ({ product: o.match, brand: o.brand, model: o.model })),
      cost: totalCost || null,
      qualityMode: { candidates: 3, passed: best.qa.pass, score: best.qa.score, failures: best.qa.failures }
    });

  } catch (err) {
    log(`ERROR: ${err.message}`);
    res.status(500).json({ error: err.message, requestId: rid });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`Unvail backend on port ${PORT}`));
