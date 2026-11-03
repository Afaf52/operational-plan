'use strict';
/* Evidence file API (no login, one shared school).
   GET  /api/evidence                  -> { ok, links:[{id,data}], settings }
   POST {op:'saveLink', id, data}      data: { band, year, url, title, createdAt }
   POST {op:'deleteLink', id}
   POST {op:'settings', data}          data: { schoolName }
   Every update/delete of a link is copied to ev_links_history by a trigger. */

const MAX_LINKS = 5000;
const YEARS = [1447, 1448, 1449, 1450];
// Links saved before years were added belong to 1448, the year they were entered in.
const DEFAULT_YEAR = 1448;

const SCHEMA = [
  `create table if not exists ev_links (id text primary key, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
  `create table if not exists ev_settings (id text primary key, data jsonb not null, updated_at timestamptz not null default now())`,
  `create table if not exists ev_links_history (history_id bigint generated always as identity primary key, link_id text not null, action text not null, old_data jsonb, changed_at timestamptz not null default now())`,
  `create or replace function log_ev_change() returns trigger language plpgsql as $f$ begin insert into ev_links_history(link_id, action, old_data) values (old.id, tg_op, old.data); if tg_op = 'DELETE' then return old; end if; new.updated_at := now(); return new; end $f$`,
  `create or replace trigger trg_ev_history before update or delete on ev_links for each row execute function log_ev_change()`
];

function bad(code) { const e = new Error(code); e.status = 400; e.code = code; return e; }

function validId(id) { return /^[A-Za-z0-9_-]{8,64}$/.test(id); }

function cleanUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) throw bad('invalid_url');
  let u;
  try { u = new URL(raw.trim()); } catch (e) { throw bad('invalid_url'); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname.indexOf('.') < 1) throw bad('invalid_url');
  return u.href;
}

function cleanLink(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('invalid_data');
  if (typeof d.band !== 'string' || !/^e\d{2}-b\d{2}$/.test(d.band)) throw bad('invalid_band');
  const year = d.year === undefined || d.year === null ? DEFAULT_YEAR : Number(d.year);
  if (!YEARS.includes(year)) throw bad('invalid_year');
  return {
    band: d.band,
    year,
    url: cleanUrl(d.url),
    title: typeof d.title === 'string' ? d.title.trim().slice(0, 150) : '',
    createdAt: typeof d.createdAt === 'string' ? d.createdAt.slice(0, 40) : ''
  };
}

function cleanSettings(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('invalid_settings');
  return { schoolName: typeof d.schoolName === 'string' ? d.schoolName.trim().slice(0, 150) : '' };
}

function makeHandler(getQuery) {
  let ready = null;
  async function ensureSchema(q) {
    if (!ready) {
      ready = (async () => {
        for (const stmt of SCHEMA) {
          try { await q(stmt, []); }
          catch (e) { await new Promise(r => setTimeout(r, 300)); await q(stmt, []); }
        }
      })().catch(e => { ready = null; throw e; });
    }
    return ready;
  }
  async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 100000) throw bad('too_large'); chunks.push(c); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  return async function handler(req, res) {
    const send = (status, obj) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(obj));
    };
    try {
      const q = getQuery();
      await ensureSchema(q);
      if (req.method === 'GET') {
        const rows = await q('select id, data from ev_links order by created_at, id', []);
        const s = await q(`select data from ev_settings where id = 'main'`, []);
        return send(200, { ok: true, links: rows.map(r => ({ id: r.id, data: r.data })), settings: (s[0] && s[0].data) || null });
      }
      if (req.method !== 'POST') return send(405, { ok: false, code: 'method_not_allowed' });
      let body;
      try { body = await readBody(req); } catch (e) { throw e.code ? e : bad('invalid_json'); }
      const op = body && body.op;
      if (op === 'saveLink') {
        const id = String(body.id || '');
        if (!validId(id)) throw bad('invalid_id');
        const data = cleanLink(body.data);
        const c = await q('select count(*)::int as n from ev_links', []);
        if (c[0] && c[0].n >= MAX_LINKS) throw bad('too_many');
        await q('insert into ev_links (id, data) values ($1, $2::jsonb) on conflict (id) do update set data = excluded.data returning id', [id, JSON.stringify(data)]);
        return send(200, { ok: true });
      }
      if (op === 'deleteLink') {
        const id = String(body.id || '');
        if (!validId(id)) throw bad('invalid_id');
        await q('delete from ev_links where id = $1 returning id', [id]);
        return send(200, { ok: true });
      }
      if (op === 'settings') {
        const data = cleanSettings(body.data);
        await q(`insert into ev_settings (id, data) values ('main', $1::jsonb) on conflict (id) do update set data = excluded.data, updated_at = now() returning id`, [JSON.stringify(data)]);
        return send(200, { ok: true });
      }
      throw bad('unknown_op');
    } catch (e) {
      if (e && e.status === 400) return send(400, { ok: false, code: 'invalid_argument', detail: e.code });
      if (e && e.code === 'NO_DB') return send(503, { ok: false, code: 'no_database' });
      console.error('evidence api error', e && e.message);
      return send(500, { ok: false, code: 'unavailable' });
    }
  };
}

module.exports = { makeHandler, cleanLink, cleanSettings };
