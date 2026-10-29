# Event Expense Tracker

A small web app for tracking **estimated** event expenses against the official budget, by event and fiscal year (Oct 1 to Sep 30). It runs at <https://eventexpenses.jorgesanchez.me> as a static site on GitHub Pages. All data lives in the private Google Sheet "Event Expense Tracker". A Google Apps Script bound to that Sheet answers the site's requests, and only for one Google account.

This repository is public. It holds no data and no secrets.

## How it fits together

```
Browser (GitHub Pages)  ──Google Sign-In ID token──▶  Apps Script web app  ──▶  Google Sheet
index.html / app.js                                    apps-script/Code.gs        Events, Catalog, Expenses,
                                                       checks token + email       Revenue, History, Config,
                                                                                  Finance YTD
```

- The page signs in with Google Identity Services and sends the ID token with every request (`POST`, `text/plain` body, so no CORS preflight).
- `Code.gs` validates the token with Google (`tokeninfo`), checks that the audience is this app's OAuth client ID, and answers only `ALLOWED_EMAIL`. Any other account gets `{ ok: false, error: "Access denied…" }` and no data.
- The client ID and allowed email are **script properties**, not code. The client ID in `config.js` is public by design.

## Screens

| Route | What it does |
|---|---|
| `#/lookup` | Pick an event and see its expense and revenue accounts, every sub-account with category, budget and remaining. Tap a category to get the exact sub-account in large type. |
| `#/add` | Add or edit an estimate. The account and sub-account fill in from the Catalog, with a warning when the line would go over budget. Edit and Cancel are reached from any expense list. |
| `#/dashboard` | All tracked events for the FY: budget, adjusted target, estimate split by Estimated/Quoted, Approved, Invoiced, Paid, and what Finance has booked so far (Finance YTD). Drill down event → sub-account → expenses. |
| `#/report` | Replica of the old Report Master tab, with **Download PDF** and **Download CSV**. Shows the adjustment note when an adjusted target exists. |
| `#/missing` | Approved without a PO, invoiced but not paid, Needs Review rows, lines over budget. The Actual column is a placeholder for phase 2. |
| `#/history` | The last 3 to 5 fiscal years of revenue, expenditures and profit, as a table and a chart. |

## API (`apps-script/Code.gs`)

Every call takes `token`. Reads also work as `GET ?action=…`, but the site uses `POST` so the token never appears in a URL.

| action | params | returns |
|---|---|---|
| `catalog` | `fy` | events and catalog lines for the FY, the FY list, Config lists |
| `expenses` | `fy`, `event` | Expenses rows |
| `summary` | `fy`, `event` (optional) | budget, adjusted target, estimate by status, remaining, per sub-account and category, and Finance YTD from the latest statement for the FY |
| `history` | `event` | History rows |
| `revenue` | `fy`, `event` | Revenue rows (from Blanca's sheets) |
| `reconcile` | `fy` | the lists on the "What's missing" screen |
| `expense` | `op` = `create` / `update` / `cancel`, `expense` | the saved row and any over-budget warning |
| `refreshRevenue` | `fy` (optional) | re-reads every `$ Revenue` tab listed in Events → Revenue Sheet ID |

How a sub-account is filled in (the same rule the migration used): the line mapped to the expense's category; if there is none, the event's only line (single-line events); otherwise the event's "Other" (xx99) line. Rows where none of these applies are saved with **Needs Review = TRUE**.

## One-time setup

### 1. OAuth client (for Google Sign-In)
1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project, then open **APIs & Services → OAuth consent screen**. Choose **Internal** (McAllen Chamber Workspace) and fill in the app name.
2. Open **Credentials → Create credentials → OAuth client ID → Web application**.
3. Under **Authorized JavaScript origins**, add `https://eventexpenses.jorgesanchez.me`. Add `http://localhost:8080` too if you want to test locally against the real API.
4. Copy the **Client ID**. It goes in `config.js` and in the script properties below.

### 2. Apps Script
1. Open the Sheet → **Extensions → Apps Script**.
2. Replace `Code.gs` with `apps-script/Code.gs` from this repo. Under **Project Settings**, tick *Show "appsscript.json"* and replace it with `apps-script/appsscript.json`.
3. **Project Settings → Script properties**, add:
   - `CLIENT_ID` = the OAuth client ID from step 1
   - `ALLOWED_EMAIL` = `jsanchez@mcallenchamber.com`
4. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Authorize when asked. "Anyone" only means the URL is reachable; every request still needs your signed-in Google account.
5. Copy the web app URL (ends in `/exec`) into `config.js` → `apiUrl`, along with the client ID, then commit and push.

### 3. GitHub Pages and the domain
- Pages builds from `main` / root. The `CNAME` file holds `eventexpenses.jorgesanchez.me`.
- DNS at your registrar for `jorgesanchez.me`: add a **CNAME** record, host `eventexpenses`, value `jorgesanchezmcofc.github.io`.
- When the certificate is ready (usually minutes after DNS resolves), tick **Settings → Pages → Enforce HTTPS**.

## Redeploying the Apps Script

After changing `Code.gs`, paste the new version into the Apps Script editor, then **Deploy → Manage deployments → (pencil) Edit → Version: New version → Deploy**. Editing the existing deployment keeps the same `/exec` URL, so `config.js` does not change. "New deployment" would create a new URL.

## Adding a new fiscal year budget

Say FY 27-28, when Finance sends the coded budget:

1. **Events:** copy the FY 26-27 rows, change `FY` to `27-28`, and update accounts, Track, dates and the Revenue Sheet ID (Blanca's new sheet for each event).
2. **Catalog:** for every 402xx (revenue) and 504xx (expense) sub-account in Finance's file, add a row with `FY = 27-28`, Event ID, Side, Account, Sub-Account, Finance's label, a Standard Category from Config, and Official Budget. Keep the codes as text (the columns are formatted as plain text). The key is FY + Event + Account + Sub-Account, so Finance's duplicate codes (2080401, 2130301/2130399) are fine.
3. Put any budget you were asked to change in **Adjusted Target** and say why in **Adjustment Note**. Leave Official Budget as Finance sent it.
4. Change **Config → Current FY** and `defaultFy` in `config.js`.
5. **Finance YTD** fills itself: the "Beto financials check" scheduled task reads each monthly income statement from Outlook and writes the event lines (402xx/504xx only) to the Finance YTD tab, logging each email in Finance Log. The app shows the latest period for the FY.
6. After 9/30, add the year's actuals from Finance's September income statement (YTD column) to **History** with Type `Actual`.
7. On the dashboard, click **Refresh revenue** to pull the new revenue sheets.

## Local testing

The tests run the real `Code.gs` in Node against a JSON copy of the Sheet. Building that copy is a one-off export. **It contains real data, so keep it out of the repo** (`.gitignore` covers `test/fixture*.json`).

```bash
FIXTURE=/path/to/fixture.json node test/checks.js        # API acceptance checks
FIXTURE=/path/to/fixture.json node test/e2e.js           # browser checks (Playwright)
FIXTURE=/path/to/fixture.json node test/dev-server.js    # preview at http://localhost:8080 (signs in with a test token)
```

Wide tables must fit without scrolling sideways (they turn into cards under 900px); the browser checks fail if any table or the page scrolls horizontally at 1280, 820 or 375px.

## Third-party code

`assets/vendor/` holds Chart.js 4.4.1 and html2pdf.js 0.10.1 (MIT licenses alongside). They are served from this site rather than a CDN.
