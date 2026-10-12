'use strict';
/* Daily attendance API (no login, one shared school).
   GET  /api/attendance                      -> { ok, days:[{id,data}], settings }
   POST {op:'saveDay', id:'YYYY-MM-DD', data}
   POST {op:'deleteDay', id}
   POST {op:'settings', data}
   Every update/delete of a day is copied to att_days_history by a trigger. */

const GROUPS = ['students', 'teachers', 'admins'];
const MAX_COUNT = 20000;

const SCHEMA = [
  `create table if not exists att_days (id text primary key, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
  `create table if not exists att_settings (id text primary key, data jsonb not null, updated_at timestamptz not null default now())`,
  `create table if not exists att_days_history (history_id bigint generated always as identity primary key, day_id text not null, action text not null, old_data jsonb, changed_at timestamptz not null default now())`,
  `create or replace function log_att_change() returns trigger language plpgsql as $f$ begin insert into att_days_history(day_id, action, old_data) values (old.id, tg_op, old.data); if tg_op = 'DELETE' then return old; end if; new.updated_at := now(); return new; end $f$`,
  `create or replace trigger trg_att_history before update or delete on att_days for each row execute function log_att_change()`
];

function bad(code) { const e = new Error(code); e.status = 400; e.code = code; return e; }
function int(v, lo, hi, code) { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(code); return n; }

function validDateId(id) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) return false;
  const d = new Date(id + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === id && d.getUTCFullYear() >= 2024 && d.getUTCFullYear() <= 2035;
}

function cleanDay(id, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('invalid_data');
  const out = {
    date: id,
    hY: int(d.hY, 1446, 1460, 'invalid_hY'), hM: int(d.hM, 1, 12, 'invalid_hM'), hD: int(d.hD, 1, 30, 'invalid_hD'),
    notes: typeof d.notes === 'string' ? d.notes.trim().slice(0, 1000) : '',
    createdAt: typeof d.createdAt === 'string' ? d.createdAt.slice(0, 40) : '',
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt.slice(0, 40) : ''
  };
  for (const g of GROUPS) {
    const x = d[g];
    if (!x || typeof x !== 'object') throw bad('invalid_' + g);
    const total = int(x.total, 0, MAX_COUNT, 'invalid_' + g + '_total');
    const absent = int(x.absent, 0, MAX_COUNT, 'invalid_' + g + '_absent');
    if (absent > total) throw bad('absent_exceeds_total_' + g);
    out[g] = { total, absent };
  }
  if (out.students.total + out.teachers.total + out.admins.total === 0) throw bad('empty_totals');
  return out;
}

function cleanSettings(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('invalid_settings');
  return {
    schoolName: typeof d.schoolName === 'string' ? d.schoolName.trim().slice(0, 150) : '',
    students: int(d.students, 0, MAX_COUNT, 'invalid_students'),
    teachers: int(d.teachers, 0, MAX_COUNT, 'invalid_teachers'),
    admins: int(d.admins, 0, MAX_COUNT, 'invalid_admins'),
    leadership: int(d.leadership, 0, MAX_COUNT, 'invalid_leadership')
  };
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
        const rows = await q('select id, data from att_days order by id', []);
        const s = await q(`select data from att_settings where id = 'main'`, []);
        return send(200, { ok: true, days: rows.map(r => ({ id: r.id, data: r.data })), settings: (s[0] && s[0].data) || null });
      }
      if (req.method !== 'POST') return send(405, { ok: false, code: 'method_not_allowed' });
      let body;
      try { body = await readBody(req); } catch (e) { throw e.code ? e : bad('invalid_json'); }
      const op = body && body.op;
      if (op === 'saveDay') {
        const id = String(body.id || '');
        if (!validDateId(id)) throw bad('invalid_id');
        const data = cleanDay(id, body.data);
        await q('insert into att_days (id, data) values ($1, $2::jsonb) on conflict (id) do update set data = excluded.data returning id', [id, JSON.stringify(data)]);
        return send(200, { ok: true });
      }
      if (op === 'deleteDay') {
        const id = String(body.id || '');
        if (!validDateId(id)) throw bad('invalid_id');
        await q('delete from att_days where id = $1 returning id', [id]);
        return send(200, { ok: true });
      }
      if (op === 'settings') {
        const data = cleanSettings(body.data);
        await q(`insert into att_settings (id, data) values ('main', $1::jsonb) on conflict (id) do update set data = excluded.data, updated_at = now() returning id`, [JSON.stringify(data)]);
        return send(200, { ok: true });
      }
      throw bad('unknown_op');
    } catch (e) {
      if (e && e.status === 400) return send(400, { ok: false, code: 'invalid_argument', detail: e.code });
      if (e && e.code === 'NO_DB') return send(503, { ok: false, code: 'no_database' });
      console.error('attendance api error', e && e.message);
      return send(500, { ok: false, code: 'unavailable' });
    }
  };
}

module.exports = { makeHandler, cleanDay, cleanSettings };
