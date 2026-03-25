// api/analyze.js — Vercel Serverless Function
// The ANTHROPIC_API_KEY env var lives here on the server, never sent to the browser.

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Prompt builders ───────────────────────────────────────────────────────────

const JSON_SCHEMA = `
Respond ONLY with a valid JSON object — no preamble, no markdown fences:
{
  "ai_probability": 0.0,
  "signals": [
    { "name": "Signal Name", "score": 0.0, "detail": "one sentence observation" }
  ],
  "analysis_html": "3-4 sentence analysis as plain text. Use <strong> tags for emphasis."
}
ai_probability: decimal 0.0-1.0 (higher = more AI). Be accurate and nuanced.`;

function promptText(text) {
  return `You are an expert AI text detection system. Analyze whether this text was written by a human or AI (GPT-4, Claude, Gemini, etc.).
Evaluate these 5 signals:
1. Perplexity — how uniform/predictable word choices are
2. Burstiness — sentence length variation (humans vary more)
3. Pattern Repetition — overused phrases, hedging, list structures
4. Vocabulary Flatness — unnaturally perfect word choice, no colloquialisms
5. Structural Coherence — overly organized, formulaic paragraph structure
TEXT:\n"""\n${text.slice(0, 3500)}\n"""\n${JSON_SCHEMA}`;
}

function promptImage() {
  return `You are an expert AI image detection system. Analyze this image for signs of AI generation (Midjourney, DALL-E, Stable Diffusion, Flux, Firefly, etc.).
Evaluate these 4 signals:
1. Artifact Detection — warped anatomy, blurry edges, inconsistent details
2. Anatomical Accuracy — distorted hands, asymmetric faces, floating limbs
3. Texture Realism — hyper-smooth or unnaturally consistent textures
4. Lighting Consistency — physically incoherent light sources, shadows, reflections
${JSON_SCHEMA}`;
}

function promptAudio(transcript, url) {
  return `You are an expert AI voice/audio detection system. Analyze for signs of AI voice synthesis (ElevenLabs, Murf, HeyGen, Resemble, etc.).
${transcript ? `TRANSCRIPT / DESCRIPTION:\n"""\n${transcript.slice(0, 2000)}\n"""` : ""}
${url ? `AUDIO URL: ${url}` : ""}
Evaluate these 4 signals:
1. Prosody Patterns — rhythm/stress/pacing (flat or mechanical = AI signal)
2. Vocal Naturalness — absence of breath, perfect enunciation, no background noise
3. Vocabulary Flatness — overly formal language typical of TTS systems
4. Pattern Repetition — repetitive phrasing or scripted structure
${JSON_SCHEMA}`;
}

function promptCode(code) {
  return `You are an expert AI code detection system. Analyze whether this code was written by a human or AI (GitHub Copilot, ChatGPT, Claude, etc.).
Evaluate these 4 signals:
1. Naming Conventions — generic names like processData vs contextual identifiers
2. Comment Density — over-commented with obvious explanations vs sparse practical comments
3. Style Consistency — unnaturally uniform style vs personal coding quirks
4. Boilerplate Patterns — cookie-cutter try/catch, docstrings on everything, formulaic structure
CODE:\n\`\`\`\n${code.slice(0, 3000)}\n\`\`\`\n${JSON_SCHEMA}`;
}

function promptVideo(url, context) {
  return `You are an expert AI video detection system. Analyze this video URL for signs of AI generation.
You cannot view the actual video — analyze URL structure, platform, and domain signals only.
URL: ${url}
${context ? `\nUSER OBSERVATIONS:\n"${context}"` : ""}
Evaluate these 4 signals:
1. Platform Trust — is this platform known for AI-generated video?
2. URL Structure — do path/params suggest an AI generation service?
3. Known AI Services — match against Sora, Runway, Kling, Pika, HeyGen, Synthesia, D-ID, Luma AI
4. Contextual Signals — what do user observations (if any) suggest?
${JSON_SCHEMA}`;
}

// ── Rate limiting: 2 scans per week per IP ───────────────────────────────────
const DEFAULT_WEEKLY_LIMIT = 2;
const usageMap = new Map();

function getWeekKey() {
  const now = new Date();
  const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.ceil((now - startOfYear) / 86400000);
  const weekNum = Math.ceil((dayOfYear + startOfYear.getUTCDay()) / 7);
  return `${now.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function getWeeklyLimit() {
  return global._wlWeeklyLimit || DEFAULT_WEEKLY_LIMIT;
}

function checkRateLimit(ip) {
  const key = `${ip}::${getWeekKey()}`;
  const count = usageMap.get(key) || 0;
  const limit = getWeeklyLimit();
  if (count >= limit) {
    return { allowed: false, used: count, limit };
  }
  usageMap.set(key, count + 1);
  // Also record in global stats store for admin
  if (!global._wlStats) initGlobalStats();
  const weekKey = getWeekKey();
  if (!global._wlStats.usageMap[ip]) global._wlStats.usageMap[ip] = {};
  global._wlStats.usageMap[ip][weekKey] = (global._wlStats.usageMap[ip][weekKey] || 0) + 1;
  return { allowed: true, used: count + 1, limit };
}

// ── Global stats (shared with admin.js via global scope) ─────────────────────
function initGlobalStats() {
  global._wlStats = {
    totalScans: 0,
    scansByType: { text: 0, image: 0, audio: 0, code: 0, video: 0 },
    scansByDay: {},
    estimatedCostUSD: 0,
    usageMap: {},
    blockedRequests: 0,
    startedAt: new Date().toISOString(),
  };
}

const COST_PER_TOKEN = { input: 0.000003, output: 0.000015 };
const TOKEN_ESTIMATES = {
  text:  { input: 900,  output: 350 },
  image: { input: 1600, output: 350 },
  audio: { input: 700,  output: 350 },
  code:  { input: 950,  output: 350 },
  video: { input: 600,  output: 350 },
};

function recordScan(type) {
  if (!global._wlStats) initGlobalStats();
  const s = global._wlStats;
  s.totalScans++;
  if (s.scansByType[type] !== undefined) s.scansByType[type]++;
  const day = new Date().toISOString().slice(0, 10);
  s.scansByDay[day] = (s.scansByDay[day] || 0) + 1;
  const est = TOKEN_ESTIMATES[type] || TOKEN_ESTIMATES.text;
  s.estimatedCostUSD += (est.input * COST_PER_TOKEN.input) + (est.output * COST_PER_TOKEN.output);
}

function recordBlock() {
  if (!global._wlStats) initGlobalStats();
  global._wlStats.blockedRequests++;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    recordBlock();
    return res.status(429).json({
      error: "weekly_limit_reached",
      message: "You have used your free scans for this week. Your limit resets every Monday.",
      used: rateCheck.used,
      limit: rateCheck.limit,
    });
  }

  const { type, text, imageData, imageType, transcript, audioUrl, code, videoUrl, videoContext } =
    req.body || {};

  if (!type) return res.status(400).json({ error: "Missing type field." });

  try {
    let message;

    if (type === "image") {
      if (!imageData || !imageType)
        return res.status(400).json({ error: "Missing image data." });
      message = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: imageType, data: imageData } },
            { type: "text", text: promptImage() },
          ],
        }],
      });
    } else {
      let prompt;
      if (type === "text") {
        if (!text || text.length < 30)
          return res.status(400).json({ error: "Text too short (min 30 chars)." });
        prompt = promptText(text);
      } else if (type === "audio") {
        if (!transcript && !audioUrl)
          return res.status(400).json({ error: "Provide a transcript or URL." });
        prompt = promptAudio(transcript, audioUrl);
      } else if (type === "code") {
        if (!code || code.length < 20)
          return res.status(400).json({ error: "Code too short." });
        prompt = promptCode(code);
      } else if (type === "video") {
        if (!videoUrl)
          return res.status(400).json({ error: "Missing video URL." });
        prompt = promptVideo(videoUrl, videoContext);
      } else {
        return res.status(400).json({ error: "Unknown detection type." });
      }
      message = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });
    }

    const raw = message.content.map((b) => b.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("{");
    const e = clean.lastIndexOf("}");
    const parsed = JSON.parse(clean.slice(s, e + 1));

    recordScan(type);
    parsed.scans_used = rateCheck.used;
    parsed.scans_remaining = rateCheck.limit - rateCheck.used;

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Analysis error:", err);
    return res.status(500).json({ error: err.message || "Analysis failed." });
  }
}
