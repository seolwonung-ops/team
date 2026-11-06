// 조 편성·토너먼트 메이커 — 공유 저장 API (Vercel Function + Upstash Redis REST)
// 환경변수: KV_REST_API_URL / KV_REST_API_TOKEN (Upstash 연결 시 자동), ADMIN_PIN(편집), VIEW_PIN(열람, 비우면 누구나 보기)
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const EDIT = (process.env.ADMIN_PIN || '').trim();
const VIEW = (process.env.VIEW_PIN || '').trim();

async function redis(cmds) {
  const r = await fetch(RURL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
function roleOf(req) {
  const p = String(req.headers['x-pin'] || '').trim();
  if (EDIT && p === EDIT) return 'edit';
  if (!VIEW || p === VIEW) return 'view';
  return null;
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!RURL || !RTOK) return res.status(503).json({ error: 'storage_not_configured' });
  const role = roleOf(req);
  if (!role) return res.status(401).json({ error: 'pin', needView: !!VIEW });
  try {
    if (req.method === 'GET') {
      const [rv] = await redis([['GET', 'tm:rev']]);
      const rev = Number(rv || 0);
      if (req.query.rev !== undefined && Number(req.query.rev) === rev) return res.json({ role, rev });
      const [h] = await redis([['HGETALL', 'tm:ws']]);
      const ws = [];
      for (let i = 0; i + 1 < (h || []).length; i += 2) { try { ws.push(JSON.parse(h[i + 1])); } catch (e) {} }
      return res.json({ role, rev, ws });
    }
    if (role !== 'edit') return res.status(403).json({ error: 'readonly' });
    if (req.method === 'PUT') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const w = b && b.ws;
      if (!w || typeof w.id !== 'string' || !/^[a-z0-9]{1,24}$/i.test(w.id)) return res.status(400).json({ error: 'bad_request' });
      const s = JSON.stringify({ ws: w, order: Number(b.order) || 0 });
      if (s.length > 900000) return res.status(413).json({ error: 'too_big' });
      const out = await redis([['HSET', 'tm:ws', w.id, s], ['INCR', 'tm:rev']]);
      return res.json({ rev: out[1] });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!/^[a-z0-9]{1,24}$/i.test(id)) return res.status(400).json({ error: 'bad_request' });
      const out = await redis([['HDEL', 'tm:ws', id], ['INCR', 'tm:rev']]);
      return res.json({ rev: out[1] });
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
