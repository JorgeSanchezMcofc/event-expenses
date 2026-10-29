// Browser test against the local dev server. Usage:
// FIXTURE=... OUT=/tmp/shots node test/e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = process.env.OUT || path.join(__dirname, 'out');
const X = JSON.parse(fs.readFileSync(process.env.EXPECT || path.join(__dirname, 'acceptance.local.json'), 'utf8'));
const B = X.banquet, usd = n => '$' + n.toLocaleString('en-US');
fs.mkdirSync(OUT, { recursive: true });

function startServer(port, token) {
  const p = spawn(process.execPath, [path.join(__dirname, 'dev-server.js')], { env: Object.assign({}, process.env, { PORT: String(port), DEV_TOKEN: token }) });
  return new Promise(res => p.stdout.on('data', () => res(p)));
}

(async () => {
  const srv = await startServer(8091, 'tok-jorge');
  const bad = await startServer(8092, 'tok-other');
  const browser = await chromium.launch();
  const results = [];
  const ok = (name, cond, note) => { results.push([cond ? 'PASS' : 'FAIL', name, note || '']); };
  try {
    for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 375, height: 812 }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, acceptDownloads: true, deviceScaleFactor: vp.name === 'phone' ? 2 : 1 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      // Google Sign-In and Google Fonts can't be reached from the test sandbox; anything else failing is a bug.
      const external = /accounts\.google\.com|fonts\.(googleapis|gstatic)\.com/;
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      page.on('requestfailed', r => { if (!external.test(r.url())) errors.push('request failed: ' + r.url()); });
      await page.route(/accounts\.google\.com/, r => r.abort());
      const base = 'http://localhost:8091/';
      const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

      await page.goto(base + '#/lookup');
      await page.selectOption('#lk-event', 'BANQUET');
      await page.waitForSelector('#lk-cats');
      await page.click('#lk-cats [data-cat="F&B"]');
      const answer = await page.textContent('.answer');
      ok(`[${vp.name}] Lookup Banquet / F&B`, answer.includes(B.acct + ' · ' + B.fbSub) && answer.includes(usd(B.fbAdjusted)) && answer.includes(usd(B.fbBudget)), answer.replace(/\s+/g, ' ').slice(0, 120));
      ok(`[${vp.name}] Lookup has no horizontal page scroll`, (await overflow()) <= 0);
      await page.screenshot({ path: `${OUT}/${vp.name}-1-lookup.png`, fullPage: true });

      await page.goto(base + '#/dashboard');
      await page.waitForSelector('.event-card[data-ev="BANQUET"]');
      const before = await page.textContent('.event-card[data-ev="BANQUET"]');
      await page.screenshot({ path: `${OUT}/${vp.name}-3-dashboard.png`, fullPage: true });
      ok(`[${vp.name}] Dashboard has no horizontal page scroll`, (await overflow()) <= 0);

      if (vp.name === 'desktop') {
        await page.goto(base + '#/add/BANQUET/F%26B');
        await page.waitForSelector('#xf-sub');
        await page.fill('input[name=amount]', '2500');
        await page.fill('input[name=vendor]', 'E2E Vendor');
        await page.fill('input[name=date]', '2026-11-05');
        await page.dispatchEvent('input[name=date]', 'change');
        await page.selectOption('select[name=status]', 'Approved');
        await page.waitForTimeout(150);
        const preview = await page.textContent('#xf-warn');
        const sub = await page.inputValue('#xf-sub');
        await page.screenshot({ path: `${OUT}/${vp.name}-2-add.png`, fullPage: true });
        await page.click('button[type=submit]');
        await page.waitForSelector('#xf-result .notice.ok');
        const saved = await page.textContent('#xf-result');
        ok('[desktop] Add expense auto-fills the F&B sub-account and saves', saved.includes(B.fbSub) && /FY 26-27/.test(saved), saved.replace(/\s+/g, ' ').slice(0, 140));
        ok('[desktop] Over-budget preview shown', /Over adjusted target|stays within/.test(preview), preview.slice(0, 120) + ' | auto sub=' + (sub || 'auto'));
        await page.goto(base + '#/dashboard');
        await page.waitForSelector('.event-card[data-ev="BANQUET"]');
        const after = await page.textContent('.event-card[data-ev="BANQUET"]');
        const num = s => Number((/\$([\d,]+) of/.exec(s) || [0, '0'])[1].replace(/,/g, ''));
        ok('[desktop] Dashboard updates after adding (no Sheet reload)', num(after) - num(before) === 2500, `${num(before)} → ${num(after)}`);

        await page.click('.event-card[data-ev="BANQUET"]');
        await page.waitForSelector(`tr[data-sub="${B.fbSub}"]`);
        await page.click(`tr[data-sub="${B.fbSub}"]`);
        await page.waitForSelector('text=Expenses on ' + B.fbSub);
        ok('[desktop] Drill-down event → sub-account → expenses', (await page.textContent('main')).includes('E2E Vendor'));
        await page.screenshot({ path: `${OUT}/${vp.name}-3b-drill.png`, fullPage: true });
      }

      await page.goto(base + '#/report/WHISKEY');
      await page.waitForSelector('#report .rt.expense');
      await page.waitForTimeout(300);
      const rep = await page.textContent('#report');
      ok(`[${vp.name}] Report shows Report Master sections`, /WHISKEY BUSINESS|Whiskey Business/i.test(rep) && /REVENUE/.test(rep) && /EXPENDITURES/.test(rep) && /FY 25-26 ACTUAL/.test(rep));
      const colors = await page.evaluate(() => {
        const c = Chart.getChart(document.getElementById('rp-chart'));
        return c ? c.data.datasets.map(d => d.backgroundColor) : [];
      });
      ok(`[${vp.name}] Chart colors Revenue/Expenditures/Profit`, JSON.stringify(colors) === JSON.stringify(['#F04C57', '#185097', '#F2C14E']), colors.join(' '));
      await page.screenshot({ path: `${OUT}/${vp.name}-4-report.png`, fullPage: true });
      ok(`[${vp.name}] Report has no horizontal page scroll`, (await overflow()) <= 0);

      if (vp.name === 'desktop') {
        await page.goto(base + '#/report/BANQUET');
        await page.waitForSelector('#report .adj-note');
        const note = await page.textContent('#report .adj-note');
        ok('[desktop] Report shows the adjustment note', /Blanca/.test(note));
        await page.screenshot({ path: `${OUT}/desktop-4b-report-banquet.png`, fullPage: true });
        const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#rp-pdf')]);
        const pdfPath = `${OUT}/${pdf.suggestedFilename()}`; await pdf.saveAs(pdfPath);
        const head = fs.readFileSync(pdfPath).slice(0, 5).toString();
        ok('[desktop] Download PDF', head === '%PDF-', `${pdf.suggestedFilename()} ${fs.statSync(pdfPath).size} bytes`);
        const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#rp-csv')]);
        const csvPath = `${OUT}/${csv.suggestedFilename()}`; await csv.saveAs(csvPath);
        const text = fs.readFileSync(csvPath, 'utf8');
        ok('[desktop] Download CSV', /Expenditures,Budget,Adjusted target,Estimate,Difference/.test(text), csv.suggestedFilename());
      }

      await page.goto(base + '#/missing');
      await page.waitForSelector('h2');
      await page.screenshot({ path: `${OUT}/${vp.name}-5-missing.png`, fullPage: true });
      ok(`[${vp.name}] What's missing has Actual (phase 2) column`, (await page.textContent('main')).includes('Actual (phase 2)'));

      await page.goto(base + '#/history/BANQUET');
      await page.waitForSelector('#hs-body table');
      const hist = await page.textContent('#hs-body');
      ok(`[${vp.name}] History shows last 5 FYs`, /21-22/.test(hist) && /25-26/.test(hist) && !/20-21/.test(hist));
      await page.screenshot({ path: `${OUT}/${vp.name}-6-history.png`, fullPage: true });
      ok(`[${vp.name}] No JavaScript errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    // Wrong account: the API refuses and the page shows no data.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.route(/accounts\.google\.com/, r => r.abort());
    await page.goto('http://localhost:8092/#/dashboard');
    await page.waitForFunction(() => /\S/.test((document.querySelector('#signin-msg') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const msg = await page.textContent('#signin-msg');
    const hasCards = await page.$('.event-card');
    ok('Other account gets no data', /Access denied/.test(msg) && !hasCards, msg);
    await page.screenshot({ path: `${OUT}/other-account.png` });
    await ctx.close();
  } finally {
    await browser.close(); srv.kill(); bad.kill();
  }
  results.forEach(r => console.log(r[0], r[1], r[2] ? '— ' + r[2] : ''));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} failed` : '\nAll browser checks passed');
  process.exit(failed ? 1 : 0);
})();
