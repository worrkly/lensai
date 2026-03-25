// api/analyze.js — Vercel Serverless Function with persistent Redis stats
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

// ── Redis helpers (Upstash REST API — no extra packages needed) ───────────────
async function redisCmd(...args) {
  const r = await fetch(`${REDIS_URL}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const d = await r.json();
  return d.result;
}
async function redisGet(key) { return redisCmd("GET", key); }
async function redisSet(key, val) { return redisCmd("SET", key, val); }
async function redisIncr(key) { return redisCmd("INCR", key); }
async function redisIncrBy(key, n) { return redisCmd("INCRBY", key, String(Math.round(n * 10000))); }

// ── Prompt builders ───────────────────────────────────────────────────────────
const JSON_SCHEMA = `
Respond ONLY with a valid JSON object — no preamble, no markdown fences:
{
  "ai_probability": 0.0,
  "signals": [{ "name": "Signal Name", "score": 0.0, "detail": "one sentence observation" }],
  "analysis_html": "3-4 sentence analysis. Use <strong> tags for emphasis."
}
ai_probability: decimal 0.0-1.0 (higher = more AI). Be accurate and nuanced.`;

function promptText(text) {
  return `You are an expert AI text detection system. Analyze whether this text was written by a human or AI.
Evaluate these 5 signals:
1. Perplexity — how uniform/predictable word choices are
2. Burstiness — sentence length variation (humans vary more)
3. Pattern Repetition — overused phrases, hedging, list structures
4. Vocabulary Flatness — unnaturally perfect word choice, no colloquialisms
5. Structural Coherence — overly organized, formulaic paragraph structure
TEXT:\n"""\n${text.slice(0, 3500)}\n"""\n${JSON_SCHEMA}`;
}
function promptImage() {
  return `You are an expert AI image detection system. Analyze for AI generation signs (Midjourney, DALL-E, Stable Diffusion, Flux).
Evaluate: 1. Artifact Detection 2. Anatomical Accuracy 3. Texture Realism 4. Lighting Consistency
${JSON_SCHEMA}`;
}
function promptAudio(transcript, url) {
  return `You are an expert AI voice/audio detection system.
${transcript ? `TRANSCRIPT:\n"""${transcript.slice(0,2000)}"""` : ""}
${url ? `AUDIO URL: ${url}` : ""}
Evaluate: 1. Prosody Patterns 2. Vocal Naturalness 3. Vocabulary Flatness 4. Pattern Repetition
${JSON_SCHEMA}`;
}
function promptCode(code) {
  return `You are an expert AI code detection system.
Evaluate: 1. Naming Conventions 2. Comment Density 3. Style Consistency 4. Boilerplate Patterns
CODE:\n\`\`\`\n${code.slice(0,3000)}\n\`\`\`\n${JSON_SCHEMA}`;
}
function promptVideo(url, context) {
  return `You are an expert AI video detection system. Analyze URL for AI generation.
URL: ${url} ${context ? `USER OBSERVATIONS: "${context}"` : ""}
Evaluate: 1. Platform Trust 2. URL Structure 3. Known AI Services 4. Contextual Signals
${JSON_SCHEMA}`;
}

// ── Rate limiting (Redis-backed, persistent) ─────────────────────────────────
function getWeekKey() {
  const now = new Date();
  const s = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const d = Math.ceil((now - s) / 86400000);
  const w = Math.ceil((d + s.getUTCDay()) / 7);
  return `${now.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}

async function checkRateLimit(ip) {
  const limit = parseInt(await redisGet("wl:weekly_limit") || "2");
  const key = `wl:usage:${ip}:${getWeekKey()}`;
  const count = parseInt(await redisGet(key) || "0");
  if (count >= limit) return { allowed: false, used: count, limit };
  await redisCmd("INCR", key);
  await redisCmd("EXPIRE", key, "1209600");
  return { allowed: true, used: count + 1, limit };
}

const COST = { text: 0.00797, image: 0.01005, audio: 0.00585, code: 0.00843, video: 0.00435 };

async function recordScan(type) {
  const day = new Date().toISOString().slice(0, 10);
  await Promise.all([
    redisCmd("INCR", "wl:stats:total"),
    redisCmd("INCR", `wl:stats:type:${type}`),
    redisCmd("INCR", `wl:stats:day:${day}`),
    redisCmd("INCRBYFLOAT", "wl:stats:cost", String((COST[type] || COST.text).toFixed(5))),
    redisCmd("EXPIRE", `wl:stats:day:${day}`, "2592000")
  ]);
}

async function recordBlock() {
  await redisCmd("INCR", "wl:stats:blocked");
}

acync function recordIPUsage(ip) {
  const weekKey = getWeekKey();
  const key = `wl:ip:${ip}:${weekKey}`;
  const allTimeKey = `wl:ip:${ip}:total`;
  await Promise.all([
    redisCmd("INCR", key),
    redisCmd("EXPIRE", key, "1209600"),
    redisCmd("INCR", allTimeKey),
    redisCmd("SADD", "wl:ips:seen", ip)
  ]);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const rC = await checkRateLimit(ip);

  if (!rC.allowed) {
    await recordBlock();
    return res.status(429).json({ error: "weekly_limit_reached", message: "Weekly limit reached. Resets every Monday.", used: rC,uused, limit: rC.limit });
  }

  const { type, text, imageData, imageType, transcript, audioUrl, code, videoUrl, videoContext } = req.body || {};
  if (!type) return res.status(400).json({ error: "Missing type field." });

  try {
    let message;
    if (type === "image") {
      if (!imageData || !imageType) return res.status(400).json({ error: "Missing image data." });
      message = await client.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 1000,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: imageType, data: imageData } }, { type: "text", text: promptImage() }]}] });
    } else {
      let prompt;
      if (type === "text") { if (!text || text.length < 30) return res.status(400).json({ error: "Text too short." }); prompt = promptText(text); }
      else if (type === "audio") { if (!transcript && !audioUrl) return res.status(400).json({ error: "Provide transcript or URL." }); prompt = promptAudio(transcript, audioUrl); }
      else if (type === "code") { if (!code || code.length < 20) return res.status(400).json({ error: "Code too short." }); prompt = promptCode(code); }
      else if (type === "video") { if (!videoUrl) return res.status(400).json({ error: "Missing video URL." }); prompt = promptVideo(videoUrl, videoContext); }
      else return res.status(400).json({ error: "Unknown type." });
      message = await client.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] });
    }

    const raw = message.content.map(b => b.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
    const parsed = JSON.parse(clean.slice(s, e + 1));

    await Promise.all([recordScan(type), recordIPUsage(ip)]);
    parsed.scans_used = rC.used;
    parsed.scans_remaining = rC.limit - rC.used;
    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Analysis error:", err);
    return res.status(500).json({ error: err.message || "Analysis failed." });
  }
}
