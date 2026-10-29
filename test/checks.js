// Acceptance checks against Code.gs, run in Node on a copy of the Sheet.
// Usage: FIXTURE=/path/to/fixture.json node test/checks.js
const assert = require('assert');
const { loadGas, TEST_TOKENS } = require('./gas-mock');

const fixture = process.env.FIXTURE;
// Expected figures are real budget data, so they live in a local file that is never committed.
const X = JSON.parse(require('fs').readFileSync(process.env.EXPECT || require('path').join(__dirname, 'acceptance.local.json'), 'utf8'));
if (!fixture) { console.error('Set FIXTURE to a JSON export of the Sheet'); process.exit(2); }
const gas = loadGas({ fixture, tokens: TEST_TOKENS });
const as = (token, body) => gas.call(Object.assign({ token }, body));
const me = body => {
  const r = as('tok-jorge', body);
  if (!r.ok) throw new Error(body.action + ': ' + r.error);
  return r.data;
};

let failed = 0;
const check = (name, fn) => {
  try { const note = fn(); console.log('PASS', name + (note ? '  — ' + note : '')); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
};
const money = n => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

check('Lookup Annual Banquet / F&B / 26-27', () => {
  const c = me({ action: 'catalog', fy: '26-27' });
  const ev = c.events.find(e => e.id === 'BANQUET');
  const l = c.lines.find(x => x.eventId === 'BANQUET' && x.side === 'Expense' && x.cat === 'F&B');
  assert.strictEqual(ev.expAcct, X.banquet.acct);
  assert.strictEqual(l.acct, X.banquet.acct); assert.strictEqual(l.sub, X.banquet.fbSub);
  assert.strictEqual(l.budget, X.banquet.fbBudget); assert.strictEqual(l.adjusted, X.banquet.fbAdjusted);
  return `${l.acct} · ${l.sub} · official ${money(l.budget)} · adjusted ${money(l.adjusted)}`;
});

check('Annual Banquet 26-27 official $97,500 / adjusted $92,000', () => {
  const s = me({ action: 'summary', fy: '26-27', event: 'BANQUET' }).events[0];
  assert.strictEqual(s.expense.budget, X.banquet.expBudget); assert.strictEqual(s.expense.target, X.banquet.expAdjusted);
  assert.ok(s.expense.hasAdjusted && /Blanca/.test(s.expense.adjustmentNote));
  return `budget ${money(s.expense.budget)}, adjusted ${money(s.expense.target)}, note shown`;
});

check('Whiskey Business 25-26 budget $30,000 / actual $33,031; 26-27 budget $23,150', () => {
  const s25 = me({ action: 'summary', fy: '25-26', event: 'WHISKEY' }).events[0];
  const s26 = me({ action: 'summary', fy: '26-27', event: 'WHISKEY' }).events[0];
  const h = me({ action: 'history', event: 'WHISKEY' }).find(r => r.fy === '25-26' && r.type === 'Actual');
  assert.strictEqual(s25.expense.budget, X.whiskey.budget2526); assert.strictEqual(h.expenditures, X.whiskey.actual2526);
  assert.strictEqual(s26.expense.budget, X.whiskey.budget2627); assert.strictEqual(s26.prior.expenditures, X.whiskey.actual2526);
  return `25-26 ${money(s25.expense.budget)} / actual ${money(h.expenditures)}; 26-27 ${money(s26.expense.budget)}`;
});

check('Every old Data row is in Expenses; Needs Review count', () => {
  const all = [...me({ action: 'expenses', fy: '25-26' }), ...me({ action: 'expenses', fy: '26-27' }), ...me({ action: 'expenses', fy: '' })];
  const byId = new Map(all.map(x => [x.id, x]));
  const ids = new Set(byId.keys());
  const uniq = [...byId.values()];
  assert.strictEqual(ids.size, X.dataRows + X.formOnlyRows);
  const fromForm = uniq.filter(x => /^Google Form submission/.test(x.notes)).length;
  assert.strictEqual(ids.size - fromForm, X.dataRows);
  const review = uniq.filter(x => x.review === true).length;
  return `${X.dataRows} of ${X.dataRows} Data rows (+${fromForm} form-only) · Needs Review ${review}`;
});

check('History FY 17-18 → 25-26 for Annual Banquet, 25-26 is Actual', () => {
  const h = me({ action: 'history', event: 'BANQUET' }).filter(r => r.type === 'Actual');
  assert.deepStrictEqual(h.map(r => r.fy), ['17-18', '18-19', '19-20', '20-21', '21-22', '22-23', '23-24', '24-25', '25-26']);
  const last = h[h.length - 1];
  assert.strictEqual(last.revenue, X.banquet.actualRev2526); assert.strictEqual(last.expenditures, X.banquet.actualExp2526);
  return `9 FYs; 25-26 Actual ${money(last.revenue)} / ${money(last.expenditures)}`;
});

check('Banquet 26-27 revenue sheet lands in FY 26-27', () => {
  const r26 = me({ action: 'revenue', fy: '26-27', event: 'BANQUET' });
  const r25 = me({ action: 'revenue', fy: '25-26', event: 'BANQUET' });
  const id = X.banquet.revenueSheet2627;
  assert.ok(r26.length && r26.every(r => r.source === id));
  assert.ok(r25.every(r => r.source !== id));
  return `${r26.length} rows, ${money(r26.reduce((s, r) => s + r.revenue, 0))} in 26-27; none in 25-26`;
});

check('refreshRevenue reads the whole $ Revenue tab and keeps manual rows', () => {
  const id = X.banquet.revenueSheet2627;
  const rows = [['', 'Sponsorship Level', 'Count', 'Revenue', 'InKind']];
  for (let i = 1; i <= 14; i++) rows.push(['', 'Level ' + i, 1, 1000, 0]); // more than the old 11-row limit
  rows.push(['', 'Total', 14, 14000, 0]);
  gas.addExternal(id, rows);
  const res = me({ action: 'refreshRevenue', fy: '26-27' });
  const r26 = me({ action: 'revenue', fy: '26-27', event: 'BANQUET' });
  const manual = me({ action: 'revenue', fy: '25-26', event: 'JUMPSTART' });
  assert.strictEqual(r26.length, 14); assert.ok(manual.some(r => r.source === 'manual'));
  return `${res.rows} rows read from ${res.sheets} sheet(s), 14 > 11, manual Jumpstart row kept`;
});

check('Adding an expense updates the summary right away (no Sheet reload)', () => {
  const before = me({ action: 'summary', fy: '26-27', event: 'BANQUET' }).events[0];
  const saved = me({ action: 'expense', op: 'create', expense: { eventId: 'BANQUET', date: '2026-11-02', vendor: 'Test Vendor', description: 'Check', cat: 'F&B', amount: 1200, status: 'Approved', payType: 'Check' } });
  assert.strictEqual(saved.expense.acct, X.banquet.acct); assert.strictEqual(saved.expense.sub, X.banquet.fbSub);
  assert.strictEqual(saved.expense.fy, '26-27');
  const after = me({ action: 'summary', fy: '26-27', event: 'BANQUET' }).events[0];
  assert.strictEqual(Math.round((after.expense.est.approved - before.expense.est.approved) * 100), 120000);
  const big = me({ action: 'expense', op: 'create', expense: { eventId: 'BANQUET', date: '2026-11-02', vendor: 'Test', cat: 'Venue', amount: 99999, status: 'Quote' } });
  assert.ok(big.warnings.length && /over/.test(big.warnings[0]));
  me({ action: 'expense', op: 'cancel', expense: { id: big.expense.id } });
  const cancelled = me({ action: 'summary', fy: '26-27', event: 'BANQUET' }).events[0];
  assert.strictEqual(cancelled.expense.est.total, after.expense.est.total);
  return `${saved.expense.id} → ${saved.expense.acct}/${saved.expense.sub}; approved +$1,200; over-budget warning raised; cancel removes it`;
});

check('Category without its own line falls back like the migration', () => {
  const x = me({ action: 'expense', op: 'create', expense: { eventId: 'WHISKEY', date: '2027-01-10', cat: 'Supplies', amount: 10, status: 'Estimation' } });
  assert.strictEqual(x.expense.sub, X.fallback.whiskeySupplies);
  const y = me({ action: 'expense', op: 'create', expense: { eventId: 'XMASPARK', date: '2026-12-01', cat: 'Venue', amount: 10, status: 'Estimation' } });
  assert.strictEqual(y.expense.sub, X.fallback.xmasVenue);
  return `Whiskey Supplies → ${x.expense.sub} (Other); Christmas in the Park Venue → ${y.expense.sub} (single line)`;
});

check('Reconciliation lists', () => {
  const r = me({ action: 'reconcile', fy: '25-26' });
  assert.ok(Array.isArray(r.approvedNoPo) && Array.isArray(r.overBudget));
  return `approved w/o PO ${r.approvedNoPo.length}, invoiced not paid ${r.invoicedNotPaid.length}, needs review ${r.needsReview.length}, over budget ${r.overBudget.length}`;
});

check('Any other account gets no data', () => {
  const tries = [as('tok-other', { action: 'summary', fy: '26-27' }), as('tok-wrong-aud', { action: 'catalog' }),
    as('nonsense', { action: 'expenses' }), gas.call({ action: 'catalog' }), gas.get({ action: 'catalog' })];
  tries.forEach(t => { assert.strictEqual(t.ok, false); assert.strictEqual(t.data, undefined); });
  return tries.map(t => t.error).join(' | ');
});

check('No salary or personnel data in any tab the API reads', () => {
  const pat = /salar|payroll|compensation|benefit|pension|social security|medicare/i;
  const hits = [];
  Object.values(gas.sheets).forEach(sh => sh.rows.forEach((r, i) => r.forEach(v => { if (typeof v === 'string' && pat.test(v)) hits.push(sh.name + ' r' + (i + 1) + ': ' + v); })));
  assert.deepStrictEqual(hits, []);
  return 'none found';
});

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
