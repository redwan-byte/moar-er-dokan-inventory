# Moar er Dokan · Inventory

A simple inventory app for Moar er Dokan, made to run on Netlify. It has four tabs:

- **Stock**: every item with how many are left at each branch, plus low-stock warnings, search, **+ Stock** for deliveries and **Edit** for corrections.
- **Sell**: the same questions as the Google Form (Sale Date, Branch, Sold By, Who Bought it?, Item, Quantity, Bill Amount). Each sale takes the items out of stock, and the bill amount fills in from the price.
- **History**: sales and deliveries filtered by period, with totals, best sellers and a **Download CSV** button. If you delete a wrong entry, the stock is corrected too.
- **Settings**: branches, the "Who Bought it?" choices, the low-stock level, and backup/restore.

## Deploy to Netlify

### Option A: one shared inventory for all branches (recommended)

All phones and computers see the same stock. Data is stored in **Netlify Blobs**, which comes with every Netlify site, so no database is needed.

**From GitHub:** push this folder to a GitHub repo. In Netlify, go to **Add new site → Import an existing project** and pick the repo. Leave the build command empty. `netlify.toml` already sets the publish folder (`public`) and the function folder.

**Or from your computer** with the Netlify CLI:

```bash
npm install
npx netlify-cli deploy --prod
```

When the site is live, the badge at the top says **"Shared · up to date"**.

**Add a PIN (recommended).** Anyone who has the link can open the site. To lock it, go to **Site configuration → Environment variables**, add `SHOP_PIN` (for example `4821`), then redeploy. Each device asks for the PIN once.

### Option B: quick try, this device only

Drag the **`public`** folder onto <https://app.netlify.com/drop>. This uploads only the web page, so each browser keeps its own data and the badge says **"Saved on this device only"**. You can move to Option A later: use **Settings → Download backup** here, then **Restore from backup** on the shared site.

## If it doesn't work

| What you see | Fix |
|---|---|
| **"Page not found"** | The files are one folder too deep. On GitHub, `netlify.toml` must be at the top of the repo, not inside a `moar-er-dokan-inventory` folder. Re-upload the folder *contents*, or in Netlify set **Build settings → Base directory** to `moar-er-dokan-inventory` and redeploy. |
| **Deploy failed: "Deploy directory 'public' does not exist"** | The `public` and `netlify` folders didn't upload to GitHub. The file picker can't upload folders, so drag them into the GitHub upload page instead. |
| **Stuck on "Loading…"** | You opened `index.html` straight from your computer. It only works from the Netlify link. |
| **Badge says "Saved on this device only"** | The site was drag-and-dropped. Use the GitHub method for shared data. |

## Files

```
public/index.html      the page
public/styles.css      Moar theme (colours from the Google Form)
public/app.js          the app
public/logic.js        stock rules, shared by the app and the server
netlify/functions/api.mjs   saves the shared inventory in Netlify Blobs
netlify.toml           Netlify settings
```

The app picks the right mode by itself. If `/api` exists it uses shared storage. If not, it saves in the browser.
