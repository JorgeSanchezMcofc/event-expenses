// Runs apps-script/Code.gs in Node against a JSON copy of the Sheet, with the Apps Script
// services it uses stubbed out. Used by test/checks.js and test/dev-server.js.
// The fixture holds real data, so it is never committed (see .gitignore).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function loadGas({ fixture, tokens }) {
  const data = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  // data: { tabName: [[row1...], ...] } including header row; dates as "yyyy-mm-dd" strings
  const reviveDates = (tab, col) => {
    (data[tab] || []).forEach((r, i) => {
      if (i && typeof r[col] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r[col])) {
        const [y, m, d] = r[col].split('-').map(Number);
        r[col] = new Date(y, m - 1, d);
      }
    });
  };
  reviveDates('Expenses', 3);
  reviveDates('Events', 6);

  class Range {
    constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
    getValues() {
      const out = [];
      for (let r = 0; r < this.nr; r++) {
        const src = this.sheet.rows[this.row - 1 + r] || [];
        const line = [];
        for (let c = 0; c < this.nc; c++) {
          const v = src[this.col - 1 + c];
          line.push(v === undefined || v === null ? '' : v);
        }
        out.push(line);
      }
      return out;
    }
    setValues(vals) {
      vals.forEach((line, r) => {
        const idx = this.row - 1 + r;
        while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
        line.forEach((v, c) => { this.sheet.rows[idx][this.col - 1 + c] = v; });
      });
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    clearContent() { return this.setValues(Array.from({ length: this.nr }, () => Array(this.nc).fill(''))); }
  }
  class Sheet {
    constructor(name, rows) { this.name = name; this.rows = rows; }
    getLastRow() {
      for (let i = this.rows.length - 1; i >= 0; i--) if ((this.rows[i] || []).some(v => v !== '' && v !== null && v !== undefined)) return i + 1;
      return 0;
    }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    getDataRange() { return new Range(this, 1, 1, this.getLastRow(), Math.max(...this.rows.map(r => r.length))); }
  }
  const sheets = {};
  Object.keys(data).forEach(k => { sheets[k] = new Sheet(k, data[k]); });
  const external = {};
  const ss = { getSheetByName: n => sheets[n] || null };

  const pad = n => String(n).padStart(2, '0');
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: id => { if (!external[id]) throw new Error('not shared'); return external[id]; }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => ({ CLIENT_ID: 'test-client', ALLOWED_EMAIL: process.env.ALLOWED_EMAIL || 'jsanchez@mcallenchamber.com' })[k] }) },
    CacheService: { getScriptCache: () => { const m = {}; return { get: k => m[k] || null, put: (k, v) => { m[k] = v; } }; } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    Utilities: {
      formatDate: (d, tz, f) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'),
      computeDigest: (alg, s) => crypto.createHash('sha256').update(s).digest(),
      DigestAlgorithm: { SHA_256: 'sha256' }
    },
    UrlFetchApp: {
      fetch: url => {
        const tok = decodeURIComponent(url.split('id_token=')[1]);
        const info = tokens[tok];
        return { getResponseCode: () => (info ? 200 : 400), getContentText: () => JSON.stringify(info || { error: 'invalid_token' }) };
      }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });

  const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const get = params => JSON.parse(ctx.doGet({ parameter: params }).text);
  const addExternal = (id, rows) => { external[id] = { getSheetByName: n => (n === '$ Revenue' ? new Sheet(n, rows) : null) }; };
  return { call, get, sheets, addExternal, ctx };
}

const exp = Math.floor(Date.now() / 1000) + 3600;
const TEST_TOKENS = {
  'tok-jorge': { aud: 'test-client', iss: 'https://accounts.google.com', email: 'jsanchez@mcallenchamber.com', email_verified: 'true', exp: String(exp) },
  'tok-other': { aud: 'test-client', iss: 'https://accounts.google.com', email: 'someone.else@example.com', email_verified: 'true', exp: String(exp) },
  'tok-wrong-aud': { aud: 'someone-elses-app', iss: 'https://accounts.google.com', email: 'jsanchez@mcallenchamber.com', email_verified: 'true', exp: String(exp) }
};

module.exports = { loadGas, TEST_TOKENS };
