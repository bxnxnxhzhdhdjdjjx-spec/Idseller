# IDBazaar — minimal Telegram Mini App

A lightweight, Vercel-ready starter for a marketplace of **permitted, transferable digital identity assets**. It intentionally keeps the project to six files:

1. `index.html` — responsive UI, CSS, and browser JavaScript in one file.
2. `api/index.js` — one Vercel serverless API for catalogue, purchase requests, selling, orders, and admin review.
3. `db.json` — JSON seed database.
4. `package.json` — only runtime dependency is `@vercel/blob`.
5. `vercel.json` — function configuration.
6. `README.md` — this guide.

## Important about JSON persistence on Vercel

`db.json` is the seed file and local development database. **Vercel serverless functions cannot reliably persist edits to a project file across deployments/instances.** To save listings and orders in production while still storing the entire database as JSON, this project uses a **private Vercel Blob object** containing `idbazaar/database.json`. The API reads and writes JSON to that object. If Blob storage isn't configured in production, the sample catalogue can be read, but writes deliberately fail with a setup message rather than pretending data was saved.

## Deploy to Vercel

1. Extract the ZIP and upload these six files to the root of a GitHub repository.
2. Import that repository in [Vercel](https://vercel.com/dashboard). Use the **Other** framework preset. No build command or output folder is needed; keep the project root as the root directory.
3. In the Vercel project, open **Storage → Create Database → Blob** and create a **Private** Blob store. Connect it to this project.
4. In **Settings → Environment Variables**, set:

   - `BLOB_READ_WRITE_TOKEN` — the read/write token supplied for your Vercel Blob store.
   - `BOT_TOKEN` — the bot token from BotFather (required for Telegram-authenticated actions and notifications).
   - `ADMIN_TELEGRAM_ID` — your numeric Telegram user ID; this account gets the review queue.
   - `ADMIN_CHAT_ID` — the Telegram user/group ID receiving order and listing notifications. The bot must be able to message that chat.

5. Redeploy after adding the variables.
6. In BotFather, configure the Mini App / Menu Button URL to the HTTPS URL Vercel gave your project.
7. Open the mini app from that bot in Telegram. This is required for authenticated sell/order/admin actions.

Do not put real bot tokens or storage credentials in `index.html`, `db.json`, or a public GitHub repository.

## Local development

Use Node.js 22 or newer. From the project root:

```bash
npm install
npx vercel dev
```

For local persistence, the API writes to `db.json` while running outside production. To test protected actions in a regular browser without Telegram, create a local environment variable `ALLOW_DEMO_AUTH=true`; this shortcut is deliberately ignored in production. Do not deploy `ALLOW_DEMO_AUTH=true` as a production setting.

## How the JSON data works

`db.json` has the shape:

```json
{
  "version": 1,
  "listings": [],
  "orders": []
}
```

Listings submitted by users start in `pending` state. Only an admin whose Telegram ID matches `ADMIN_TELEGRAM_ID` can approve/reject them. Purchase buttons create a request and notify `ADMIN_CHAT_ID`; **the app does not collect payments, transfer ownership, or guarantee a transaction**.

## Safety and production notes

- The server validates Telegram `initData` using `BOT_TOKEN` and checks its age before accepting authenticated actions.
- Never ask users to enter passwords, one-time codes, recovery codes, cookies, or session tokens.
- Only list assets the seller owns and whose transfer is permitted by the relevant platform. Do not list stolen accounts, personal data, or items forbidden by platform rules.
- This single-JSON-file approach is suitable as a small starter. A high-volume marketplace needs a transactional database, proper rate limiting, anti-fraud review, dispute handling, and a real payment/escrow flow before handling actual transactions.
