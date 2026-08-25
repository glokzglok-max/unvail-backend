require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS - allow all origins for now
app.use(cors({ origin: true, credentials: true }));

// Health check
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
      const query = product.query || product.name || product;
      const searchQuery = typeof query === 'string' ? query : query.toString();

      // Search Brave for product images
      const searchUrl = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(searchQuery + ' product photo')}&count=5`;
      const searchRes = await fetch(searchUrl, {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_KEY }
      });

      if (!searchRes.ok) {
        results.push({ query: searchQuery, images: [], error: `Brave search failed: ${searchRes.status}` });
        continue;
      }

      const searchData = await searchRes.json();
      const images = (searchData.results || []).slice(0, 3).map(img => ({
        url: img.properties?.url || img.thumbnail?.src || img.url,
        title: img.title || '',
        source: img.source || '',
        thumbnail: img.thumbnail?.src || ''
      }));

      results.push({ query: searchQuery, images, error: null });
    }

    res.json({ results });
  } catch (err) {
    console.error('Product search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// IMAGE GENERATION - OpenRouter
// ============================================================
app.post('/api/larp/generate', async (req, res) => {
  try {
    const { prompt, negativePrompt, referenceImageUrl, model, aspectRatio } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_KEY) {
      return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });
    }

    const selectedModel = model || 'krea/krea-2-large';

    // Build the request body
    const body = {
      model: selectedModel,
      prompt: prompt,
      n: 1
    };

    if (aspectRatio) body.aspect_ratio = aspectRatio;

    // If reference image provided, download and attach as base64
    if (referenceImageUrl) {
      try {
        const imgRes = await fetch(referenceImageUrl);
        if (imgRes.ok) {
          const buffer = await imgRes.buffer();
          const base64 = buffer.toString('base64');
          const mediaType = imgRes.headers.get('content-type') || 'image/jpeg';
          body.reference_image = `data:${mediaType};base64,${base64}`;
        }
      } catch (imgErr) {
        console.warn('Failed to download reference image:', imgErr.message);
      }
    }

    // Call OpenRouter
    const providerRes = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': FRONTEND_ORIGIN_RAW || 'http://localhost:3000',
        'X-Title': 'Unvail'
      },
      body: JSON.stringify(body)
    });

    const providerData = await providerRes.json();

    if (!providerRes.ok) {
      return res.status(providerRes.status).json({ error: providerData.error?.message || 'Provider error', details: providerData });
    }

    // Extract image URL from response
    let imageUrl = null;
    if (providerData.data && providerData.data[0]) {
      if (providerData.data[0].b64_json) {
        imageUrl = `data:${providerData.data[0].media_type || 'image/png'};base64,${providerData.data[0].b64_json}`;
      } else if (providerData.data[0].url) {
        imageUrl = providerData.data[0].url;
      }
    }

    res.json({ imageUrl, model: selectedModel, providerResponse: providerData });
  } catch (err) {
    console.error('Generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Unvail backend running on port ${PORT}`);
});
