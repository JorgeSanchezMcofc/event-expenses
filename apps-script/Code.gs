/**
 * Event Expense Tracker API (bound to the "Event Expense Tracker" Google Sheet).
 *
 * Every request must carry a Google ID token (from Google Sign-In on the front end).
 * The token is checked against Google's tokeninfo endpoint; only the address in the
 * ALLOWED_EMAIL script property gets data. Nothing secret lives in this file: the
 * OAuth client ID and the allowed email are script properties (see README).
 *
 * Reads:  catalog, expenses, summary, history, revenue, reconcile
 * Writes: expense (create / update / cancel), refreshRevenue
 * GET  ?action=summary&fy=26-27&event=BANQUET&token=...
 * POST {"action":"summary","fy":"26-27","event":"BANQUET","token":"..."} as text/plain
 */

var TABS = { events: 'Events', catalog: 'Catalog', expenses: 'Expenses', revenue: 'Revenue', history: 'History', config: 'Config' };

var COLS = {
  events: ['id', 'name', 'aliases', 'fy', 'expAcct', 'revAcct', 'date', 'attendees', 'track', 'revSheets', 'notes'],
  catalog: ['fy', 'eventId', 'side', 'acct', 'sub', 'label', 'cat', 'budget', 'adjusted', 'note'],
  expenses: ['id', 'fy', 'eventId', 'date', 'vendor', 'description', 'cat', 'acct', 'sub', 'amount', 'status',
    'payType', 'po', 'poDone', 'checkDone', 'actual', 'notes', 'review'],
  revenue: ['fy', 'eventId', 'level', 'count', 'revenue', 'inkind', 'source'],
  history: ['eventId', 'fy', 'type', 'revenue', 'expenditures', 'profit', 'source']
};

var TEXT_FIELDS = { fy: 1, acct: 1, sub: 1, po: 1, expAcct: 1, revAcct: 1 };

// Dashboard buckets: Estimation, Quote and Pending Approval roll up into "estimated".
var STATUS_BUCKET = { 'Estimation': 'estimated', 'Quote': 'estimated', 'Pending Approval': 'estimated',
  'Approved': 'approved', 'Invoiced': 'invoiced', 'Paid': 'paid' };

var REVENUE_SHEET_TAB = '$ Revenue';

/* ------------------------------------------------------------------ entry points */

function doGet(e) {
  var p = (e && e.parameter) || {};
  return respond_(p.action || p.path, p);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad request body' }); }
  return respond_(body.action, body);
}

function respond_(action, p) {
  try {
    var user = verifyToken_(p.token);
    var data;
    switch (action) {
      case 'catalog': data = apiCatalog_(p.fy); break;
      case 'expenses': data = apiExpenses_(p.fy, p.event); break;
      case 'summary': data = apiSummary_(p.fy, p.event); break;
      case 'history': data = apiHistory_(p.event); break;
      case 'revenue': data = apiRevenue_(p.fy, p.event); break;
      case 'reconcile': data = apiReconcile_(p.fy); break;
      case 'expense': data = apiSaveExpense_(p.op || 'create', p.expense || {}); break;
      case 'refreshRevenue': data = apiRefreshRevenue_(p.fy); break;
      case 'whoami': data = { email: user.email }; break;
      default: throw new Error('Unknown action: ' + action);
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ auth */

function verifyToken_(token) {
  if (!token) throw new Error('Not signed in');
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('CLIENT_ID');
  var allowed = String(props.getProperty('ALLOWED_EMAIL') || '').toLowerCase();
  if (!clientId || !allowed) throw new Error('Server is not configured (CLIENT_ID / ALLOWED_EMAIL)');

  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Sign-in expired or invalid');
  var info = JSON.parse(res.getContentText());
  var email = String(info.email || '').toLowerCase();
  var okIssuer = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== clientId || !okIssuer) throw new Error('Token was not issued for this app');
  if (String(info.email_verified) !== 'true') throw new Error('Email not verified');
  if (Number(info.exp) * 1000 < Date.now()) throw new Error('Sign-in expired');
  if (email !== allowed) throw new Error('Access denied for ' + email);

  var user = { email: email };
  var ttl = Math.max(0, Math.min(300, Math.floor(Number(info.exp) - Date.now() / 1000)));
  if (ttl > 0) cache.put(key, JSON.stringify(user), ttl);
  return user;
}

/* ------------------------------------------------------------------ sheet access */

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS[name]);
  if (!sh) throw new Error('Missing tab ' + TABS[name]);
  return sh;
}

function readTable_(name) {
  var sh = sheet_(name);
  var cols = COLS[name];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row[0] === '' || row[0] === null) continue;
    var obj = { _row: i + 2 };
    for (var j = 0; j < cols.length; j++) obj[cols[j]] = cell_(cols[j], row[j]);
    out.push(obj);
  }
  return out;
}

function cell_(field, v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (TEXT_FIELDS[field]) return v === null || v === undefined ? '' : String(v);
  return v;
}

function readConfig_() {
  var values = sheet_('config').getDataRange().getValues();
  var col = function (c) {
    var out = [];
    for (var i = 1; i < values.length; i++) if (values[i][c] !== '' && values[i][c] !== null) out.push(String(values[i][c]));
    return out;
  };
  var aliases = {};
  for (var i = 1; i < values.length; i++) {
    if (values[i][2]) aliases[String(values[i][2]).toLowerCase()] = String(values[i][3]);
  }
  return { categories: col(0), statuses: col(5), payTypes: col(7), revenueCategories: col(9), categoryAliases: aliases };
}

/* ------------------------------------------------------------------ helpers */

function num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function round2_(n) { return Math.round(n * 100) / 100; }

function usd_(n) {
  var parts = round2_(n).toFixed(2).split('.');
  return '$' + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
}

function fyOfDate_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  var y = Number(m[1]), mo = Number(m[2]);
  var start = mo >= 10 ? y : y - 1;
  var two = function (x) { return ('0' + (x % 100)).slice(-2); };
  return two(start) + '-' + two(start + 1);
}

function prevFy_(fy) {
  var m = /^(\d{2})-(\d{2})$/.exec(fy || '');
  if (!m) return '';
  var two = function (x) { return ('0' + ((x + 100) % 100)).slice(-2); };
  return two(Number(m[1]) - 1) + '-' + two(Number(m[2]) - 1);
}

function currentFy_() {
  var tz = Session.getScriptTimeZone();
  return fyOfDate_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
}

function lineTarget_(line) {
  return line.adjusted === '' || line.adjusted === null || line.adjusted === undefined ? num_(line.budget) : num_(line.adjusted);
}

/**
 * Sub-account for an event + FY + category. Same rule as the migration:
 * 1. the line mapped to that category (a label equal to the category wins a tie);
 * 2. the event's only non-"Other" line (single-line events);
 * 3. the event's "Other" (xx99) line.
 */
function findLine_(lines, fy, eventId, cat) {
  var own = lines.filter(function (l) { return l.fy === fy && l.eventId === eventId && l.side === 'Expense'; });
  if (!own.length) return { line: null, why: 'no catalog lines for this event and FY' };
  var exact = own.filter(function (l) { return l.cat === cat; });
  if (exact.length) {
    exact.sort(function (a, b) {
      var ea = String(a.label).toLowerCase() === String(cat).toLowerCase() ? 0 : 1;
      var eb = String(b.label).toLowerCase() === String(cat).toLowerCase() ? 0 : 1;
      return ea - eb || (a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0);
    });
    return { line: exact[0], why: '' };
  }
  var nonOther = own.filter(function (l) { return l.cat !== 'Other'; });
  if (nonOther.length === 1) return { line: nonOther[0], why: 'single-line event' };
  var other = own.filter(function (l) { return l.cat === 'Other'; });
  if (other.length) return { line: other[0], why: 'no ' + cat + ' line; used Other' };
  return { line: null, why: 'no ' + cat + ' line and no Other line' };
}

function revenueCategory_(level) {
  var l = String(level || '').toLowerCase();
  if (/auction/.test(l)) return 'Auctions';
  if (/table|team/.test(l)) return 'Tables';
  if (/ticket|individual|player|comp|registration/.test(l)) return 'Tickets';
  if (/sponsor|partner|title|hole|pin|sign|cart/.test(l)) return 'Sponsorship';
  return 'Other Revenue';
}

function fysFrom_(events) {
  var seen = {};
  events.forEach(function (e) { if (e.fy) seen[e.fy] = 1; });
  return Object.keys(seen).sort().reverse();
}

function emptyEst_() { return { estimated: 0, approved: 0, invoiced: 0, paid: 0, total: 0 }; }

function addEst_(est, status, amount) {
  var b = STATUS_BUCKET[status];
  if (!b) return;
  est[b] = round2_(est[b] + amount);
  est.total = round2_(est.total + amount);
}

/* ------------------------------------------------------------------ reads */

function apiCatalog_(fy) {
  var events = readTable_('events');
  fy = fy || currentFy_();
  var lines = readTable_('catalog').filter(function (l) { return l.fy === fy; });
  return {
    fy: fy,
    fys: fysFrom_(events),
    events: events.filter(function (e) { return e.fy === fy; }).map(stripRow_),
    lines: lines.map(stripRow_),
    config: readConfig_()
  };
}

function apiExpenses_(fy, eventId) {
  return readTable_('expenses').filter(function (x) {
    return (!fy || x.fy === fy) && (!eventId || x.eventId === eventId);
  }).map(stripRow_);
}

function apiHistory_(eventId) {
  if (!eventId) throw new Error('event is required');
  var order = { Budget: 0, Estimate: 1, Actual: 2 };
  return readTable_('history').filter(function (h) { return h.eventId === eventId; })
    .map(stripRow_)
    .sort(function (a, b) { return a.fy < b.fy ? -1 : a.fy > b.fy ? 1 : order[a.type] - order[b.type]; });
}

function apiRevenue_(fy, eventId) {
  return readTable_('revenue').filter(function (r) {
    return (!fy || r.fy === fy) && (!eventId || r.eventId === eventId);
  }).map(function (r) { var o = stripRow_(r); o.category = revenueCategory_(r.level); return o; });
}

function stripRow_(o) {
  var c = {};
  for (var k in o) if (k !== '_row') c[k] = o[k];
  return c;
}

/**
 * Budget vs estimate for one event (or every tracked event when eventId is empty).
 * Budget = official Finance budget; target = adjusted target when one exists, else budget.
 * Estimates exclude Cancelled rows.
 */
function apiSummary_(fy, eventId) {
  fy = fy || currentFy_();
  var events = readTable_('events').filter(function (e) { return e.fy === fy; });
  var lines = readTable_('catalog').filter(function (l) { return l.fy === fy; });
  var expenses = readTable_('expenses').filter(function (x) { return x.fy === fy; });
  var revenue = readTable_('revenue').filter(function (r) { return r.fy === fy; });
  var history = readTable_('history');
  var pfy = prevFy_(fy);

  var wanted = eventId ? events.filter(function (e) { return e.id === eventId; })
    : events.filter(function (e) { return e.track === 'Yes'; });
  if (eventId && !wanted.length) throw new Error('Unknown event ' + eventId + ' for FY ' + fy);

  var out = wanted.map(function (ev) {
    var evLines = lines.filter(function (l) { return l.eventId === ev.id; });
    var evExp = expenses.filter(function (x) { return x.eventId === ev.id; });
    var byKey = {};
    var lineRows = evLines.map(function (l) {
      var row = { side: l.side, acct: l.acct, sub: l.sub, label: l.label, cat: l.cat,
        budget: num_(l.budget), budgetKnown: l.budget !== '' || l.adjusted !== '', adjusted: l.adjusted === '' ? null : num_(l.adjusted),
        target: lineTarget_(l), note: l.note || '', est: emptyEst_(), count: 0 };
      if (l.side === 'Expense') byKey[l.acct + '|' + l.sub] = row;
      return row;
    });
    var unassigned = null;
    evExp.forEach(function (x) {
      if (x.status === 'Cancelled') return;
      var row = byKey[x.acct + '|' + x.sub];
      if (!row) {
        if (!unassigned) unassigned = { side: 'Expense', acct: x.acct || ev.expAcct, sub: '', label: 'Not assigned to a sub-account',
          cat: '', budget: 0, budgetKnown: false, adjusted: null, target: 0, note: '', est: emptyEst_(), count: 0 };
        row = unassigned;
      }
      addEst_(row.est, x.status, num_(x.amount));
      row.count++;
    });
    if (unassigned) lineRows.push(unassigned);
    lineRows.forEach(function (r) { r.remaining = round2_(r.target - r.est.total); });

    var expLines = lineRows.filter(function (r) { return r.side === 'Expense'; });
    var revLines = lineRows.filter(function (r) { return r.side === 'Revenue'; });
    var est = emptyEst_();
    expLines.forEach(function (r) { ['estimated', 'approved', 'invoiced', 'paid', 'total'].forEach(function (k) { est[k] = round2_(est[k] + r.est[k]); }); });
    var sum = function (arr, k) { return round2_(arr.reduce(function (s, r) { return s + (r[k] || 0); }, 0)); };
    var hasAdjusted = expLines.some(function (r) { return r.adjusted !== null; });
    var note = (expLines.filter(function (r) { return r.adjusted !== null && r.note; })[0] || {}).note || '';

    var categories = {};
    expLines.forEach(function (r) {
      var c = r.cat || 'Not assigned';
      var g = categories[c] || (categories[c] = { cat: c, budget: 0, target: 0, estimate: 0, remaining: 0 });
      g.budget = round2_(g.budget + r.budget); g.target = round2_(g.target + r.target);
      g.estimate = round2_(g.estimate + r.est.total); g.remaining = round2_(g.target - g.estimate);
    });

    var evRev = revenue.filter(function (r) { return r.eventId === ev.id; });
    var revCats = {};
    revLines.forEach(function (r) {
      var g = revCats[r.cat] || (revCats[r.cat] = { cat: r.cat, budget: 0, estimate: 0 });
      g.budget = round2_(g.budget + r.budget);
    });
    evRev.forEach(function (r) {
      var c = revenueCategory_(r.level);
      var g = revCats[c] || (revCats[c] = { cat: c, budget: 0, estimate: 0 });
      g.estimate = round2_(g.estimate + num_(r.revenue));
    });

    var prior = history.filter(function (h) { return h.eventId === ev.id && h.fy === pfy && h.type === 'Actual'; })[0];
    var expenseCount = evExp.filter(function (x) { return x.status !== 'Cancelled'; }).length;

    return {
      eventId: ev.id, name: ev.name, track: ev.track, date: ev.date || '', attendees: ev.attendees || '',
      expAcct: ev.expAcct, revAcct: ev.revAcct, notes: ev.notes || '',
      expense: { budget: sum(expLines, 'budget'), target: sum(expLines, 'target'), hasAdjusted: hasAdjusted,
        adjustmentNote: note, est: est, remaining: round2_(sum(expLines, 'target') - est.total) },
      revenue: { budget: sum(revLines, 'budget'), estimate: round2_(evRev.reduce(function (s, r) { return s + num_(r.revenue); }, 0)),
        inkind: round2_(evRev.reduce(function (s, r) { return s + num_(r.inkind); }, 0)) },
      prior: prior ? { fy: pfy, revenue: num_(prior.revenue), expenditures: num_(prior.expenditures) } : { fy: pfy, revenue: null, expenditures: null },
      lines: lineRows,
      categories: Object.keys(categories).map(function (k) { return categories[k]; }),
      revenueCategories: Object.keys(revCats).map(function (k) { return revCats[k]; }),
      expenseCount: expenseCount,
      reviewCount: evExp.filter(function (x) { return x.review === true; }).length
    };
  });
  if (!eventId) out = out.filter(function (s) { return s.expense.budget || s.expense.est.total || s.revenue.budget || s.revenue.estimate; });
  return { fy: fy, events: out };
}

function apiReconcile_(fy) {
  fy = fy || currentFy_();
  var exp = readTable_('expenses');
  var names = {};
  readTable_('events').forEach(function (e) { names[e.id] = e.name; });
  var mine = exp.filter(function (x) { return x.fy === fy; });
  var tag = function (x) { var o = stripRow_(x); o.eventName = names[x.eventId] || x.eventId; return o; };
  var summary = apiSummary_(fy, '');
  var over = [];
  summary.events.forEach(function (s) {
    s.lines.forEach(function (l) {
      if (l.side === 'Expense' && l.budgetKnown && l.est.total > l.target + 0.005) {
        over.push({ eventId: s.eventId, eventName: s.name, acct: l.acct, sub: l.sub, label: l.label, cat: l.cat,
          target: l.target, estimate: l.est.total, over: round2_(l.est.total - l.target), actual: null });
      }
    });
  });
  return {
    fy: fy,
    approvedNoPo: mine.filter(function (x) { return x.status === 'Approved' && x.poDone !== true && !x.po; }).map(tag),
    invoicedNotPaid: mine.filter(function (x) { return x.status === 'Invoiced'; }).map(tag),
    // Needs Review rows with no FY (blank dates) still show up.
    needsReview: exp.filter(function (x) { return x.review === true && (x.fy === fy || !x.fy); }).map(tag),
    overBudget: over
  };
}

/* ------------------------------------------------------------------ writes */

function apiSaveExpense_(op, input) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var config = readConfig_();
    var sh = sheet_('expenses');
    var rows = readTable_('expenses');
    var lines = readTable_('catalog');
    var events = readTable_('events');
    var existing = null;
    if (op !== 'create') {
      existing = rows.filter(function (r) { return r.id === input.id; })[0];
      if (!existing) throw new Error('Expense ' + input.id + ' not found');
    }
    if (op === 'cancel') {
      sh.getRange(existing._row, COLS.expenses.indexOf('status') + 1).setValue('Cancelled');
      existing.status = 'Cancelled';
      return { expense: stripRow_(existing), warnings: [] };
    }
    if (op !== 'create' && op !== 'update') throw new Error('Unknown op ' + op);

    var x = {};
    COLS.expenses.forEach(function (k) { x[k] = existing ? existing[k] : ''; });
    ['eventId', 'date', 'vendor', 'description', 'cat', 'amount', 'status', 'payType', 'po', 'poDone', 'checkDone', 'notes', 'fy', 'acct', 'sub']
      .forEach(function (k) { if (input[k] !== undefined) x[k] = input[k]; });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.date))) throw new Error('Date is required (YYYY-MM-DD)');
    x.fy = input.fy ? String(input.fy) : fyOfDate_(x.date);
    var ev = events.filter(function (e) { return e.id === x.eventId && e.fy === x.fy; })[0];
    if (!ev) throw new Error('Event ' + x.eventId + ' is not set up for FY ' + x.fy);
    if (x.cat && config.categories.indexOf(x.cat) < 0) {
      var alias = config.categoryAliases[String(x.cat).toLowerCase()];
      if (!alias) throw new Error('Unknown category ' + x.cat);
      x.cat = alias;
    }
    if (!x.status) x.status = 'Estimation';
    if (config.statuses.indexOf(x.status) < 0) throw new Error('Unknown status ' + x.status);
    if (x.payType && config.payTypes.indexOf(x.payType) < 0) throw new Error('Unknown payment type ' + x.payType);
    x.amount = x.amount === '' || x.amount === null ? '' : Number(x.amount);
    if (x.amount !== '' && (isNaN(x.amount) || x.amount < 0)) throw new Error('Amount must be a positive number');
    x.poDone = x.poDone === true || x.poDone === 'true';
    x.checkDone = x.checkDone === true || x.checkDone === 'true';

    var reasons = [];
    x.acct = ev.expAcct;
    if (input.sub) {
      var chosen = lines.filter(function (l) { return l.fy === x.fy && l.eventId === x.eventId && l.side === 'Expense' && l.sub === String(input.sub); })[0];
      if (!chosen) throw new Error('Sub-account ' + input.sub + ' is not in the catalog for this event and FY');
      x.acct = chosen.acct; x.sub = chosen.sub;
    } else if (x.cat) {
      var found = findLine_(lines, x.fy, x.eventId, x.cat);
      if (found.line) { x.acct = found.line.acct; x.sub = found.line.sub; }
      else { x.sub = ''; reasons.push(found.why); }
    } else {
      x.sub = '';
    }
    if (!x.cat) reasons.push('no category');
    if (x.amount === '' && x.status !== 'Cancelled') reasons.push('no amount');
    x.review = reasons.length > 0;
    x.notes = String(x.notes || '').replace(/\s*Review: [^]*$/, '');
    if (reasons.length) x.notes = (x.notes ? x.notes + ' ' : '') + 'Review: ' + reasons.join('; ') + '.';

    if (op === 'create') {
      var maxId = 0;
      rows.forEach(function (r) { var m = /^EXP-(\d+)$/.exec(r.id); if (m) maxId = Math.max(maxId, Number(m[1])); });
      x.id = 'EXP-' + ('000' + (maxId + 1)).slice(-4);
    }
    var parts = x.date.split('-');
    var record = COLS.expenses.map(function (k) {
      if (k === 'date') return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (k === 'actual') return existing ? existing.actual : '';
      return x[k] === undefined || x[k] === null ? '' : x[k];
    });
    var rowNum = existing ? existing._row : Math.max(sh.getLastRow(), 1) + 1;
    if (!existing) rowNum = firstEmptyRow_(sh);
    sh.getRange(rowNum, 1, 1, record.length).setValues([record]);

    var warnings = [];
    if (x.sub && x.status !== 'Cancelled') {
      var line = lines.filter(function (l) { return l.fy === x.fy && l.eventId === x.eventId && l.side === 'Expense' && l.sub === x.sub; })[0];
      var committed = 0;
      readTable_('expenses').forEach(function (r) {
        if (r.fy === x.fy && r.eventId === x.eventId && r.sub === x.sub && r.status !== 'Cancelled') committed += num_(r.amount);
      });
      var target = lineTarget_(line);
      var known = line.budget !== '' || line.adjusted !== '';
      if (known && committed > target + 0.005) {
        warnings.push('Sub-account ' + x.sub + ' (' + line.label + ') is now ' + usd_(committed - target) +
          ' over its ' + (line.adjusted !== '' ? 'adjusted target' : 'budget') + ' of ' + usd_(target) + '.');
      }
    }
    x.date = parts.join('-');
    return { expense: x, warnings: warnings };
  } finally {
    lock.releaseLock();
  }
}

// Column A holds the ID; checkbox columns are pre-filled with FALSE, so getLastRow() can't be trusted.
function firstEmptyRow_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return 2;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (ids[i][0] !== '' && ids[i][0] !== null) return i + 3;
  return 2;
}

/**
 * Re-reads Blanca's sheets. For every Events row (all FYs, or one FY) with a Revenue Sheet ID,
 * the whole "$ Revenue" tab is read (B2:E down to the Total row) and that sheet's rows in the
 * Revenue tab are replaced. Rows typed by hand (Source Sheet ID = "manual") are kept.
 */
function apiRefreshRevenue_(fy) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var events = readTable_('events').filter(function (e) { return e.revSheets && (!fy || e.fy === fy); });
    var fresh = [], errors = [], refreshed = {};
    events.forEach(function (e) {
      String(e.revSheets).split(',').map(function (s) { return s.trim(); }).filter(String).forEach(function (id) {
        try {
          var tab = SpreadsheetApp.openById(id).getSheetByName(REVENUE_SHEET_TAB);
          if (!tab) throw new Error('no "' + REVENUE_SHEET_TAB + '" tab');
          var last = tab.getLastRow();
          var vals = last >= 2 ? tab.getRange(2, 2, last - 1, 4).getValues() : [];
          for (var i = 0; i < vals.length; i++) {
            var level = String(vals[i][0] || '').trim();
            if (/^total$/i.test(level)) break;
            if (!level) continue;
            fresh.push([e.fy, e.id, level, num_(vals[i][1]), num_(vals[i][2]), num_(vals[i][3]), id]);
          }
          refreshed[id] = true;
        } catch (err) {
          errors.push(e.name + ' (' + id + '): ' + err.message);
        }
      });
    });
    var sh = sheet_('revenue');
    var keep = readTable_('revenue').filter(function (r) { return !refreshed[r.source]; })
      .map(function (r) { return COLS.revenue.map(function (k) { return r[k]; }); });
    var all = keep.concat(fresh);
    var last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, COLS.revenue.length).clearContent();
    if (all.length) sh.getRange(2, 1, all.length, COLS.revenue.length).setValues(all);
    return { rows: fresh.length, sheets: Object.keys(refreshed).length, kept: keep.length, errors: errors };
  } finally {
    lock.releaseLock();
  }
}
