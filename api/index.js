import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { get, put } from '@vercel/blob';
import seedData from '../db.json' with { type: 'json' };

const DB_PATH = 'idbazaar/database.json';
const LOCAL_DB_FILE = fileURLToPath(new URL('../db.json', import.meta.url));
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';
const HAS_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const isProduction = process.env.NODE_ENV === 'production';
const clone = value => JSON.parse(JSON.stringify(value));
const allowedCategories = new Set(['Gaming', 'Community', 'Creator', 'Other']);

function send(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(payload);
}

function requestAction(req) {
  if (req.query?.action) return String(req.query.action);
  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  return url.searchParams.get('action') || '';
}

function requestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

function verifyInitData(initData) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not configured on the server.');
  if (!initData || typeof initData !== 'string' || initData.length > 10000) {
    throw new Error('Open this mini app inside Telegram to continue.');
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new Error('Telegram authentication could not be verified.');
  }

  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) {
    throw new Error('Telegram session expired. Close and reopen the mini app.');
  }

  const checkString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(checkString).digest();
  const suppliedHash = Buffer.from(receivedHash, 'hex');
  if (suppliedHash.length !== calculatedHash.length || !timingSafeEqual(suppliedHash, calculatedHash)) {
    throw new Error('Telegram authentication could not be verified.');
  }

  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  if (!user || !Number.isSafeInteger(Number(user.id))) throw new Error('Telegram user data is missing.');
  return {
    id: String(user.id),
    firstName: String(user.first_name || 'Telegram user').slice(0, 80),
    lastName: String(user.last_name || '').slice(0, 80),
    username: String(user.username || '').slice(0, 64),
    photoUrl: typeof user.photo_url === 'string' ? user.photo_url.slice(0, 1000) : ''
  };
}

function caller(req, required = false) {
  const initData = req.headers['x-telegram-init-data'] || '';
  if (!initData && !isProduction && process.env.ALLOW_DEMO_AUTH === 'true') {
    return { id: '100000001', firstName: 'Demo User', lastName: '', username: 'demo_user', photoUrl: '' };
  }
  if (!initData && !required) return null;
  try { return verifyInitData(String(initData)); }
  catch (error) {
    if (required) throw error;
    return null;
  }
}

function isAdmin(user) {
  return Boolean(user && ADMIN_TELEGRAM_ID && user.id === String(ADMIN_TELEGRAM_ID));
}

async function readBlobDB() {
  let result = await get(DB_PATH, { access: 'private', useCache: false });
  if (!result) {
    try {
      await put(DB_PATH, JSON.stringify(seedData, null, 2), {
        access: 'private', addRandomSuffix: false, allowOverwrite: false,
        contentType: 'application/json; charset=utf-8'
      });
    } catch (error) {
      // Another request may have initialized the same file first. Read it below.
      if (!String(error?.message || '').toLowerCase().includes('exist') && error?.name !== 'BlobAlreadyExistsError') {
        // A subsequent read gives a clearer error if this was not an initialization race.
      }
    }
    result = await get(DB_PATH, { access: 'private', useCache: false });
  }
  if (!result?.stream) throw new Error('The JSON database could not be loaded from Vercel Blob.');
  const raw = await new Response(result.stream).text();
  return { db: JSON.parse(raw), etag: result.blob?.etag || null, kind: 'blob' };
}

async function readDB() {
  if (HAS_BLOB) return readBlobDB();
  if (!isProduction) {
    try {
      const raw = await readFile(LOCAL_DB_FILE, 'utf8');
      return { db: JSON.parse(raw), etag: null, kind: 'local' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(LOCAL_DB_FILE, JSON.stringify(seedData, null, 2));
      return { db: clone(seedData), etag: null, kind: 'local' };
    }
  }
  return { db: clone(seedData), etag: null, kind: 'readonly-seed' };
}

async function writeDB(db, state) {
  if (state.kind === 'readonly-seed') {
    const error = new Error('Persistent storage is not configured. Add a private Vercel Blob store and BLOB_READ_WRITE_TOKEN.');
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  const serialized = JSON.stringify(db, null, 2);
  if (state.kind === 'local') {
    await writeFile(LOCAL_DB_FILE, serialized, 'utf8');
    return;
  }
  const options = {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json; charset=utf-8', cacheControlMaxAge: 60
  };
  if (state.etag) options.ifMatch = state.etag;
  await put(DB_PATH, serialized, options);
}

async function mutateDB(mutator) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readDB();
    const result = await mutator(state.db);
    try {
      await writeDB(state.db, state);
      return result;
    } catch (error) {
      const isConflict = error?.name === 'BlobPreconditionFailedError' || /precondition|etag|412/i.test(String(error?.message || ''));
      if (state.kind === 'blob' && isConflict && attempt < 2) continue;
      throw error;
    }
  }
  const error = new Error('The database changed at the same time. Please retry.');
  error.code = 'DB_CONFLICT';
  throw error;
}

async function notifyAdmin(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, disable_web_page_preview: true })
    });
  } catch (error) {
    console.error('Admin notification failed:', error?.message || error);
  }
}

function cleanText(value, max) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function publicListing(listing) {
  return {
    id: listing.id, title: listing.title, category: listing.category,
    description: listing.description, price: listing.price,
    sellerName: listing.sellerName, sellerUsername: listing.sellerUsername,
    status: listing.status, createdAt: listing.createdAt
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  const action = requestAction(req);

  try {
    if (req.method === 'GET' && action === 'catalog') {
      const user = caller(req, false);
      const { db } = await readDB();
      const active = (db.listings || []).filter(item => item.status === 'active').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const response = {
        listings: active.map(publicListing),
        categories: ['All', ...allowedCategories],
        isAdmin: isAdmin(user),
        user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, photoUrl: user.photoUrl } : null
      };
      if (response.isAdmin) response.pending = (db.listings || []).filter(item => item.status === 'pending').map(publicListing);
      return send(res, 200, response);
    }

    if (req.method === 'GET' && action === 'orders') {
      const user = caller(req, true);
      const { db } = await readDB();
      const ownListingIds = new Set((db.listings || []).filter(item => item.sellerId === user.id).map(item => item.id));
      const orders = (db.orders || []).filter(order => order.buyerId === user.id || ownListingIds.has(order.listingId));
      return send(res, 200, { orders: orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
    }

    if (req.method === 'GET' && action === 'admin') {
      const user = caller(req, true);
      if (!isAdmin(user)) return send(res, 403, { error: 'Admin access only.' });
      const { db } = await readDB();
      return send(res, 200, {
        pending: (db.listings || []).filter(item => item.status === 'pending'),
        orders: db.orders || []
      });
    }

    if (req.method === 'POST' && action === 'order') {
      const user = caller(req, true);
      const body = requestBody(req);
      const listingId = cleanText(body.listingId, 80);
      if (!listingId) return send(res, 400, { error: 'Choose a listing first.' });
      const order = await mutateDB(db => {
        const listing = (db.listings || []).find(item => item.id === listingId && item.status === 'active');
        if (!listing) { const error = new Error('This listing is no longer available.'); error.code = 'LISTING_UNAVAILABLE'; throw error; }
        if (String(listing.sellerId) === user.id) { const error = new Error('You cannot request your own listing.'); error.code = 'SELF_ORDER'; throw error; }
        const created = {
          id: `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          listingId: listing.id, listingTitle: listing.title, price: listing.price,
          buyerId: user.id, buyerName: [user.firstName, user.lastName].filter(Boolean).join(' '),
          buyerUsername: user.username, sellerId: listing.sellerId,
          status: 'requested', createdAt: new Date().toISOString()
        };
        db.orders = db.orders || [];
        db.orders.unshift(created);
        return created;
      });
      await notifyAdmin(`🛍 New IDBazaar purchase request\nOrder: ${order.id}\nItem: ${order.listingTitle}\nPrice: ₹${order.price}\nBuyer: ${order.buyerName}${order.buyerUsername ? ` (@${order.buyerUsername})` : ''}\nStatus: request only — no payment collected.`);
      return send(res, 201, { order, message: 'Purchase request sent. No payment has been collected.' });
    }

    if (req.method === 'POST' && action === 'sell') {
      const user = caller(req, true);
      const body = requestBody(req);
      const title = cleanText(body.title, 70);
      const category = cleanText(body.category, 20);
      const description = cleanText(body.description, 500);
      const price = Number(body.price);
      if (title.length < 4) return send(res, 400, { error: 'Title must be at least 4 characters.' });
      if (!allowedCategories.has(category)) return send(res, 400, { error: 'Choose a valid category.' });
      if (description.length < 12) return send(res, 400, { error: 'Description must be at least 12 characters.' });
      if (!Number.isInteger(price) || price < 1 || price > 1000000) return send(res, 400, { error: 'Price must be between ₹1 and ₹10,00,000.' });
      if (/password|otp|cookie|session token|recovery code|stolen|hacked/i.test(`${title} ${description}`)) {
        return send(res, 400, { error: 'Do not list passwords, login secrets, recovery codes, or stolen/hacked accounts.' });
      }
      const listing = await mutateDB(db => {
        db.listings = db.listings || [];
        const created = {
          id: `ID-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
          title, category, description, price, sellerId: user.id,
          sellerName: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Telegram seller',
          sellerUsername: user.username, status: 'pending', createdAt: new Date().toISOString()
        };
        db.listings.unshift(created);
        return created;
      });
      await notifyAdmin(`📥 New IDBazaar listing awaiting review\nID: ${listing.id}\nTitle: ${listing.title}\nCategory: ${listing.category}\nPrice: ₹${listing.price}\nSeller: ${listing.sellerName}${listing.sellerUsername ? ` (@${listing.sellerUsername})` : ''}\nOpen the app's admin view to approve or reject.`);
      return send(res, 201, { listing: publicListing(listing), message: 'Listing sent for admin review.' });
    }

    if (req.method === 'POST' && action === 'moderate') {
      const user = caller(req, true);
      if (!isAdmin(user)) return send(res, 403, { error: 'Admin access only.' });
      const body = requestBody(req);
      const listingId = cleanText(body.listingId, 80);
      const status = body.status === 'active' ? 'active' : body.status === 'rejected' ? 'rejected' : '';
      if (!listingId || !status) return send(res, 400, { error: 'Choose approve or reject.' });
      const listing = await mutateDB(db => {
        const item = (db.listings || []).find(entry => entry.id === listingId && entry.status === 'pending');
        if (!item) { const error = new Error('Pending listing not found. Refresh the page.'); error.code = 'LISTING_UNAVAILABLE'; throw error; }
        item.status = status;
        item.reviewedAt = new Date().toISOString();
        item.reviewedBy = user.id;
        return item;
      });
      return send(res, 200, { listing: publicListing(listing), message: status === 'active' ? 'Listing approved.' : 'Listing rejected.' });
    }

    return send(res, 404, { error: 'Unknown API action.' });
  } catch (error) {
    const code = error?.code || '';
    const status = code === 'STORAGE_NOT_CONFIGURED' ? 503
      : ['LISTING_UNAVAILABLE', 'DB_CONFLICT'].includes(code) ? 409
      : code === 'SELF_ORDER' ? 400
      : /BOT_TOKEN is not configured/i.test(error?.message || '') ? 503
      : /Open this mini app|Telegram authentication|Telegram session|Telegram user data/i.test(error?.message || '') ? 401
      : 500;
    if (status >= 500) console.error('IDBazaar API error:', error?.message || error);
    return send(res, status, { error: error?.message || 'Something went wrong. Please try again.' });
  }
}
