'use strict';
/* Dashboard data API (no login): one shared plan.
   GET  /api/data                 -> { ok, programs:[{id,data}], school }
   POST /api/data {op:'save', id, data}
   POST /api/data {op:'delete', id}
   POST /api/data {op:'school', name}
   Every update/delete is copied to programs_history by a trigger (recovery from mistakes). */

const TYPES = ['educational', 'cultural', 'sports', 'social', 'tech', 'development', 'health', 'scientific', 'other'];
const RESP = ['admin', 'excellence', 'achievement', 'guidance', 'health', 'activity', 'teachers', 'other'];
const STATUS = ['done', 'progress', 'notdone'];
const TEXT_LIMITS = {
  typeOther: 80, name: 200, activities: 5000, responsibleOther: 80, targetGroup: 300, mainEntity: 300,
  supportEntity: 300, execTime: 300, indicator: 2000, evidenceUrl: 2000, challenges: 5000, createdAt: 40, updatedAt: 40
};
const MAX_PROGRAMS = 5000;

const SCHEMA = [
  `create table if not exists programs (id text primary key, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
  `create table if not exists settings (id text primary key, data jsonb not null, updated_at timestamptz not null default now())`,
  `create table if not exists programs_history (history_id bigint generated always as identity primary key, program_id text not null, action text not null, old_data jsonb, changed_at timestamptz not null default now())`,
  `create or replace function log_program_change() returns trigger language plpgsql as $f$ begin insert into programs_history(program_id, action, old_data) values (old.id, tg_op, old.data); if tg_op = 'DELETE' then return old; end if; new.updated_at := now(); return new; end $f$`,
  `create or replace trigger trg_programs_history before update or delete on programs for each row execute function log_program_change()`
];

function bad(code) { const e = new Error(code); e.status = 400; e.code = code; return e; }

function cleanProgram(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('invalid_data');
  const out = {};
  for (const k of Object.keys(TEXT_LIMITS)) {
    const v = d[k] == null ? '' : d[k];
    if (typeof v !== 'string') throw bad('invalid_' + k);
    out[k] = v.trim().slice(0, TEXT_LIMITS[k]);
  }
  if (!TYPES.includes(d.type)) throw bad('invalid_type');
  if (!RESP.includes(d.responsible)) throw bad('invalid_responsible');
  if (!STATUS.includes(d.status)) throw bad('invalid_status');
  out.type = d.type; out.responsible = d.responsible; out.status = d.status;
  if (!out.name) throw bad('invalid_name');
  if (out.type !== 'other') out.typeOther = '';
  else if (!out.typeOther) throw bad('invalid_typeOther');
  if (out.responsible !== 'other') out.responsibleOther = '';
  else if (!out.responsibleOther) throw bad('invalid_responsibleOther');
  const ints = { hDay: [1, 30], hMonth: [1, 12], hYear: [1446, 1600], progress: [0, 100] };
  for (const k of Object.keys(ints)) {
    const n = Number(d[k]);
    if (!Number.isInteger(n) || n < ints[k][0] || n > ints[k][1]) throw bad('invalid_' + k);
    out[k] = n;
  }
  if (out.evidenceUrl) {
    let u; try { u = new URL(out.evidenceUrl); } catch (e) { throw bad('invalid_evidenceUrl'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('invalid_evidenceUrl');
    out.evidenceUrl = u.href;
  }
  return out;
}

function makeHandler(getQuery) {
  let ready = null;
  async function ensureSchema(q) {
    if (!ready) {
      ready = (async () => {
        for (const stmt of SCHEMA) {
          try { await q(stmt, []); }
          catch (e) { await new Promise(r => setTimeout(r, 300)); await q(stmt, []); } // concurrent cold starts
        }
      })().catch(e => { ready = null; throw e; });
    }
    return ready;
  }
  async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 200000) throw bad('too_large'); chunks.push(c); }
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
        const rows = await q('select id, data from programs order by created_at, id', []);
        const s = await q(`select data from settings where id = 'main'`, []);
        return send(200, { ok: true, programs: rows.map(r => ({ id: r.id, data: r.data })), school: (s[0] && s[0].data && s[0].data.schoolName) || '', serverTime: new Date().toISOString() });
      }
      if (req.method !== 'POST') return send(405, { ok: false, code: 'method_not_allowed' });
      let body;
      try { body = await readBody(req); } catch (e) { throw e.code ? e : bad('invalid_json'); }
      const op = body && body.op;
      if (op === 'save') {
        const id = String(body.id || '');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw bad('invalid_id');
        const data = cleanProgram(body.data);
        const exists = await q('select 1 as x from programs where id = $1', [id]);
        if (!exists.length) {
          if (body.expectExisting) return send(409, { ok: false, code: 'gone' });
          const c = await q('select count(*)::int as n from programs', []);
          if (c[0].n >= MAX_PROGRAMS) return send(507, { ok: false, code: 'quota_exceeded' });
        }
        await q('insert into programs (id, data) values ($1, $2::jsonb) on conflict (id) do update set data = excluded.data returning id', [id, JSON.stringify(data)]);
        return send(200, { ok: true });
      }
      if (op === 'delete') {
        const id = String(body.id || '');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw bad('invalid_id');
        await q('delete from programs where id = $1 returning id', [id]);
        return send(200, { ok: true });
      }
      if (op === 'school') {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 150) : '';
        await q(`insert into settings (id, data) values ('main', $1::jsonb) on conflict (id) do update set data = excluded.data, updated_at = now() returning id`, [JSON.stringify({ schoolName: name })]);
        return send(200, { ok: true });
      }
      throw bad('unknown_op');
    } catch (e) {
      if (e && e.status === 400) return send(400, { ok: false, code: 'invalid_argument', detail: e.code });
      if (e && e.code === 'NO_DB') return send(503, { ok: false, code: 'no_database' });
      console.error('api error', e && e.message);
      return send(500, { ok: false, code: 'unavailable' });
    }
  };
}

module.exports = { makeHandler, cleanProgram };
