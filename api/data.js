'use strict';
// Vercel serverless function: /api/data — connects to the Neon database added from Vercel → Storage.
const { neon } = require('@neondatabase/serverless');
const { makeHandler } = require('../lib/core');

let query = null;
function getQuery() {
  if (!query) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
    if (!url) { const e = new Error('NO_DB'); e.code = 'NO_DB'; throw e; }
    const sql = neon(url);
    query = (text, params) => sql.query(text, params || []);
  }
  return query;
}

module.exports = makeHandler(getQuery);
