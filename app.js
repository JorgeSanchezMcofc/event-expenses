/* Event Expense Tracker front end. Static; all data comes from the Apps Script API. */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var COLORS = { revenue: '#F04C57', expenditures: '#185097', profit: '#F2C14E' };
  var BUCKETS = [
    { key: 'estimated', label: 'Estimated / Quoted', cls: 's-estimated', color: '#9db3d6' },
    { key: 'approved', label: 'Approved', cls: 's-approved', color: '#185097' },
    { key: 'invoiced', label: 'Invoiced', cls: 's-invoiced', color: '#F2C14E' },
    { key: 'paid', label: 'Paid', cls: 's-paid', color: '#1f7a4d' }
  ];
  var TOKEN_KEY = 'eet_token';

  var state = {
    token: null,
    fy: null,
    fys: [],
    catalog: {},     // fy -> catalog response
    summary: {},     // fy -> summary response (all tracked events)
    event: sessionGet('eet_event') || '',
    charts: [],
    nav: 0
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var view = $('#view');

  /* ------------------------------------------------------------ utils */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n, cents) {
    if (n === null || n === undefined || n === '') return '—';
    var v = Number(n);
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    return v < 0 ? '($' + s + ')' : '$' + s;
  }
  function moneyCell(n, cents) {
    return '<td class="num' + (Number(n) < 0 ? ' neg' : '') + '">' + money(n, cents) + '</td>';
  }
  function sessionGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sessionSet(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function localGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fyOfDate(iso) {
    var m = /^(\d{4})-(\d{2})/.exec(iso || '');
    if (!m) return '';
    var y = +m[1], start = +m[2] >= 10 ? y : y - 1;
    return String(start % 100).padStart(2, '0') + '-' + String((start + 1) % 100).padStart(2, '0');
  }
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, ms || 3500);
  }
  function destroyCharts() { state.charts.forEach(function (c) { c.destroy(); }); state.charts = []; }
  function loading(msg) { view.innerHTML = '<div class="loading">' + esc(msg || 'Loading…') + '</div>'; }
  function showError(err) {
    if (!state.token) return; // already back on the sign-in screen
    view.innerHTML = '<div class="notice warn"><b>Could not load data.</b><br>' + esc(err.message || err) + '</div>';
  }

  /* ------------------------------------------------------------ auth */

  function tokenExp(tok) {
    try { return JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; }
    catch (e) { return 0; }
  }
  function tokenValid(tok) { return !!tok && (CFG.devToken === tok || tokenExp(tok) > Date.now() + 60000); }

  function initAuth() {
    var saved = sessionGet(TOKEN_KEY);
    if (CFG.devToken) saved = CFG.devToken;
    if (tokenValid(saved)) { state.token = saved; return onSignedIn(); }
    showSignIn();
  }

  function showSignIn(msg) {
    state.token = null; sessionSet(TOKEN_KEY, null);
    $('#tabs').hidden = true; $('#signout').hidden = true;
    view.innerHTML = '<section class="signin"><h1>Sign in</h1><p>Use your McAllen Chamber Google account.</p>' +
      '<div id="gsi-button"></div><p class="muted" id="signin-msg">' + esc(msg || '') + '</p></section>';
    var tries = 0;
    (function waitGsi() {
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({ client_id: CFG.clientId, callback: onCredential, auto_select: true,
          login_hint: CFG.loginHint, itp_support: true });
        google.accounts.id.renderButton($('#gsi-button'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
        google.accounts.id.prompt();
      } else if (tries++ < 50) setTimeout(waitGsi, 100);
      else $('#signin-msg').textContent = 'Google Sign-In did not load. Check your connection and reload.';
    })();
  }

  function onCredential(resp) {
    state.token = resp.credential;
    sessionSet(TOKEN_KEY, state.token);
    onSignedIn();
  }

  function signOut() {
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    state.catalog = {}; state.summary = {};
    showSignIn('Signed out.');
  }

  /* ------------------------------------------------------------ API */

  function api(action, params) {
    if (!tokenValid(state.token)) { showSignIn('Your sign-in expired. Please sign in again.'); return Promise.reject(new Error('Signed out')); }
    var body = Object.assign({}, params || {}, { action: action, token: state.token });
    return fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('Server returned ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.ok) {
          if (/not signed in|expired|invalid|not issued|access denied/i.test(j.error)) showSignIn(j.error);
          throw new Error(j.error);
        }
        return j.data;
      });
  }

  function getCatalog(fy) {
    if (state.catalog[fy]) return Promise.resolve(state.catalog[fy]);
    return api('catalog', { fy: fy }).then(function (c) { state.catalog[fy] = c; return c; });
  }
  function getSummary(fy, force) {
    if (!force && state.summary[fy]) return Promise.resolve(state.summary[fy]);
    return api('summary', { fy: fy }).then(function (s) { state.summary[fy] = s; return s; });
  }
  function invalidate(fy) { delete state.summary[fy]; }

  /* ------------------------------------------------------------ shell */

  function onSignedIn() {
    $('#tabs').hidden = false; $('#signout').hidden = false;
    state.fy = localGet('eet_fy') || CFG.defaultFy || '26-27';
    loading();
    getCatalog(state.fy).then(function (c) {
      state.fys = c.fys.length ? c.fys : [state.fy];
      if (state.fys.indexOf(state.fy) < 0) state.fy = state.fys[0];
      var sel = $('#fy');
      sel.innerHTML = state.fys.map(function (f) { return '<option' + (f === state.fy ? ' selected' : '') + '>' + esc(f) + '</option>'; }).join('');
      route();
    }).catch(showError);
  }

  $('#fy').addEventListener('change', function (e) {
    state.fy = e.target.value; localSet('eet_fy', state.fy); route();
  });
  $('#signout').addEventListener('click', signOut);
  window.addEventListener('hashchange', route);

  function route() {
    if (!state.token) return;
    state.nav++;
    destroyCharts();
    var parts = (location.hash.replace(/^#\/?/, '') || 'lookup').split('/');
    var name = parts[0];
    document.querySelectorAll('#tabs a').forEach(function (a) { a.classList.toggle('active', a.dataset.route === name); });
    var screens = { lookup: renderLookup, add: renderAdd, dashboard: renderDashboard, report: renderReport, missing: renderMissing, history: renderHistory };
    (screens[name] || renderLookup)(parts.slice(1));
    window.scrollTo(0, 0);
  }

  function setEvent(id) { state.event = id; sessionSet('eet_event', id); }

  function eventOptions(cat, opts) {
    opts = opts || {};
    var evs = cat.events.slice().filter(function (e) { return opts.all || e.track === 'Yes' || e.id === state.event; })
      .filter(function (e) { return !opts.withLines || e.expAcct || e.revAcct; });
    evs.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return '<option value="">Choose an event…</option>' + evs.map(function (e) {
      return '<option value="' + esc(e.id) + '"' + (e.id === state.event ? ' selected' : '') + '>' + esc(e.name) + (e.track === 'No' ? ' (program)' : '') + '</option>';
    }).join('');
  }

  function categoriesFor(cat, eventId) {
    var have = {};
    cat.lines.forEach(function (l) { if (l.eventId === eventId && l.side === 'Expense' && l.cat !== 'Other') have[l.cat] = 1; });
    var list = cat.config.categories.filter(function (c) { return have[c]; });
    // "Other" lines always exist as a catch-all; show it last.
    if (cat.lines.some(function (l) { return l.eventId === eventId && l.side === 'Expense' && l.cat === 'Other'; })) list.push('Other');
    return list;
  }

  // Same rule as the API and the migration.
  function findLine(cat, eventId, category) {
    var own = cat.lines.filter(function (l) { return l.eventId === eventId && l.side === 'Expense'; });
    if (!own.length) return { line: null, why: 'This event has no expense lines for FY ' + cat.fy + '.' };
    var exact = own.filter(function (l) { return l.cat === category; });
    if (exact.length) {
      exact.sort(function (a, b) {
        var ea = a.label.toLowerCase() === category.toLowerCase() ? 0 : 1, eb = b.label.toLowerCase() === category.toLowerCase() ? 0 : 1;
        return ea - eb || a.sub.localeCompare(b.sub);
      });
      return { line: exact[0], why: '' };
    }
    var nonOther = own.filter(function (l) { return l.cat !== 'Other'; });
    if (nonOther.length === 1) return { line: nonOther[0], why: 'Single-line event.' };
    var other = own.filter(function (l) { return l.cat === 'Other'; });
    if (other.length) return { line: other[0], why: 'No ' + category + ' line, so it goes to Other.' };
    return { line: null, why: 'No matching sub-account.' };
  }

  function lineStats(summaryEvent, sub) {
    if (!summaryEvent) return null;
    return summaryEvent.lines.filter(function (l) { return l.side === 'Expense' && l.sub === sub; })[0] || null;
  }

  function summaryFor(sum, id) { return (sum.events || []).filter(function (e) { return e.eventId === id; })[0] || null; }

  function eventSummary(fy, id) {
    // The all-events summary skips Track=No events, so fetch those one by one.
    return getSummary(fy).then(function (s) {
      var hit = summaryFor(s, id);
      if (hit) return hit;
      return api('summary', { fy: fy, event: id }).then(function (one) { return one.events[0] || null; });
    });
  }

  /* ------------------------------------------------------------ 1. Lookup */

  function renderLookup() {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    loading();
    getCatalog(state.fy).then(function (cat) { if (nav !== state.nav) return;
      view.innerHTML = '<div class="stack">' +
        '<h1>Account lookup <span class="muted" style="font-weight:400">FY ' + esc(state.fy) + '</span></h1>' +
        '<label class="field"><span>Event</span><select id="lk-event">' + eventOptions(cat, { all: true, withLines: true }) + '</select></label>' +
        '<div id="lk-body"></div></div>';
      $('#lk-event').addEventListener('change', function (e) { setEvent(e.target.value); drawLookup(cat); });
      drawLookup(cat);
    }).catch(showError);
  }

  function drawLookup(cat, pickedCat) {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    var body = $('#lk-body');
    var ev = cat.events.filter(function (e) { return e.id === state.event; })[0];
    if (!ev) { body.innerHTML = '<div class="empty">Pick an event to see its accounts.</div>'; return; }
    body.innerHTML = '<div class="loading">Loading budget…</div>';
    Promise.all([eventSummary(state.fy, ev.id), api('expenses', { fy: state.fy, event: ev.id })]).then(function (res) {
      if (nav !== state.nav) return;
      var s = res[0], rows = res[1];
      var exp = cat.lines.filter(function (l) { return l.eventId === ev.id && l.side === 'Expense'; });
      var cats = categoriesFor(cat, ev.id);
      var x = s ? s.expense : null, r = s ? s.revenue : null;
      var html = '<div class="big-codes">' +
        '<div class="code-box"><div class="k">Expense account</div><div class="v">' + esc(ev.expAcct || '—') + '</div>' +
        (x ? '<div class="total"><span class="k">' + (x.hasAdjusted ? 'Expense budget (adjusted)' : 'Expense budget') + '</span><b>' + money(x.target) + '</b>' +
          (x.hasAdjusted ? '<span class="muted">Finance: ' + money(x.budget) + '</span>' : '') + '</div>' +
          meter(x.est.total, x.target, 'expense', exp.some(function (l) { return l.budget !== '' || l.adjusted !== ''; })) +
          '<div class="muted small">' + BUCKETS.map(function (b) { return esc(b.label) + ' ' + money(x.est[b.key]); }).join(' · ') + '</div>' : '') + '</div>' +
        '<div class="code-box rev"><div class="k">Revenue account</div><div class="v">' + esc(ev.revAcct || '—') + '</div>' +
        (r ? '<div class="total"><span class="k">Revenue budget</span><b>' + money(r.budget) + '</b></div>' +
          meter(r.estimate, r.budget, 'revenue', r.budget > 0) +
          '<div class="muted small">From the event\'s revenue sheet' + (r.inkind ? ' · in-kind ' + money(r.inkind) : '') + '</div>' : '') + '</div></div>';
      if (ev.notes) html += '<p class="muted">' + esc(ev.notes) + '</p>';
      if (x && x.hasAdjusted && x.adjustmentNote) html += '<div class="notice">' + esc(x.adjustmentNote) + '</div>';
      if (cats.length) {
        html += '<div><h2>Pick a category</h2><div class="pills" id="lk-cats">' + cats.map(function (c) {
          return '<button class="pill' + (c === pickedCat ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
        }).join('') + '</div></div><div id="lk-answer"></div>';
      }
      if (exp.length) {
        html += '<h2>All sub-accounts</h2><div class="table-wrap"><table class="lines"><thead><tr><th>Sub-account</th><th>Category</th><th class="hide-sm">Finance label</th>' +
          '<th class="num">Budget</th><th class="meter-col">Spent vs budget</th></tr></thead><tbody>' +
          exp.map(function (l) {
            var st = lineStats(s, l.sub);
            var target = st ? st.target : Number(l.adjusted !== '' ? l.adjusted : l.budget || 0);
            var spent = st ? st.est.total : 0;
            var known = l.budget !== '' || l.adjusted !== '';
            return '<tr class="click" data-sub="' + esc(l.sub) + '"><td><b>' + esc(l.sub) + '</b></td><td>' + esc(l.cat) + '</td><td class="hide-sm">' + esc(l.label) + '</td>' +
              '<td class="num">' + (known ? money(target) : '<span class="muted">not set</span>') +
              (l.adjusted !== '' && l.adjusted !== null ? '<div><span class="badge adj">adjusted</span></div>' : '') + '</td>' +
              '<td class="meter-col">' + meter(spent, target, 'expense', known, true) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      } else {
        html += '<div class="empty">No expense sub-accounts for this event in FY ' + esc(state.fy) + '.</div>';
      }
      html += '<div class="row" style="align-items:center;margin-top:1.5rem"><h2 style="flex:1 1 auto;margin:0">Expenses <span class="muted" id="lk-count"></span></h2>' +
        '<div class="btn-row" style="flex:0 0 auto"><a class="btn secondary" href="#/add/' + encodeURIComponent(ev.id) + '">Add expense</a></div></div>' +
        '<div class="row"><label class="field"><span>Find (vendor, description, amount, ID)</span><input id="lk-q" type="search" placeholder="e.g. photographer or 500"></label>' +
        '<label class="field" style="flex:0 1 220px"><span>Sub-account</span><select id="lk-sub"><option value="">All</option>' +
        exp.map(function (l) { return '<option value="' + esc(l.sub) + '">' + esc(l.sub + ' · ' + l.cat) + '</option>'; }).join('') + '</select></label></div>' +
        '<div id="lk-exp"></div>';
      body.innerHTML = html;
      var drawExp = function () {
        var q = $('#lk-q').value.trim().toLowerCase(), sub = $('#lk-sub').value;
        var list = rows.filter(function (e) {
          if (sub && e.sub !== sub) return false;
          if (!q) return true;
          return [e.id, e.vendor, e.description, e.cat, e.notes, e.amount, money(e.amount, true)].join(' ').toLowerCase().indexOf(q) >= 0;
        }).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
        $('#lk-count').textContent = '(' + list.length + ')';
        $('#lk-exp').innerHTML = expenseTable(list);
        bindEdit();
      };
      $('#lk-q').addEventListener('input', drawExp);
      $('#lk-sub').addEventListener('change', drawExp);
      body.querySelectorAll('tr[data-sub]').forEach(function (tr) {
        tr.addEventListener('click', function () {
          $('#lk-sub').value = tr.dataset.sub; drawExp();
          $('#lk-q').scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
      drawExp();
      body.querySelectorAll('[data-cat]').forEach(function (b) {
        b.addEventListener('click', function () {
          body.querySelectorAll('[data-cat]').forEach(function (y) { y.classList.toggle('active', y === b); });
          showAnswer(cat, ev, s, b.dataset.cat);
        });
      });
      if (pickedCat) showAnswer(cat, ev, s, pickedCat);
    }).catch(function (e) { body.innerHTML = '<div class="notice warn">' + esc(e.message) + '</div>'; });
  }

  /**
   * Fill bar against a budget line. Expenses: green while at or under budget, red once over.
   * Revenue: green once the goal is met, gold while short of it.
   */
  function meter(value, target, kind, known, compact) {
    value = Number(value || 0); target = Number(target || 0);
    if (!known) return '<div class="meter-cap muted">' + (value ? money(value, true) + ' · no budget set' : 'No budget set') + '</div>';
    var over = value > target + 0.005;
    var scale = Math.max(target, value) * 1.1 || 1;
    var fill = Math.min(100, value / scale * 100), mark = target / scale * 100;
    var pct = target > 0 ? Math.round(value / target * 100) : (value > 0 ? 999 : 0);
    var cls = kind === 'revenue' ? (value >= target && target > 0 ? 'good' : 'short') : (over ? 'bad' : 'good');
    var cap;
    if (kind === 'revenue') cap = money(value) + ' of ' + money(target) + ' · ' + pct + '%' + (value < target ? ' · ' + money(target - value) + ' to go' : ' · goal met');
    else cap = money(value) + ' of ' + money(target) + ' · ' + (over ? '<b class="neg">' + money(value - target) + ' over</b>' : money(target - value) + ' left');
    return '<div class="meter ' + cls + (compact ? ' compact' : '') + '" role="img" aria-label="' + esc(cap.replace(/<[^>]+>/g, '')) + '">' +
      '<span class="fill" style="width:' + fill.toFixed(2) + '%"></span><i class="mark" style="left:' + mark.toFixed(2) + '%" title="Budget ' + esc(money(target)) + '"></i></div>' +
      '<div class="meter-cap">' + cap + '</div>';
  }

  function showAnswer(cat, ev, s, category) {
    var found = findLine(cat, ev.id, category);
    var box = $('#lk-answer');
    document.querySelectorAll('#lk-body tr[data-sub]').forEach(function (tr) { tr.classList.toggle('hl', !!found.line && tr.dataset.sub === found.line.sub); });
    if (!found.line) { box.innerHTML = '<div class="notice warn">' + esc(found.why) + '</div>'; return; }
    var l = found.line, st = lineStats(s, l.sub);
    var known = l.budget !== '' || l.adjusted !== '';
    var target = st ? st.target : Number(l.adjusted !== '' ? l.adjusted : l.budget || 0);
    box.innerHTML = '<div class="answer"><div class="muted">' + esc(ev.name) + ' · ' + esc(category) + '</div>' +
      '<div class="v">' + esc(l.acct) + ' · ' + esc(l.sub) + '</div>' +
      '<div class="meta"><div><span class="muted">Finance label</span><b>' + esc(l.label) + '</b></div>' +
      '<div><span class="muted">' + (l.adjusted !== '' ? 'Adjusted target' : 'Budget') + '</span><b>' + (known ? money(target) : 'not set') + '</b></div>' +
      (l.adjusted !== '' ? '<div><span class="muted">Official budget</span><b>' + money(l.budget) + '</b></div>' : '') +
      '<div><span class="muted">Remaining</span><b class="' + (st && st.remaining < 0 ? 'neg' : '') + '">' + (known && st ? money(st.remaining) : '—') + '</b></div></div>' +
      '<div style="margin-top:.6rem">' + meter(st ? st.est.total : 0, target, 'expense', known) + '</div>' +
      (found.why ? '<p class="muted" style="margin:.5rem 0 0">' + esc(found.why) + '</p>' : '') +
      '<div class="btn-row" style="margin-top:.75rem"><a class="btn" href="#/add/' + encodeURIComponent(ev.id) + '/' + encodeURIComponent(category) + '">Add expense here</a></div></div>';
  }

  /* ------------------------------------------------------------ 2. Add / edit expense */

  function renderAdd(args) {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    var presetEvent = args[0] ? decodeURIComponent(args[0]) : '';
    var presetCat = args[1] ? decodeURIComponent(args[1]) : '';
    var editId = presetEvent === 'edit' ? presetCat : '';
    if (presetEvent && !editId) setEvent(presetEvent);
    loading();
    var editing = editId ? api('expenses', { fy: state.fy }).then(function (rows) {
      return rows.filter(function (r) { return r.id === editId; })[0] || null;
    }) : Promise.resolve(null);
    Promise.all([getCatalog(state.fy), editing]).then(function (res) { if (nav !== state.nav) return;
      var cat = res[0], x = res[1];
      if (x) setEvent(x.eventId);
      var cfg = cat.config;
      var opt = function (list, v, blank) {
        return (blank ? '<option value="">' + esc(blank) + '</option>' : '') + list.map(function (o) {
          return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>';
        }).join('');
      };
      view.innerHTML = '<form id="xf" class="stack" novalidate>' +
        '<h1>' + (x ? 'Edit ' + esc(x.id) : 'Add expense') + ' <span class="muted" style="font-weight:400">estimate</span></h1>' +
        '<div class="row"><label class="field"><span>Event</span><select name="eventId" required>' + eventOptions(cat, { all: true, withLines: true }) + '</select></label>' +
        '<label class="field"><span>Date</span><input type="date" name="date" required value="' + esc(x ? x.date : today()) + '"></label></div>' +
        '<div class="row"><label class="field"><span>Category</span><select name="cat"></select></label>' +
        '<label class="field"><span>Amount (estimate)</span><input type="number" name="amount" inputmode="decimal" step="0.01" min="0" value="' + esc(x ? x.amount : '') + '"></label></div>' +
        '<div class="card" id="xf-acct"></div>' +
        '<div class="row"><label class="field"><span>Vendor</span><input name="vendor" autocomplete="off" value="' + esc(x ? x.vendor : '') + '"></label>' +
        '<label class="field"><span>Description</span><input name="description" value="' + esc(x ? x.description : '') + '"></label></div>' +
        '<div class="row"><label class="field"><span>Status</span><select name="status">' + opt(cfg.statuses, x ? x.status : 'Estimation') + '</select></label>' +
        '<label class="field"><span>Payment type</span><select name="payType">' + opt(cfg.payTypes, x ? x.payType : '', '—') + '</select></label>' +
        '<label class="field"><span>PO #</span><input name="po" value="' + esc(x ? x.po : '') + '"></label></div>' +
        '<div class="row"><label class="check"><input type="checkbox" name="poDone"' + (x && x.poDone === true ? ' checked' : '') + '> PO processed</label>' +
        '<label class="check"><input type="checkbox" name="checkDone"' + (x && x.checkDone === true ? ' checked' : '') + '> Check processed</label></div>' +
        '<label class="field"><span>Notes</span><textarea name="notes">' + esc(x ? String(x.notes || '').replace(/\s*Review: [\s\S]*$/, '') : '') + '</textarea></label>' +
        '<div id="xf-warn"></div>' +
        '<div class="btn-row"><button class="btn" type="submit">' + (x ? 'Save changes' : 'Save expense') + '</button>' +
        (x && x.status !== 'Cancelled' ? '<button class="btn danger" type="button" id="xf-cancel">Cancel this expense</button>' : '') +
        '<a class="btn secondary" href="#/dashboard">Done</a></div><div id="xf-result"></div></form>';

      var f = $('#xf');
      var subOverride = x ? x.sub : '';
      var summaryEv = null;
      var fillCats = function (keep) {
        var cats = f.eventId.value ? categoriesFor(cat, f.eventId.value) : [];
        var cur = keep || f.cat.value;
        f.cat.innerHTML = '<option value="">Choose…</option>' + cats.map(function (c) { return '<option' + (c === cur ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
      };
      var refreshAcct = function () {
        var box = $('#xf-acct'), warn = $('#xf-warn');
        var evId = f.eventId.value, category = f.cat.value;
        var dateFy = fyOfDate(f.date.value);
        if (!evId) { box.innerHTML = '<span class="muted">Pick an event to see its accounts.</span>'; warn.innerHTML = ''; return; }
        if (dateFy && dateFy !== state.fy) {
          box.innerHTML = '<div class="notice warn">This date falls in FY ' + esc(dateFy) + '. Switch the FY selector to ' + esc(dateFy) + ' to see that year\'s accounts. It will be saved to FY ' + esc(dateFy) + '.</div>';
          warn.innerHTML = ''; return;
        }
        var ev = cat.events.filter(function (e) { return e.id === evId; })[0];
        var lines = cat.lines.filter(function (l) { return l.eventId === evId && l.side === 'Expense'; });
        var found = category ? findLine(cat, evId, category) : { line: null, why: '' };
        var chosenSub = subOverride || (found.line ? found.line.sub : '');
        box.innerHTML = '<div class="row" style="align-items:center"><div><div class="muted">Expense account</div><div style="font-size:1.6rem;font-weight:700;color:#185097">' + esc(ev.expAcct || '—') + '</div></div>' +
          '<label class="field"><span>Sub-account</span><select id="xf-sub"><option value="">' + (category ? 'Auto' : 'Pick a category first') + '</option>' +
          lines.map(function (l) { return '<option value="' + esc(l.sub) + '"' + (l.sub === chosenSub ? ' selected' : '') + '>' + esc(l.sub + ' · ' + l.label + ' (' + l.cat + ')') + '</option>'; }).join('') +
          '</select></label></div>' + (found.why && !subOverride ? '<p class="muted" style="margin:.4rem 0 0">' + esc(found.why) + '</p>' : '');
        $('#xf-sub').addEventListener('change', function (e) { subOverride = e.target.value; refreshAcct(); });
        // Over-budget preview
        warn.innerHTML = '';
        var amt = Number(f.amount.value || 0);
        if (!chosenSub || !summaryEv || f.status.value === 'Cancelled') return;
        var st = lineStats(summaryEv, chosenSub);
        var line = lines.filter(function (l) { return l.sub === chosenSub; })[0];
        if (!st || !line || (line.budget === '' && line.adjusted === '')) return;
        var already = st.est.total - (x && x.sub === chosenSub && x.status !== 'Cancelled' ? Number(x.amount || 0) : 0);
        var after = already + amt;
        var label = line.adjusted !== '' ? 'adjusted target' : 'budget';
        warn.innerHTML = after > st.target + 0.005
          ? '<div class="notice warn"><b>Over ' + label + '.</b> ' + esc(line.sub) + ' would be at ' + money(after, true) + ' against its ' + label + ' of ' + money(st.target) + ' (' + money(after - st.target, true) + ' over).</div>'
          : '<div class="notice ok">' + esc(line.sub) + ' stays within its ' + label + ': ' + money(after, true) + ' of ' + money(st.target) + ' (' + money(st.target - after, true) + ' left).</div>';
      };
      var loadSummary = function () {
        summaryEv = null;
        if (!f.eventId.value) return refreshAcct();
        eventSummary(state.fy, f.eventId.value).then(function (s) { if (nav !== state.nav) return; summaryEv = s; refreshAcct(); }).catch(function () { refreshAcct(); });
      };
      f.eventId.addEventListener('change', function () { setEvent(f.eventId.value); subOverride = ''; fillCats(); loadSummary(); });
      f.cat.addEventListener('change', function () { subOverride = ''; refreshAcct(); });
      ['amount', 'status', 'date'].forEach(function (n) { f[n].addEventListener('input', refreshAcct); f[n].addEventListener('change', refreshAcct); });
      fillCats(x ? x.cat : presetCat);
      loadSummary();

      var cancelBtn = $('#xf-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', function () {
        if (!confirm('Mark ' + x.id + ' as Cancelled? It stays in the Sheet but no longer counts.')) return;
        api('expense', { op: 'cancel', expense: { id: x.id } }).then(function () {
          invalidate(state.fy); toast(x.id + ' cancelled'); location.hash = '#/dashboard';
        }).catch(function (e) { toast(e.message, 6000); });
      });

      f.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!f.eventId.value) return toast('Pick an event');
        if (!f.date.value) return toast('Pick a date');
        var payload = {
          eventId: f.eventId.value, date: f.date.value, vendor: f.vendor.value.trim(), description: f.description.value.trim(),
          cat: f.cat.value, amount: f.amount.value === '' ? '' : Number(f.amount.value), status: f.status.value,
          payType: f.payType.value, po: f.po.value.trim(), poDone: f.poDone.checked, checkDone: f.checkDone.checked, notes: f.notes.value.trim()
        };
        if (subOverride) payload.sub = subOverride;
        if (x) payload.id = x.id;
        var btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
        api('expense', { op: x ? 'update' : 'create', expense: payload }).then(function (res) {
          var saved = res.expense;
          invalidate(saved.fy);
          var msg = '<div class="notice ok"><b>Saved ' + esc(saved.id) + '</b> · ' + esc(saved.acct) + ' · ' + esc(saved.sub || 'no sub-account') +
            ' · ' + money(saved.amount, true) + ' · FY ' + esc(saved.fy) + (saved.review ? ' <span class="badge warn">needs review</span>' : '') + '</div>';
          res.warnings.forEach(function (w) { msg += '<div class="notice warn" style="margin-top:.5rem">' + esc(w) + '</div>'; });
          toast('Saved ' + saved.id);
          if (x) { $('#xf-result').innerHTML = msg; btn.disabled = false; btn.textContent = 'Save changes'; x = saved; return; }
          // Clear the form for the next entry but keep event, date and category.
          ['amount', 'vendor', 'description', 'po', 'notes'].forEach(function (n) { f[n].value = ''; });
          f.poDone.checked = false; f.checkDone.checked = false;
          btn.disabled = false; btn.textContent = 'Save expense';
          $('#xf-result').innerHTML = msg;
          loadSummary();
        }).catch(function (err) {
          btn.disabled = false; btn.textContent = x ? 'Save changes' : 'Save expense';
          $('#xf-result').innerHTML = '<div class="notice warn">' + esc(err.message) + '</div>';
        });
      });
    }).catch(showError);
  }

  /* ------------------------------------------------------------ 3. Dashboard */

  function renderDashboard(args) {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    loading();
    var drill = args[0] ? decodeURIComponent(args[0]) : '';
    var sub = args[1] ? decodeURIComponent(args[1]) : '';
    getSummary(state.fy).then(function (s) { if (nav !== state.nav) return;
      if (drill) return drawDrill(s, drill, sub);
      var evs = s.events.slice().sort(function (a, b) { return b.expense.target - a.expense.target || a.name.localeCompare(b.name); });
      var tot = { budget: 0, target: 0, est: { estimated: 0, approved: 0, invoiced: 0, paid: 0, total: 0 } };
      evs.forEach(function (e) {
        tot.budget += e.expense.budget; tot.target += e.expense.target;
        Object.keys(tot.est).forEach(function (k) { tot.est[k] += e.expense.est[k]; });
      });
      var html = '<div class="stack"><div class="row" style="align-items:center"><h1 style="flex:1 1 auto">Live dashboard · FY ' + esc(state.fy) + '</h1>' +
        '<div class="btn-row" style="flex:0 0 auto"><button class="btn secondary" id="db-refresh">Refresh</button><button class="btn secondary" id="db-rev">Refresh revenue</button></div></div>' +
        '<div class="kpis">' +
        kpi('Budget (Finance)', money(tot.budget)) + kpi('Target (with adjustments)', money(tot.target)) +
        kpi('Estimate (all statuses)', money(tot.est.total)) + kpi('Remaining', money(tot.target - tot.est.total)) + '</div>' +
        '<div class="kpis">' + BUCKETS.map(function (b) { return kpi(b.label, money(tot.est[b.key])); }).join('') + '</div>';
      if (!evs.length) html += '<div class="empty">No tracked events with a budget or expenses in FY ' + esc(state.fy) + '.</div>';
      html += '<div class="event-cards">' + evs.map(function (e) {
        var x = e.expense;
        return '<button class="event-card" data-ev="' + esc(e.eventId) + '"><h3><span>' + esc(e.name) + '</span>' +
          (x.hasAdjusted ? '<span class="badge adj">adjusted</span>' : '') + '</h3>' +
          '<div class="meter-label"><span>Expenses · ' + esc(e.expAcct) + '</span>' + (x.hasAdjusted ? '<span class="muted">Finance ' + money(x.budget) + '</span>' : '') + '</div>' +
          meter(x.est.total, x.target, 'expense', e.lines.some(function (l) { return l.side === 'Expense' && l.budgetKnown; })) +
          '<div class="muted small">' + BUCKETS.filter(function (b) { return x.est[b.key]; }).map(function (b) { return esc(b.label) + ' ' + money(x.est[b.key]); }).join(' · ') + '</div>' +
          (e.revenue.budget || e.revenue.estimate ? '<div class="meter-label" style="margin-top:.6rem"><span>Revenue · ' + esc(e.revAcct) + '</span></div>' +
            meter(e.revenue.estimate, e.revenue.budget, 'revenue', e.revenue.budget > 0, true) : '') +
          (e.reviewCount ? '<div style="margin-top:.4rem"><span class="badge warn">' + e.reviewCount + ' need review</span></div>' : '') + '</button>';
      }).join('') + '</div></div>';
      view.innerHTML = html;
      view.querySelectorAll('[data-ev]').forEach(function (b) {
        b.addEventListener('click', function () { setEvent(b.dataset.ev); location.hash = '#/dashboard/' + encodeURIComponent(b.dataset.ev); });
      });
      $('#db-refresh').addEventListener('click', function () { invalidate(state.fy); route(); });
      $('#db-rev').addEventListener('click', refreshRevenue);
    }).catch(showError);
  }
  function kpi(k, v) { return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>'; }

  function refreshRevenue() {
    toast('Reading revenue sheets…', 10000);
    api('refreshRevenue', {}).then(function (r) {
      state.summary = {};
      toast('Revenue refreshed: ' + r.rows + ' rows from ' + r.sheets + ' sheets' + (r.errors.length ? ' · ' + r.errors.length + ' error(s)' : ''), 6000);
      if (r.errors.length) console.warn(r.errors);
      route();
    }).catch(function (e) { toast(e.message, 6000); });
  }

  function drawDrill(s, eventId, sub) {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    var e = summaryFor(s, eventId);
    if (!e) {
      return api('summary', { fy: state.fy, event: eventId }).then(function (one) {
        if (!one.events[0]) throw new Error('No data for ' + eventId);
        s = { events: s.events.concat(one.events) }; return drawDrill(s, eventId, sub);
      });
    }
    return api('expenses', { fy: state.fy, event: eventId }).then(function (rows) { if (nav !== state.nav) return;
      var x = e.expense;
      var html = '<div class="stack"><div class="crumbs"><button data-go="#/dashboard">Dashboard</button> › <button data-go="#/dashboard/' + esc(eventId) + '">' + esc(e.name) + '</button>' +
        (sub ? ' › <span>' + esc(sub) + '</span>' : '') + '</div>' +
        '<h1>' + esc(e.name) + '</h1>' +
        '<div class="kpis">' + kpi('Expense account', esc(e.expAcct || '—')) + kpi('Budget', money(x.budget)) +
        (x.hasAdjusted ? kpi('Adjusted target', money(x.target)) : '') + kpi('Estimate', money(x.est.total)) + kpi('Remaining', money(x.remaining)) + '</div>' +
        '<div class="card">' + meter(x.est.total, x.target, 'expense', e.lines.some(function (l) { return l.side === 'Expense' && l.budgetKnown; })) + '</div>' +
        (x.hasAdjusted && x.adjustmentNote ? '<div class="notice">' + esc(x.adjustmentNote) + '</div>' : '');
      if (!sub) {
        var lines = e.lines.filter(function (l) { return l.side === 'Expense'; });
        html += '<div class="table-wrap"><table><thead><tr><th>Sub-account</th><th>Category</th><th class="num">Budget</th><th class="num">Target</th>' +
          BUCKETS.map(function (b) { return '<th class="num">' + esc(b.label) + '</th>'; }).join('') + '<th class="num">Remaining</th><th class="meter-col">Spent vs budget</th></tr></thead><tbody>' +
          lines.map(function (l) {
            return '<tr class="click" data-sub="' + esc(l.sub || '-') + '"><td><b>' + esc(l.sub || '—') + '</b><div class="muted">' + esc(l.label) + '</div></td><td>' + esc(l.cat) + '</td>' +
              (l.budgetKnown ? moneyCell(l.budget) + moneyCell(l.target) : '<td class="num muted">not set</td><td class="num muted">—</td>') +
              BUCKETS.map(function (b) { return moneyCell(l.est[b.key]); }).join('') + (l.budgetKnown ? moneyCell(l.remaining) : '<td class="num muted">—</td>') +
              '<td class="meter-col">' + meter(l.est.total, l.target, 'expense', l.budgetKnown, true) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
      var list = rows.filter(function (r) { return !sub || (sub === '-' ? !r.sub : r.sub === sub); });
      html += '<h2>' + (sub ? 'Expenses on ' + esc(sub === '-' ? 'no sub-account' : sub) : 'All expenses') + ' (' + list.length + ')</h2>' + expenseTable(list) +
        '<div class="btn-row"><a class="btn" href="#/add/' + encodeURIComponent(eventId) + '">Add expense</a><a class="btn secondary" href="#/report/' + encodeURIComponent(eventId) + '">Event report</a></div></div>';
      view.innerHTML = html;
      view.querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', function () { location.hash = b.dataset.go; }); });
      view.querySelectorAll('tr[data-sub]').forEach(function (tr) {
        tr.addEventListener('click', function () { location.hash = '#/dashboard/' + encodeURIComponent(eventId) + '/' + encodeURIComponent(tr.dataset.sub); });
      });
      bindEdit();
    });
  }

  function expenseTable(list, extraCols) {
    if (!list.length) return '<div class="empty">Nothing here.</div>';
    extraCols = extraCols || [];
    return '<div class="table-wrap"><table><thead><tr><th>ID</th><th>Date</th>' + (extraCols.indexOf('event') >= 0 ? '<th>Event</th>' : '') +
      '<th>Vendor / description</th><th>Category</th><th>Sub</th><th class="num">Estimate</th><th>Status</th><th>PO</th>' +
      (extraCols.indexOf('actual') >= 0 ? '<th class="num">Actual (phase 2)</th>' : '') + '<th></th></tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><td>' + esc(r.id) + (r.review === true ? ' <span class="badge warn">review</span>' : '') + '</td><td class="num">' + esc(r.date) + '</td>' +
          (extraCols.indexOf('event') >= 0 ? '<td>' + esc(r.eventName || r.eventId) + '</td>' : '') +
          '<td><b>' + esc(r.vendor || '—') + '</b><div class="muted">' + esc(r.description) + '</div>' + (r.review === true && r.notes ? '<div class="muted" style="font-size:.82rem">' + esc(r.notes) + '</div>' : '') + '</td>' +
          '<td>' + esc(r.cat || '—') + '</td><td>' + esc(r.sub || '—') + '</td>' + moneyCell(r.amount, true) + '<td>' + esc(r.status || '—') + '</td>' +
          '<td>' + (r.po ? esc(r.po) : (r.poDone === true ? '✓' : '—')) + '</td>' +
          (extraCols.indexOf('actual') >= 0 ? '<td class="num muted">—</td>' : '') +
          '<td><button class="link" data-edit="' + esc(r.id) + '" data-fy="' + esc(r.fy) + '">Edit</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function bindEdit() {
    view.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (b.dataset.fy && b.dataset.fy !== state.fy) { state.fy = b.dataset.fy; $('#fy').value = state.fy; }
        location.hash = '#/add/edit/' + encodeURIComponent(b.dataset.edit);
      });
    });
  }

  /* ------------------------------------------------------------ 4. Event report */

  function renderReport(args) {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    if (args[0]) setEvent(decodeURIComponent(args[0]));
    loading();
    getCatalog(state.fy).then(function (cat) { if (nav !== state.nav) return;
      view.innerHTML = '<div class="stack"><div class="row no-print"><label class="field"><span>Event</span><select id="rp-event">' + eventOptions(cat, { withLines: true }) + '</select></label>' +
        '<div class="btn-row" style="flex:0 0 auto"><button class="btn" id="rp-pdf" disabled>Download PDF</button><button class="btn secondary" id="rp-csv" disabled>Download CSV</button></div></div>' +
        '<div id="rp-body"></div></div>';
      $('#rp-event').addEventListener('change', function (e) { setEvent(e.target.value); drawReport(); });
      drawReport();
    }).catch(showError);
  }

  function drawReport() {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    destroyCharts();
    var body = $('#rp-body');
    if (!state.event) { body.innerHTML = '<div class="empty">Pick an event.</div>'; return; }
    body.innerHTML = '<div class="loading">Building report…</div>';
    eventSummary(state.fy, state.event).then(function (e) { if (nav !== state.nav) return;
      if (!e) { body.innerHTML = '<div class="empty">No data for this event in FY ' + esc(state.fy) + '.</div>'; return; }
      var x = e.expense, r = e.revenue;
      var rows = [
        { label: 'FY ' + e.prior.fy + ' ACTUAL', rev: e.prior.revenue, exp: e.prior.expenditures },
        { label: 'BUDGET FY ' + state.fy, rev: r.budget, exp: x.target },
        { label: 'ESTIMATE FY ' + state.fy, rev: r.estimate, exp: x.est.total }
      ];
      rows.forEach(function (o) { o.profit = o.rev === null || o.exp === null ? null : o.rev - o.exp; });
      var revRows = e.revenueCategories.slice().sort(function (a, b) { return b.budget - a.budget || b.estimate - a.estimate; });
      var expRows = e.categories.slice().sort(function (a, b) { return b.budget - a.budget || b.estimate - a.estimate; });
      var sum = function (arr, k) { return arr.reduce(function (s, o) { return s + (o[k] || 0); }, 0); };
      var adj = x.hasAdjusted;
      var head = '<div class="report-head"><div><div class="report-title">' + esc(e.name) + '</div>' +
        (e.attendees ? '<div class="report-sub">Attendees: ' + esc(e.attendees) + '</div>' : '') +
        (e.date ? '<div class="report-sub" style="font-size:1rem">' + esc(e.date) + '</div>' : '') + '</div>' +
        '<div class="muted" style="text-align:right">FY ' + esc(state.fy) + '<br>Expense ' + esc(e.expAcct || '—') + ' · Revenue ' + esc(e.revAcct || '—') + '</div></div>';
      var summary = '<div><div class="table-wrap"><table class="summary-table"><thead><tr><th></th><th class="num">Revenue</th><th class="num">Expenditures</th><th class="num">Profit</th></tr></thead><tbody>' +
        rows.map(function (o) { return '<tr><td>' + esc(o.label) + '</td>' + moneyCell(o.rev) + moneyCell(o.exp) + moneyCell(o.profit) + '</tr>'; }).join('') + '</tbody></table></div>' +
        (adj ? '<p class="muted" style="font-size:.85rem;margin:.5rem 0 0">Budget expenditures use the adjusted target (' + money(x.target) + '); Finance\'s official budget is ' + money(x.budget) + '.</p>' : '') + '</div>';
      var revTable = '<div class="rt revenue"><div class="cap">REVENUE</div><div class="table-wrap" style="border-radius:0 var(--radius) var(--radius) var(--radius)"><table><thead><tr><th>Description</th><th class="num">Budget</th><th class="num">Estimate</th><th class="num">Difference</th></tr></thead><tbody>' +
        (revRows.length ? revRows.map(function (o) { return '<tr><td>' + esc(o.cat.toUpperCase()) + '</td>' + moneyCell(o.budget, true) + moneyCell(o.estimate, true) + moneyCell(o.estimate - o.budget, true) + '</tr>'; }).join('')
          : '<tr><td colspan="4" class="muted">No revenue lines</td></tr>') +
        '</tbody><tfoot><tr><td>TOTAL</td>' + moneyCell(sum(revRows, 'budget'), true) + moneyCell(sum(revRows, 'estimate'), true) + moneyCell(sum(revRows, 'estimate') - sum(revRows, 'budget'), true) + '</tr></tfoot></table></div></div>';
      var expTable = '<div class="rt expense"><div class="cap">EXPENDITURES</div><div class="table-wrap" style="border-radius:0 var(--radius) var(--radius) var(--radius)"><table><thead><tr><th>Description</th><th class="num">Budget</th>' +
        (adj ? '<th class="num">Adjusted target</th>' : '') + '<th class="num">Estimate</th><th class="num">Difference</th></tr></thead><tbody>' +
        (expRows.length ? expRows.map(function (o) {
          return '<tr><td>' + esc(o.cat.toUpperCase()) + '</td>' + moneyCell(o.budget, true) + (adj ? moneyCell(o.target, true) : '') + moneyCell(o.estimate, true) +
            moneyCell(o.estimate - (adj ? o.target : o.budget), true) + '</tr>';
        }).join('') : '<tr><td colspan="' + (adj ? 5 : 4) + '" class="muted">No expense lines</td></tr>') +
        '</tbody><tfoot><tr><td>TOTAL</td>' + moneyCell(sum(expRows, 'budget'), true) + (adj ? moneyCell(sum(expRows, 'target'), true) : '') + moneyCell(sum(expRows, 'estimate'), true) +
        moneyCell(sum(expRows, 'estimate') - sum(expRows, adj ? 'target' : 'budget'), true) + '</tr></tfoot></table></div>' +
        (adj && x.adjustmentNote ? '<div class="adj-note notice"><b>Adjusted target:</b> ' + esc(x.adjustmentNote) + '</div>' : '') + '</div>';
      body.innerHTML = '<div class="report" id="report">' + head + '<div class="report-grid">' + summary + '<div class="chart-box"><canvas id="rp-chart" aria-label="Revenue, expenditures and profit"></canvas></div></div>' +
        revTable + expTable + '<p class="muted" style="font-size:.8rem;margin-top:1rem">Estimates exclude cancelled items. Revenue estimate comes from the event\'s revenue sheet. Generated ' + esc(new Date().toLocaleString()) + '.</p></div>';
      drawGroupedChart($('#rp-chart'), rows.map(function (o) { return o.label; }), rows);
      var pdf = $('#rp-pdf'), csv = $('#rp-csv');
      pdf.disabled = false; csv.disabled = false;
      pdf.onclick = function () { downloadPdf(e); };
      csv.onclick = function () { downloadCsv(e, rows, revRows, expRows, adj); };
    }).catch(function (err) { body.innerHTML = '<div class="notice warn">' + esc(err.message) + '</div>'; });
  }

  function drawGroupedChart(canvas, labels, rows) {
    if (!window.Chart) return;
    var ds = function (label, key, color) {
      return { label: label, data: rows.map(function (o) { return o[key] === null ? null : Math.round(o[key]); }), backgroundColor: color, borderRadius: 3, maxBarThickness: 46 };
    };
    var chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: labels, datasets: [ds('REVENUE', 'rev', COLORS.revenue), ds('EXPENDITURES', 'exp', COLORS.expenditures), ds('PROFIT', 'profit', COLORS.profit)] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { position: 'bottom', labels: { font: { family: 'Roboto' }, boxWidth: 14 } },
          tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + money(c.parsed.y); } } } },
        scales: { y: { beginAtZero: true, ticks: { callback: function (v) { return money(v); }, font: { family: 'Roboto' } }, grid: { color: '#eef1f5' } },
          x: { ticks: { font: { family: 'Roboto' } }, grid: { display: false } } }
      },
      plugins: [{ id: 'labels', afterDatasetsDraw: function (c) {
        var ctx = c.ctx; ctx.save(); ctx.font = '500 11px Roboto, Arial'; ctx.fillStyle = '#1d2433'; ctx.textAlign = 'center';
        c.data.datasets.forEach(function (d, i) {
          c.getDatasetMeta(i).data.forEach(function (bar, j) {
            var v = d.data[j]; if (v === null || v === undefined) return;
            var txt = Math.abs(v) >= 1000 ? (v < 0 ? '-' : '') + '$' + (Math.abs(v) / 1000).toFixed(Math.abs(v) >= 100000 ? 0 : 1) + 'k' : money(v);
            ctx.fillText(txt, bar.x, v >= 0 ? bar.y - 4 : bar.y + 12);
          });
        });
        ctx.restore();
      } }]
    });
    state.charts.push(chart);
    return chart;
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  function downloadPdf(e) {
    if (!window.html2pdf) return toast('PDF library did not load');
    // Render an off-screen copy at a fixed width so the page layout (centering, scroll) can't crop it.
    var src = $('#report');
    var holder = document.createElement('div');
    // html2pdf lays the copy out in a box as wide as the printable page (8.5in - 0.8in margins).
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:7.7in;background:#fff;';
    var copy = src.cloneNode(true);
    copy.removeAttribute('id');
    copy.style.border = '0';
    copy.style.padding = '0';
    copy.style.width = '7.7in';
    copy.classList.add('pdf');
    // A cloned <canvas> is blank; swap in a picture of the chart.
    var live = src.querySelector('canvas'), dead = copy.querySelector('canvas');
    if (live && dead) {
      var img = new Image();
      img.src = live.toDataURL('image/png', 1);
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      dead.parentNode.replaceChild(img, dead);
    }
    holder.appendChild(copy);
    document.body.appendChild(holder);
    toast('Preparing PDF…', 8000);
    html2pdf().set({
      margin: [0.4, 0.4, 0.5, 0.4], filename: slug(e.name) + '-fy' + state.fy + '-report.pdf',
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'], before: '.rt.expense', avoid: ['tr'] }
    }).from(copy).save().then(function () { holder.remove(); toast('PDF downloaded'); }, function (err) { holder.remove(); toast('PDF failed: ' + err, 6000); });
  }

  function downloadCsv(e, rows, revRows, expRows, adj) {
    var q = function (v) { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var n = function (v) { return v === null || v === undefined ? '' : (Math.round(v * 100) / 100).toFixed(2); };
    var out = [['Event', e.name], ['FY', state.fy], ['Expense account', e.expAcct], ['Revenue account', e.revAcct], ['Attendees', e.attendees], []];
    out.push(['Summary', 'Revenue', 'Expenditures', 'Profit']);
    rows.forEach(function (o) { out.push([o.label, n(o.rev), n(o.exp), n(o.profit)]); });
    out.push([], ['Revenue', 'Budget', 'Estimate', 'Difference']);
    revRows.forEach(function (o) { out.push([o.cat, n(o.budget), n(o.estimate), n(o.estimate - o.budget)]); });
    out.push([], adj ? ['Expenditures', 'Budget', 'Adjusted target', 'Estimate', 'Difference'] : ['Expenditures', 'Budget', 'Estimate', 'Difference']);
    expRows.forEach(function (o) {
      out.push(adj ? [o.cat, n(o.budget), n(o.target), n(o.estimate), n(o.estimate - o.target)] : [o.cat, n(o.budget), n(o.estimate), n(o.estimate - o.budget)]);
    });
    out.push([], ['Sub-account', 'Category', 'Finance label', 'Budget', 'Target', 'Estimated/Quoted', 'Approved', 'Invoiced', 'Paid', 'Remaining']);
    e.lines.filter(function (l) { return l.side === 'Expense'; }).forEach(function (l) {
      out.push([l.sub, l.cat, l.label, n(l.budget), n(l.target), n(l.est.estimated), n(l.est.approved), n(l.est.invoiced), n(l.est.paid), n(l.remaining)]);
    });
    if (adj && e.expense.adjustmentNote) out.push([], ['Adjustment note', e.expense.adjustmentNote]);
    var blob = new Blob(['﻿' + out.map(function (r) { return r.map(q).join(','); }).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = slug(e.name) + '-fy' + state.fy + '-report.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ------------------------------------------------------------ 5. What's missing */

  function renderMissing() {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    loading();
    api('reconcile', { fy: state.fy }).then(function (r) { if (nav !== state.nav) return;
      var section = function (title, help, body, count) {
        return '<section class="stack"><h2>' + esc(title) + ' <span class="badge' + (count ? ' warn' : '') + '">' + count + '</span></h2><p class="muted" style="margin:0">' + esc(help) + '</p>' + body + '</section>';
      };
      var over = r.overBudget.length ? '<div class="table-wrap"><table><thead><tr><th>Event</th><th>Sub-account</th><th>Category</th><th class="num">Target</th><th class="num">Estimate</th><th class="num">Over by</th><th class="num">Actual (phase 2)</th></tr></thead><tbody>' +
        r.overBudget.map(function (o) {
          return '<tr class="click" data-go="#/dashboard/' + esc(o.eventId) + '/' + esc(o.sub) + '"><td>' + esc(o.eventName) + '</td><td><b>' + esc(o.sub) + '</b><div class="muted">' + esc(o.label) + '</div></td><td>' + esc(o.cat) + '</td>' +
            moneyCell(o.target) + moneyCell(o.estimate, true) + '<td class="num neg">' + money(o.over, true) + '</td><td class="num muted">—</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="empty">No line is over its budget.</div>';
      view.innerHTML = '<div class="stack"><h1>What\'s missing · FY ' + esc(state.fy) + '</h1>' +
        section('Approved without a PO', 'Approved items with no PO number and PO Processed unchecked.', expenseTable(r.approvedNoPo, ['event', 'actual']), r.approvedNoPo.length) +
        section('Invoiced, not paid', 'Status is Invoiced.', expenseTable(r.invoicedNotPaid, ['event', 'actual']), r.invoicedNotPaid.length) +
        section('Needs review', 'Missing category, amount, date or sub-account. Rows with no date show under every FY.', expenseTable(r.needsReview, ['event', 'actual']), r.needsReview.length) +
        section('Lines over budget', 'Estimate (not cancelled) above the line\'s budget or adjusted target. Lines with no budget amount are skipped.', over, r.overBudget.length) + '</div>';
      view.querySelectorAll('[data-go]').forEach(function (tr) { tr.addEventListener('click', function () { location.hash = tr.dataset.go; }); });
      bindEdit();
    }).catch(showError);
  }

  /* ------------------------------------------------------------ 6. History */

  function renderHistory(args) {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    if (args[0]) setEvent(decodeURIComponent(args[0]));
    loading();
    getCatalog(state.fy).then(function (cat) { if (nav !== state.nav) return;
      view.innerHTML = '<div class="stack"><h1>History</h1><div class="row"><label class="field"><span>Event</span><select id="hs-event">' + eventOptions(cat, { all: true }) + '</select></label>' +
        '<label class="field" style="flex:0 1 160px"><span>Years</span><select id="hs-n"><option>3</option><option>4</option><option selected>5</option><option value="99">All</option></select></label></div><div id="hs-body"></div></div>';
      $('#hs-event').addEventListener('change', function (e) { setEvent(e.target.value); drawHistory(); });
      $('#hs-n').addEventListener('change', drawHistory);
      drawHistory();
    }).catch(showError);
  }

  function drawHistory() {
    var nav = state.nav; // async callbacks below stop if the user navigates away
    destroyCharts();
    var body = $('#hs-body');
    if (!state.event) { body.innerHTML = '<div class="empty">Pick an event.</div>'; return; }
    body.innerHTML = '<div class="loading">Loading…</div>';
    api('history', { event: state.event }).then(function (rows) { if (nav !== state.nav) return;
      // One row per FY: Actual wins, then Estimate; Budget shown alongside.
      var byFy = {};
      rows.forEach(function (h) { (byFy[h.fy] = byFy[h.fy] || {})[h.type] = h; });
      var fys = Object.keys(byFy).sort();
      var n = Number($('#hs-n').value);
      fys = fys.slice(-n);
      if (!fys.length) { body.innerHTML = '<div class="empty">No history for this event yet.</div>'; return; }
      var pick = fys.map(function (fy) {
        var g = byFy[fy], main = g.Actual || g.Estimate || null;
        return { fy: fy, type: main ? main.type : '—', rev: main ? main.revenue : null, exp: main ? main.expenditures : null,
          profit: main ? main.revenue - main.expenditures : null, budget: g.Budget || null, source: main ? main.source : (g.Budget ? g.Budget.source : '') };
      });
      body.innerHTML = '<div class="chart-box" style="height:320px"><canvas id="hs-chart"></canvas></div>' +
        '<div class="table-wrap"><table><thead><tr><th>FY</th><th>Type</th><th class="num">Revenue</th><th class="num">Expenditures</th><th class="num">Profit</th>' +
        '<th class="num">Budget rev.</th><th class="num">Budget exp.</th><th>Source</th></tr></thead><tbody>' +
        pick.map(function (o) {
          return '<tr><td><b>' + esc(o.fy) + '</b></td><td>' + esc(o.type) + '</td>' + moneyCell(o.rev) + moneyCell(o.exp) + moneyCell(o.profit) +
            (o.budget ? moneyCell(o.budget.revenue) + moneyCell(o.budget.expenditures) : '<td class="num muted">—</td><td class="num muted">—</td>') +
            '<td class="muted" style="font-size:.82rem">' + esc(o.source) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      drawGroupedChart($('#hs-chart'), pick.map(function (o) { return 'FY ' + o.fy + (o.type === 'Estimate' ? ' (est.)' : ''); }), pick);
    }).catch(function (e) { body.innerHTML = '<div class="notice warn">' + esc(e.message) + '</div>'; });
  }

  /* ------------------------------------------------------------ start */
  initAuth();
})();
