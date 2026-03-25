// api/admin.js — Admin API endpoint
// Protected by ADMIN_PASSWORD + ADMIN_SECRET_KEY env vars

// ── Shared state (imported from analyze module context) ───────────────────────
// Since Vercel serverless functions don't share memory, we use a simple
// in-memory store here. For production, upgrade to Vercel KV.
// The admin endpoint reads from a global store that analyze.js also writes to.

// We re-declare the store here — in a real persistent setup, both files
// would import from a shared KV store. For now, the admin API tracks its
// own aggregated metrics that are written to by analyze.js via a shared module.

const COST_PER_TOKEN = {
  input: 0.000003,   // $3 per 1M input tokens (claude-sonnet)
  output: 0.000015,  // $15 per 1M output tokens
};

// Estimated token usage per scan type
const TOKEN_ESTIMATES = {
  text:  { input: 900,  output: 350 },
  image: { input: 1600, output: 350 },
  audio: { input: 700,  output: 350 },
  code:  { input: 950,  output: 350 },
  video: { input: 600,  output: 350 },
};

// Global stats store (persists within a serverless instance's lifetime)
if (!global._wlStats) {
  global._wlStats = {
    totalScans: 0,
    scansByType: { text: 0, image: 0, audio: 0, code: 0, video: 0 },
    scansByDay: {},       // "YYYY-MM-DD" -> count
    estimatedCostUSD: 0,
    usageMap: {},         // ip -> { weekKey -> count }
    blockedRequests: 0,
    startedAt: new Date().toISOString(),
  };
}

// Expose stats mutator so analyze.js can call it
global._wlRecordScan = function(type, ip, weekKey) {
  const s = global._wlStats;
  s.totalScans++;
  if (s.scansByType[type] !== undefined) s.scansByType[type]++;
  const day = new Date().toISOString().slice(0, 10);
  s.scansByDay[day] = (s.scansByDay[day] || 0) + 1;

  const est = TOKEN_ESTIMATES[type] || TOKEN_ESTIMATES.text;
  s.estimatedCostUSD += (est.input * COST_PER_TOKEN.input) + (est.output * COST_PER_TOKEN.output);

  if (!s.usageMap[ip]) s.usageMap[ip] = {};
  s.usageMap[ip][weekKey] = (s.usageMap[ip][weekKey] || 0);
};

global._wlRecordBlock = function() {
  global._wlStats.blockedRequests++;
};

// ── Auth helper ───────────────────────────────────────────────────────────────
function authenticate(req) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminSecret   = process.env.ADMIN_SECRET_KEY;

  if (!adminPassword || !adminSecret) return false;

  const authHeader = req.headers['authorization'] || '';
  const urlSecret  = req.query?.secret || req.body?.secret || '';

  // Check bearer token (password)
  const bearerMatch = authHeader.match(/^Bearer (.+)$/i);
  const passwordOk  = bearerMatch && bearerMatch[1] === adminPassword;

  // Check secret key in URL or body
  const secretOk = urlSecret === adminSecret;

  return passwordOk && secretOk;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!authenticate(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action } = req.query;

  // ── GET stats ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'stats') {
    const s = global._wlStats;
    const usageList = Object.entries(s.usageMap).map(([ip, weeks]) => {
      const currentWeek = getWeekKey();
      const thisWeek = weeks[currentWeek] || 0;
      const total = Object.values(weeks).reduce((a, b) => a + b, 0);
      return { ip: maskIP(ip), thisWeek, totalAllTime: total, weeks };
    }).sort((a, b) => b.thisWeek - a.thisWeek);

    // Last 7 days chart data
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      last7.push({ date: key, count: s.scansByDay[key] || 0 });
    }

    return res.status(200).json({
      totalScans: s.totalScans,
      scansByType: s.scansByType,
      estimatedCostUSD: Math.round(s.estimatedCostUSD * 10000) / 10000,
      blockedRequests: s.blockedRequests,
      activeUsers: usageList.length,
      startedAt: s.startedAt,
      last7Days: last7,
      usageList: usageList.slice(0, 100), // top 100
    });
  }

  // ── POST reset a user ──────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'reset') {
    const { maskedIp } = req.body || {};
    // Find matching IP (we store masked versions for display but need to find by pattern)
    const s = global._wlStats;
    const currentWeek = getWeekKey();
    let resetCount = 0;

    // Reset ALL users for this week (bulk reset)
    if (maskedIp === '__all__') {
      for (const ip of Object.keys(s.usageMap)) {
        if (s.usageMap[ip][currentWeek]) {
          s.usageMap[ip][currentWeek] = 0;
          resetCount++;
        }
      }
      return res.status(200).json({ success: true, message: `Reset ${resetCount} users for current week.` });
    }

    return res.status(400).json({ error: 'Provide maskedIp or __all__' });
  }

  // ── POST override weekly limit ─────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set-limit') {
    const { newLimit } = req.body || {};
    if (!newLimit || newLimit < 1 || newLimit > 100) {
      return res.status(400).json({ error: 'newLimit must be 1–100' });
    }
    global._wlWeeklyLimit = parseInt(newLimit);
    return res.status(200).json({ success: true, newLimit: global._wlWeeklyLimit });
  }

  return res.status(404).json({ error: 'Unknown action' });
}

function getWeekKey() {
  const now = new Date();
  const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.ceil((now - startOfYear) / 86400000);
  const weekNum = Math.ceil((dayOfYear + startOfYear.getUTCDay()) / 7);
  return `${now.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function maskIP(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  // IPv4: show first two octets, mask last two
  const v4 = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.*.*`;
  // IPv6: show first segment only
  const v6 = ip.split(':');
  if (v6.length > 2) return `${v6[0]}:${v6[1]}:****`;
  return ip.slice(0, 6) + '****';
}
