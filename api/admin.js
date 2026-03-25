const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

async function redis(...args) {
  const r = await fetch(`${REDIS_URL}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const d = await r.json();
  return d.result;
}

function authenticate(req) {
  const pw = process.env.ADMIN_PASSWORD;
  const sk = process.env.ADMIN_SECRET_KEY;
  if (!pw || !sk) return false;
  const auth = req.headers["authorization"] || "";
  const m = auth.match(/^Bearer (.+)$/i);
  const secret = req.query?.secret || req.body?.secret || "";
  return m && m[1] === pw && secret === sk;
}

function getWeekKey() {
  const now = new Date();
  const s = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const d = Math.ceil((now - s) / 86400000);
  const w = Math.ceil((d + s.getUTCDay()) / 7);
  return `${now.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}

function maskIP(ip) {
  if (!ip || ip === "unknown") return "unknown";
  const v4 = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.*.*`;
  return ip.slice(0, 8) + "****";
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!authenticate(req)) return res.status(401).json({ error: "Unauthorized" });

  const { action } = req.query;

  if (req.method === "GET" && action === "stats") {
    const weekKey = getWeekKey();
    const [total, blocked, costRaw, limit, tText, tImage, tAudio, tCode, tVideo] = await Promise.all([
      redis("GET", "wl:stats:total"),
      redis("GET", "wl:stats:blocked"),
      redis("GET", "wl:stats:cost"),
      redis("GET", "wl:weekly_limit"),
      redis("GET", "wl:stats:type:text"),
      redis("GET", "wl:stats:type:image"),
      redis("GET", "wl:stats:type:audio"),
      redis("GET", "wl:stats:type:code"),
      redis("GET", "wl:stats:type:video"),
    ]);

    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const count = await redis("GET", `wl:stats:day:${key}`);
      last7.push({ date: key, count: parseInt(count || "0") });
    }

    const ips = (await redis("SMEMBERS", "wl:ips:seen")) || [];
    const ipList = Array.isArray(ips) ? ips : [ips].filter(Boolean);
    const userList = [];
    for (const ip of ipList.slice(0, 50)) {
      const thisWeek = parseInt((await redis("GET", `wl:ip:${ip}:${weekKey}`)) || "0");
      const allTime = parseInt((await redis("GET", `wl:ip:${ip}:total`)) || "0");
      userList.push({ ip: maskIP(ip), thisWeek, totalAllTime: allTime });
    }
    userList.sort((a, b) => b.thisWeek - a.thisWeek);

    return res.status(200).json({
      totalScans: parseInt(total || "0"),
      blockedRequests: parseInt(blocked || "0"),
      estimatedCostUSD: parseFloat(parseFloat(costRaw || "0").toFixed(4)),
      weeklyLimit: parseInt(limit || "2"),
      activeUsers: ipList.length,
      scansByType: {
        text: parseInt(tText || "0"), image: parseInt(tImage || "0"),
        audio: parseInt(tAudio || "0"), code: parseInt(tCode || "0"), video: parseInt(tVideo || "0")
      },
      last7Days: last7,
      usageList: userList,
    });
  }

  if (req.method === "POST" && action === "set-limit") {
    const { newLimit } = req.body || {};
    if (!newLimit || newLimit < 1 || newLimit > 100) return res.status(400).json({ error: "newLimit must be 1-100" });
    await redis("SET", "wl:weekly_limit", String(parseInt(newLimit)));
    return res.status(200).json({ success: true, newLimit: parseInt(newLimit) });
  }

  if (req.method === "POST" && action === "reset") {
    const { maskedIp } = req.body || {};
    if (maskedIp === "__all__") {
      const ips = (await redis("SMEMBERS", "wl:ips:seen")) || [];
      const ipList = Array.isArray(ips) ? ips : [ips].filter(Boolean);
      const weekKey = getWeekKey();
      await Promise.all(ipList.map(ip => redis("SET", `wl:ip:${ip}:${weekKey}`, "0")));
      return res.status(200).json({ success: true, message: `Reset ${ipList.length} users.` });
    }
    return res.status(400).json({ error: "Provide maskedIp=__all__" });
  }

  return res.status(404).json({ error: "Unknown action" });
};
