// 조 편성·토너먼트 메이커 — 공유 저장 API (Vercel Function + Upstash Redis REST)
// 환경변수: KV_REST_API_URL / KV_REST_API_TOKEN (Upstash 연결 시 자동)
//   ADMIN_PIN(관리자: 전부 편집) / REF_PIN(심판: 경기 결과만 입력) / VIEW_PIN(학생 열람, 비우면 누구나 보기)
// 저장 구조: tm:ws(대진 탭 원본) · tm:res:<탭id>(경기 결과, 경기마다 따로) · tm:log:<탭id>(입력 기록) · tm:rev(변경 번호)
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const EDIT = (process.env.ADMIN_PIN || '').trim();
const REF = (process.env.REF_PIN || '').trim();
const VIEW = (process.env.VIEW_PIN || '').trim();
const ID = /^[a-z0-9]{1,24}$/i;

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
  if (REF && p === REF) return 'ref';
  if (!VIEW || p === VIEW) return 'view';
  return null;
}
function nameOf(req, role) {
  let n = '';
  try { n = decodeURIComponent(String(req.headers['x-name'] || '')); } catch (e) {}
  n = n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return n || (role === 'edit' ? '관리자' : '심판');
}
function send(res, code, obj, role) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj, role === 'view' ? (k, v) => (k === 'by' || k === 'byRole' || k === 'log' ? undefined : v) : undefined));
}
const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});
const tidOf = w => String((w && w.tour && w.tour.tid) || '0');

// 세로형 토너먼트: 앞 경기 결과가 바뀌면 뒤 경기 결과를 정리
const tPart = (T, ch) => (ch.t === 's' ? T.leaves[ch.v] : T.nodes[ch.v] ? T.nodes[ch.v].w ?? null : null);
function thirdParts(T) {
  const r = T.nodes[T.root]; if (!r) return [null, null];
  return r.c.map(ch => { if (ch.t !== 'm') return null; const nd = T.nodes[ch.v], ps = nd.c.map(x => tPart(T, x));
    return nd.w === null || ps.includes(null) ? null : ps.find(p => p !== nd.w); });
}
function resolveTree(T) {
  if (!Array.isArray(T.nodes)) return;
  T.nodes.map((_, i) => i).sort((a, b) => T.nodes[a].h - T.nodes[b].h).forEach(i => {
    const nd = T.nodes[i], ps = nd.c.map(ch => tPart(T, ch));
    if (nd.w !== null && nd.w !== undefined && (ps.includes(null) || !ps.includes(nd.w))) nd.w = null; });
  if (T.third) { const ps = thirdParts(T); if (T.third.w !== null && (ps.includes(null) || !ps.includes(T.third.w))) T.third.w = null; }
}
// 경기별 결과를 원본 위에 덮어쓰기
function overlay(w, flat, logs) {
  const T = w.tour; if (!T) return;
  const tid = tidOf(w);
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    const [t, k] = String(flat[i]).split('|'); if (t !== tid || !k) continue;
    let v; try { v = JSON.parse(flat[i + 1]); } catch (e) { continue; }
    if (k.startsWith('lg:') && Array.isArray(T.rounds)) {
      const [r, j] = k.slice(3).split('-').map(Number), m = T.rounds[r] && T.rounds[r][j];
      if (m) Object.assign(m, { sa: v.sa, sb: v.sb, by: v.by, byRole: v.byRole, at: v.at });
    } else if (k.startsWith('t:') && Array.isArray(T.nodes)) {
      const n = k.slice(2), m = n === 'third' ? T.third : T.nodes[+n];
      if (m) Object.assign(m, { w: v.w, by: v.by, byRole: v.byRole, at: v.at });
    }
  }
  if (T.type === 'tree') resolveTree(T);
  T.log = (logs || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}
const cleanSc = v => String(v ?? '').replace(/[^0-9.\-]/g, '').slice(0, 5);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!RURL || !RTOK) return send(res, 503, { error: 'storage_not_configured' });
  const role = roleOf(req);
  if (!role) return send(res, 401, { error: 'pin', needView: !!VIEW });
  try {
    if (req.method === 'GET') {
      const [rv] = await redis([['GET', 'tm:rev']]);
      const rev = Number(rv || 0);
      if (req.query.rev !== undefined && Number(req.query.rev) === rev) return send(res, 200, { role, rev });
      const [h] = await redis([['HGETALL', 'tm:ws']]);
      const ws = [];
      for (let i = 0; i + 1 < (h || []).length; i += 2) { try { ws.push(JSON.parse(h[i + 1])); } catch (e) {} }
      const live = ws.filter(b => b && b.ws && ID.test(b.ws.id) && b.ws.tour);
      if (live.length) {
        const out = await redis(live.flatMap(b => [['HGETALL', 'tm:res:' + b.ws.id], ['LRANGE', 'tm:log:' + b.ws.id, '-300', '-1']]));
        live.forEach((b, i) => overlay(b.ws, out[2 * i], role === 'view' ? [] : out[2 * i + 1]));
      }
      return send(res, 200, { role, rev, ws }, role);
    }
    // 심판·관리자: 경기 결과 입력
    if (req.method === 'PATCH') {
      if (role === 'view') return send(res, 403, { error: 'readonly' });
      const b = body(req), id = String(b.id || '');
      if (!ID.test(id)) return send(res, 400, { error: 'bad_request' });
      const [raw] = await redis([['HGET', 'tm:ws', id]]);
      if (!raw) return send(res, 404, { error: 'not_found' });
      const w = JSON.parse(raw).ws, T = w.tour, tid = tidOf(w);
      if (!T || String(b.tid || '0') !== tid) return send(res, 409, { error: 'changed' });
      const by = nameOf(req, role), at = Date.now(), txt = String(b.txt || '').slice(0, 120);
      const cmds = [];
      if (b.op === 'reset') {
        if (role !== 'edit') return send(res, 403, { error: 'admin_only' });
        cmds.push(['DEL', 'tm:res:' + id]);
      } else {
        const k = String(b.k || '');
        let v;
        if (/^lg:\d{1,3}-\d{1,3}$/.test(k) && T.type === 'league') {
          const [r, j] = k.slice(3).split('-').map(Number);
          if (!(T.rounds[r] && T.rounds[r][j])) return send(res, 400, { error: 'bad_match' });
          v = { sa: cleanSc(b.sa), sb: cleanSc(b.sb) };
        } else if (/^t:(\d{1,3}|third)$/.test(k) && T.type === 'tree') {
          const n = k.slice(2);
          if (!(n === 'third' ? T.third : T.nodes[+n])) return send(res, 400, { error: 'bad_match' });
          v = { w: Number.isInteger(b.w) && b.w >= 0 && b.w < T.names.length ? b.w : null };
        } else return send(res, 400, { error: 'bad_match' });
        cmds.push(['HSET', 'tm:res:' + id, tid + '|' + k, JSON.stringify(Object.assign(v, { by, byRole: role, at }))]);
      }
      cmds.push(['RPUSH', 'tm:log:' + id, JSON.stringify({ at, by, byRole: role, txt })], ['LTRIM', 'tm:log:' + id, '-1000', '-1'], ['INCR', 'tm:rev']);
      const out = await redis(cmds);
      return send(res, 200, { rev: out[out.length - 1], by, at });
    }
    if (role !== 'edit') return send(res, 403, { error: 'readonly' });
    if (req.method === 'PUT') {
      const b = body(req), w = b && b.ws;
      if (!w || typeof w.id !== 'string' || !ID.test(w.id)) return send(res, 400, { error: 'bad_request' });
      if (w.tour) delete w.tour.log;
      const s = JSON.stringify({ ws: w, order: Number(b.order) || 0 });
      if (s.length > 900000) return send(res, 413, { error: 'too_big' });
      const [old] = await redis([['HGET', 'tm:ws', w.id]]);
      let oldTid = null; try { oldTid = old ? tidOf(JSON.parse(old).ws) : null; } catch (e) {}
      const cmds = [['HSET', 'tm:ws', w.id, s]];
      // 대진을 새로 뽑았거나 자리를 바꾼 경우(tid 변경): 이전 결과·기록 삭제
      if (oldTid !== null && oldTid !== tidOf(w)) cmds.push(['DEL', 'tm:res:' + w.id], ['DEL', 'tm:log:' + w.id]);
      cmds.push(['INCR', 'tm:rev']);
      const out = await redis(cmds);
      return send(res, 200, { rev: out[out.length - 1] });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!ID.test(id)) return send(res, 400, { error: 'bad_request' });
      const out = await redis([['HDEL', 'tm:ws', id], ['DEL', 'tm:res:' + id], ['DEL', 'tm:log:' + id], ['INCR', 'tm:rev']]);
      return send(res, 200, { rev: out[out.length - 1] });
    }
    return send(res, 405, { error: 'method' });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
};
