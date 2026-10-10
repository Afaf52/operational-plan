'use strict';
// Vercel serverless function: /api/data — connects to the Neon database added from Vercel → Storage.
const { neon } = require('@neondatabase/serverless');
const { makeHandler } = require('../lib/core');

let query = null;
function getQuery() {
  if (!query) {
    const env = process.env;
    const url = env.DATABASE_URL || env.POSTGRES_URL || env.STORAGE_URL || env.NEON_DATABASE_URL ||
      Object.keys(env).filter(k => /(_DATABASE_URL|_POSTGRES_URL|^[A-Z0-9]+_URL)$/.test(k) && /^postgres(ql)?:\/\//.test(env[k] || '')).map(k => env[k])[0];
    if (!url) { const e = new Error('NO_DB'); e.code = 'NO_DB'; throw e; }
    const sql = neon(url);
    query = (text, params) => sql.query(text, params || []);
  }
  return query;
}

module.exports = makeHandler(getQuery);
