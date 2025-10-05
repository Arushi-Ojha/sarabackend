console.log('--- SERVER.JS DEPLOYMENT TEST v2 ---');

const express = require('express');
const cors = require('cors');
const axios = require('axios');
// dotenv is optional — useful for local development, harmless in Lambda if .env not present
require('dotenv').config();
const serverlessExpress = require('@codegenie/serverless-express');

const IMAGGA_API_KEY = process.env.IMAGGA_API_KEY;
const IMAGGA_API_SECRET = process.env.IMAGGA_API_SECRET;
const OPEN_ROUTER_API = process.env.OPEN_ROUTER_API; // your openrouter key

const app = express();
app.use(cors());
app.use(express.json());

// --- Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// --- The SAR endpoint (adapted from your server.js) ---
app.post('/api/get-sar-image', async (req, res) => {
  const { latitude, longitude } = req.body;
  console.log(`[LOG] Received coordinates: Lat=${latitude}, Lon=${longitude}`);

  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'Latitude and Longitude are required.' });
  }

  if (!IMAGGA_API_KEY || !IMAGGA_API_SECRET) {
    console.error('[ERROR] Imagga API Key or Secret missing');
    return res.status(500).json({ error: 'Server configuration error: Imagga credentials missing.' });
  }
  if (!OPEN_ROUTER_API) {
    console.warn('[WARN] OPEN_ROUTER_API not set - AI call will fail unless provided as env var.');
  }

  const asfApiUrl = `https://api.daac.asf.alaska.edu/services/search/param?intersectsWith=POINT(${longitude}+${latitude})&dataset=SENTINEL-1&maxResults=250&output=geojson`;

  try {
    const asfResponse = await axios.get(asfApiUrl);
    const features = asfResponse.data.features;

    if (!features || features.length === 0) {
      return res.status(404).json({ error: 'No SAR data found for this location.' });
    }

    const sortedFeatures = features
      .filter(f => f.properties && f.properties.browse && f.properties.browse.length > 0)
      .sort((a, b) => new Date(b.properties.startTime) - new Date(a.properties.startTime));

    if (sortedFeatures.length === 0) {
      return res.status(404).json({ error: 'SAR data found, but no preview images are available.' });
    }

    const latestFeature = sortedFeatures[0];
    const properties = latestFeature.properties;
    const imageUrl = properties.browse[0];

    console.log(`[LOG] Found latest image URL: ${imageUrl}`);

    // 1) Get color palette from Imagga
    let imageColors = [];
    try {
      const imaggaColorsUrl = `https://api.imagga.com/v2/colors?image_url=${encodeURIComponent(imageUrl)}`;
      const colorResponse = await axios.get(imaggaColorsUrl, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${IMAGGA_API_KEY}:${IMAGGA_API_SECRET}`).toString('base64')
        },
        timeout: 20000
      });
      imageColors = (colorResponse.data && colorResponse.data.result && colorResponse.data.result.colors && colorResponse.data.result.colors.image_colors) || [];
      console.log('[LOG] Imagga colors received:', imageColors.slice(0,5));
    } catch (err) {
      console.error('[WARN] Imagga colors call failed:', err.response ? err.response.data : err.message);
      imageColors = [];
    }

    // 2) Get object tags (optional)
    let imageTags = [];
    try {
      const imaggaApiUrl = `https://api.imagga.com/v2/tags?image_url=${encodeURIComponent(imageUrl)}`;
      const imaggaResponse = await axios.get(imaggaApiUrl, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${IMAGGA_API_KEY}:${IMAGGA_API_SECRET}`).toString('base64')
        },
        timeout: 20000
      });
      imageTags = imaggaResponse.data && imaggaResponse.data.result && imaggaResponse.data.result.tags
        ? imaggaResponse.data.result.tags.filter(t => t.confidence > 15).slice(0,5).map(t => t.tag.en)
        : [];
      console.log('[LOG] Imagga tags:', imageTags);
    } catch (err) {
      console.error('[WARN] Imagga tags call failed:', err.response ? err.response.data : err.message);
      imageTags = [];
    }

    const metadataForAI = {
      sceneName: properties.sceneName,
      platform: properties.platform,
      captureDate: properties.startTime,
      flightDirection: properties.flightDirection,
      polarization: properties.polarization,
      beamMode: properties.beamModeType,
      orbit: properties.orbit,
      coordinates: { latitude, longitude }
    };

    // 3) Construct AI prompt using the color percentages & tags
    const colorText = imageColors.length
      ? imageColors.map(c => `${c.color_name || c.closest_palette_color || c.html_code || 'unknown'}: ${ (c.percent || 0).toFixed(1) }%`).join(', ')
      : 'No color data available';

    const prompt = `
You are a NASA SAR (Synthetic Aperture Radar) interpretation specialist 🛰️.
A vision API has returned detected colors and approximate percentages for a Sentinel-1 preview image.

Detected color percentages:
${colorText}

Also detected visual tags: ${imageTags.length ? imageTags.join(', ') : 'None'}.

SAR Color Interpretation Chart:
- Bright White / Light Gray => strong backscatter (urban structures, metal, ships)
- Medium Gray => rocky terrain or dry soil
- Black / Dark Blue => calm water or radar shadow
- Green => vegetation or forest
- Yellow / Orange => mixed terrain or transitional vegetation
- Red / Magenta => man-made structures or urban materials
- Cyan / Blue-Green => wetlands or moist areas

Using these color percentages and the tags, do the following:
1) For each detected color, give a short interpretation (one line) about what that color likely represents in SAR terms.
2) Provide a 4-6 sentence summary describing the most likely landscape in plain, simple language.
3) Mention the capture date/time, flightDirection, and coordinates (from metadata) explicitly.
4) Note any uncertainties or edge-cases (for example, if color mapping is ambiguous).
5) Use 0-2 relevant emojis, keep output concise.

Metadata:
${JSON.stringify(metadataForAI, null, 2)}
`.trim();

    // 4) Call OpenRouter / LLM for interpretation
    let explanation = '';
    try {
      const aiResponse = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          // you can tune temperature, max_tokens here if needed
        },
        {
          headers: {
            "Authorization": `Bearer ${OPEN_ROUTER_API}`,
            "Content-Type": "application/json"
          },
          timeout: 30000
        }
      );
      explanation = aiResponse.data && aiResponse.data.choices && aiResponse.data.choices[0] && (aiResponse.data.choices[0].message?.content || aiResponse.data.choices[0].text) || '';
      console.log('[LOG] AI explanation length:', explanation.length);
    } catch (err) {
      console.error('[ERROR] AI call failed:', err.response ? err.response.data : err.message);
      explanation = 'AI interpretation unavailable due to service error.';
    }

    // 5) Return everything the frontend might want
    return res.json({
      imageUrl,
      explanation,
      sceneName: properties.sceneName,
      imageTags,
      imageColors,
      metadata: metadataForAI
    });

  } catch (error) {
    console.error('[ERROR] processing SAR request:', error.response ? error.response.data : error.message);
    return res.status(500).json({ error: 'Failed to process SAR data.' });
  }
});
module.exports.handler = serverlessExpress({ app });