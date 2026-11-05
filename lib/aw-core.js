'use strict';
/* Teachers' awards board API (no login, one shared school).
   GET  /api/awards                 -> { ok, activities:[{id,data}], settings }
   POST {op:'save', id, data}       data: { program, track, type, date, teacher, students, link, createdAt }
   POST {op:'delete', id}
   POST {op:'settings', data}       data: { school, principal, termStart, weeks }
   Every update/delete of an activity is copied to aw_activities_history by a trigger. */

const MAX_ACTIVITIES = 20000;
const PROGRAMS = ['qudrat', 'tahsili', 'step'];
const YEARS = [1447, 1448, 1449, 1450];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SCHEMA = [
  `create table if not exists aw_activities (id text primary key, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
  `create table if not exists aw_settings (id text primary key, data jsonb not null, updated_at timestamptz not null default now())`,
  `create table if not exists aw_activities_history (history_id bigint generated always as identity primary key, activity_id text not null, action text not null, old_data jsonb, changed_at timestamptz not null default now())`,
  `create or replace function log_aw_change() returns trigger language plpgsql as $f$ begin insert into aw_activities_history(activity_id, action, old_data) values (old.id, tg_op, old.data); if tg_op = 'DELETE' then return old; end if; new.updated_at := now(); return new; end $f$`,
  `create or replace trigger trg_aw_history before update or delete on aw_activities for each row execute function log_aw_change()`
];

function bad(code) { const e = new Error(code); e.status = 400; e.code = code; return e; }

function validId(id) { return /^[A-Za-z0-9_-]{8,64}$/.test(id); }

function text(v, max) { return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : ''; }

function validDate(s) { return typeof s === 'string' && ISO_DATE.test(s) && !isNaN(new Date(s + 'T12:00:00Z')); }

function hijriYear(iso) {
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', year: 'numeric' }).formatToParts(new Date(iso + 'T12:00:00Z'));
  return parseInt(parts.find(p => p.type === 'year').value, 10);
}

function cleanLink(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 2000) throw bad('invalid_link');
  let u;
  try { u = new URL(raw.trim()); } catch (e) { throw bad('invalid_link'); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname.indexOf('.') < 1) throw bad('invalid_link');
  return u.href;
}

function cleanActivity(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('invalid_data');
  if (!PROGRAMS.includes(d.program)) throw bad('invalid_program');
  const track = text(d.track, 40), type = text(d.type, 80), teacher = text(d.teacher, 60);
  if (!track) throw bad('invalid_track');
  if (!type) throw bad('invalid_type');
  if (!teacher) throw bad('invalid_teacher');
  if (!validDate(d.date) || !YEARS.includes(hijriYear(d.date))) throw bad('invalid_date');
  const students = Number(d.students);
  if (!Number.isInteger(students) || students < 0 || students > 100000) throw bad('invalid_students');
  return { program: d.program, track, type, date: d.date, teacher, students, link: cleanLink(d.link), createdAt: Number(d.createdAt) || Date.now() };
}

function cleanSettings(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('invalid_settings');
  const weeks = Number(d.weeks);
  return {
    school: text(d.school, 100),
    principal: text(d.principal, 80),
    termStart: validDate(d.termStart) ? d.termStart : '',
    weeks: Number.isInteger(weeks) && weeks >= 0 && weeks <= 30 ? weeks : 0
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
        const rows = await q('select id, data from aw_activities order by created_at, id', []);
        const s = await q(`select data from aw_settings where id = 'main'`, []);
        return send(200, { ok: true, activities: rows.map(r => ({ id: r.id, data: r.data })), settings: (s[0] && s[0].data) || null });
      }
      if (req.method !== 'POST') return send(405, { ok: false, code: 'method_not_allowed' });
      let body;
      try { body = await readBody(req); } catch (e) { throw e.code ? e : bad('invalid_json'); }
      const op = body && body.op;
      if (op === 'save') {
        const id = String(body.id || '');
        if (!validId(id)) throw bad('invalid_id');
        const data = cleanActivity(body.data);
        const c = await q('select count(*)::int as n from aw_activities', []);
        if (c[0] && c[0].n >= MAX_ACTIVITIES) throw bad('too_many');
        await q('insert into aw_activities (id, data) values ($1, $2::jsonb) on conflict (id) do update set data = excluded.data returning id', [id, JSON.stringify(data)]);
        return send(200, { ok: true, data });
      }
      if (op === 'delete') {
        const id = String(body.id || '');
        if (!validId(id)) throw bad('invalid_id');
        await q('delete from aw_activities where id = $1 returning id', [id]);
        return send(200, { ok: true });
      }
      if (op === 'settings') {
        const data = cleanSettings(body.data);
        await q(`insert into aw_settings (id, data) values ('main', $1::jsonb) on conflict (id) do update set data = excluded.data, updated_at = now() returning id`, [JSON.stringify(data)]);
        return send(200, { ok: true, data });
      }
      throw bad('unknown_op');
    } catch (e) {
      if (e && e.status === 400) return send(400, { ok: false, code: 'invalid_argument', detail: e.code });
      if (e && e.code === 'NO_DB') return send(503, { ok: false, code: 'no_database' });
      console.error('awards api error', e && e.message);
      return send(500, { ok: false, code: 'unavailable' });
    }
  };
}

module.exports = { makeHandler, cleanActivity, cleanSettings };
