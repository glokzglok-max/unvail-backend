require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS - allow all origins for development
app.use(cors({ origin: true, credentials: true }));

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// PRODUCT SEARCH - Brave Image Search
// ============================================================
app.post('/api/products/resolve', async (req, res) => {
  try {
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'products array required' });
    }

    const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;
    if (!BRAVE_KEY) {
      return res.status(500).json({ error: 'BRAVE_SEARCH_API_KEY not configured' });
    }

    const results = [];
    for (const product of products) {
      const query = typeof product === 'string' ? product : (product.query || product.name || '');
      const searchUrl = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query + ' product photo')}&count=5`;
      const searchRes = await fetch(searchUrl, {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_KEY }
      });

      if (!searchRes.ok) {
        results.push({ query, images: [], error: `Brave search failed: ${searchRes.status}` });
        continue;
      }

      const searchData = await searchRes.json();
      const images = (searchData.results || []).slice(0, 3).map(img => ({
        url: img.properties?.url || img.thumbnail?.src || img.url,
        title: img.title || '',
        source: img.source || '',
        thumbnail: img.thumbnail?.src || ''
      }));

      results.push({ query, images, error: null });
    }

    res.json({ results });
  } catch (err) {
    console.error('Product search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPER: Download image and convert to base64 data URL
// ============================================================
async function downloadImageAsDataUrl(url) {
  const imgRes = await fetch(url, { timeout: 15000 });
  if (!imgRes.ok) throw new Error(`Failed to download: ${imgRes.status}`);
  const buffer = await imgRes.buffer();
  const base64 = buffer.toString('base64');
  const mediaType = imgRes.headers.get('content-type') || 'image/jpeg';
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { dataUrl: `data:${mediaType};base64,${base64}`, mediaType, size: buffer.length, sha256 };
}

// ============================================================
// HELPER: Research a product via Brave Search
// ============================================================
async function researchProduct(query) {
  const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;
  if (!BRAVE_KEY) return { query, error: 'BRAVE_SEARCH_API_KEY not configured' };

  const searchUrl = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query + ' product photo high quality')}&count=5`;
  const searchRes = await fetch(searchUrl, {
    headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_KEY }
  });

  if (!searchRes.ok) return { query, error: `Brave search failed: ${searchRes.status}` };

  const searchData = await searchRes.json();
  const images = (searchData.results || []).slice(0, 3).map(img => ({
    url: img.properties?.url || img.thumbnail?.src || img.url,
    title: img.title || '',
    source: img.source || ''
  }));

  return { query, images, error: null };
}

// ============================================================
// LARP GENERATION - Full pipeline with product research
// ============================================================
app.post('/api/larp/generate', async (req, res) => {
  const requestId = crypto.randomUUID();
  console.log(`[${requestId}] LARP GENERATION STARTED`);

  try {
    const { prompt, referenceImageUrl, model, aspectRatio } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_KEY) {
      return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });
    }

    const selectedModel = model || 'krea/krea-2-large';
    console.log(`[${requestId}] Model: ${selectedModel}`);
    console.log(`[${requestId}] Prompt: ${prompt}`);

    // Step 1: Detect named products in prompt
    const productPatterns = [
      { regex: /\b(balenciaga furry slides?|balenciaga fuzzy slides?|furry slides?)\b/i, query: 'Balenciaga Furry Slide Black product photo' },
      { regex: /\b(chrome hearts hoodie|chrome hearts sweater)\b/i, query: 'Chrome Hearts hoodie black product photo' },
      { regex: /\b(hellstar.*tee|hellstar.*shirt|hellstar.*path to paradise)\b/i, query: 'Hellstar Path to Paradise tee black red product photo' },
      { regex: /\b(louis vuitton.*sneaker|lv.*sneaker)\b/i, query: 'Louis Vuitton sneaker product photo' },
      { regex: /\b(lamborghini revuelto)\b/i, query: 'Lamborghini Revuelto product photo' }
    ];

    const detectedProducts = [];
    for (const pat of productPatterns) {
      if (pat.regex.test(prompt)) {
        detectedProducts.push({ match: prompt.match(pat.regex)[0], query: pat.query });
      }
    }
    console.log(`[${requestId}] Detected products:`, detectedProducts.map(p => p.match));

    // Step 2: Research products and download references
    const references = [];

    // Add user-uploaded reference first
    if (referenceImageUrl) {
      try {
        const ref = await downloadImageAsDataUrl(referenceImageUrl);
        references.push({ role: 'USER_REFERENCE', ...ref, source: 'user upload' });
        console.log(`[${requestId}] User reference downloaded: ${ref.size} bytes, ${ref.sha256}`);
      } catch (e) {
        console.warn(`[${requestId}] Failed to download user reference:`, e.message);
      }
    }

    // Research each detected product
    for (const product of detectedProducts) {
      console.log(`[${requestId}] Researching: ${product.query}`);
      const searchResult = await researchProduct(product.query);

      if (searchResult.error) {
        console.warn(`[${requestId}] Research failed for ${product.match}: ${searchResult.error}`);
        continue;
      }

      console.log(`[${requestId}] Found ${searchResult.images.length} images for ${product.match}`);

      // Download the best image
      if (searchResult.images.length > 0) {
        const bestImage = searchResult.images[0];
        console.log(`[${requestId}] Selected: ${bestImage.source} - ${bestImage.title}`);
        try {
          const ref = await downloadImageAsDataUrl(bestImage.url);
          references.push({
            role: 'PRODUCT_REFERENCE',
            product: product.match,
            source: bestImage.source,
            title: bestImage.title,
            sourceUrl: bestImage.url,
            ...ref
          });
          console.log(`[${requestId}] Downloaded: ${ref.size} bytes, SHA256: ${ref.sha256}`);
        } catch (e) {
          console.warn(`[${requestId}] Failed to download ${product.match} reference:`, e.message);
        }
      }
    }

    console.log(`[${requestId}] Total references: ${references.length}`);

    // Step 3: Build provider request
    const body = {
      model: selectedModel,
      prompt: prompt,
      n: 1
    };
    if (aspectRatio) body.aspect_ratio = aspectRatio;

    // Attach the first reference image (Krea supports one reference)
    if (references.length > 0) {
      body.reference_image = references[0].dataUrl;
      console.log(`[${requestId}] Attached reference: ${references[0].role} (${references[0].size} bytes)`);
    }

    console.log(`[${requestId}] Sending to OpenRouter: model=${selectedModel}, hasRef=${references.length > 0}`);

    // Step 4: Call OpenRouter
    const providerRes = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Unvail'
      },
      body: JSON.stringify(body)
    });

    const providerData = await providerRes.json();

    if (!providerRes.ok) {
      console.error(`[${requestId}] Provider error:`, providerData);
      return res.status(providerRes.status).json({ error: providerData.error?.message || 'Provider error' });
    }

    // Extract image URL
    let imageUrl = null;
    if (providerData.data && providerData.data[0]) {
      if (providerData.data[0].b64_json) {
        imageUrl = `data:${providerData.data[0].media_type || 'image/png'};base64,${providerData.data[0].b64_json}`;
      } else if (providerData.data[0].url) {
        imageUrl = providerData.data[0].url;
      }
    }

    console.log(`[${requestId}] Generation complete. Cost: $${providerData.usage?.cost || 'unknown'}`);

    res.json({
      imageUrl,
      model: selectedModel,
      requestId,
      referencesAttached: references.length,
      researchResults: detectedProducts.map(p => ({ product: p.match, query: p.query })),
      cost: providerData.usage?.cost || null
    });

  } catch (err) {
    console.error(`[${requestId}] Generation error:`, err);
    res.status(500).json({ error: err.message, requestId });
  }
});

// Start server - v2 with product research
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Unvail backend running on port ${PORT}`);
});
