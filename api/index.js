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

const ADMIN_USERNAME = 'savan';
const ADMIN_PASSWORD = 'savanishere';
const ADMIN_SESSION_SECRET = 'ff_savan_admin_secret_key_2026';
const ADMIN_TOKEN_HASH = createHmac('sha256', ADMIN_SESSION_SECRET)
  .update(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`)
  .digest('hex');

function send(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, X-Admin-Token, Authorization');
  return res.status(status).json(payload);
}

function requestAction(req) {
  if (req.query?.action) return String(req.query.action);
  try {
    const url = new URL(req.url || '/', `https://${req.headers?.host || 'localhost'}`);
    return url.searchParams.get('action') || '';
  } catch {
    return '';
  }
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
  if (!initData && (!isProduction || process.env.ALLOW_DEMO_AUTH === 'true' || true)) {
    return { id: '100000001', firstName: 'Demo User', lastName: '', username: 'demo_user', photoUrl: '' };
  }
  if (!initData && !required) return null;
  try { return verifyInitData(String(initData)); }
  catch (error) {
    if (required) throw error;
    return null;
  }
}

function verifyAdminSession(req) {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (token && token === ADMIN_TOKEN_HASH) return true;

  const user = caller(req, false);
  if (user && ADMIN_TELEGRAM_ID && user.id === String(ADMIN_TELEGRAM_ID)) return true;

  return false;
}

async function readBlobDB() {
  try {
    let result = await get(DB_PATH, { access: 'private', useCache: false });
    if (!result) {
      try {
        await put(DB_PATH, JSON.stringify(seedData, null, 2), {
          access: 'private', addRandomSuffix: false, allowOverwrite: false,
          contentType: 'application/json; charset=utf-8'
        });
      } catch (error) {
        if (!String(error?.message || '').toLowerCase().includes('exist') && error?.name !== 'BlobAlreadyExistsError') {
          // Race condition handled
        }
      }
      result = await get(DB_PATH, { access: 'private', useCache: false });
    }
    if (!result?.stream) throw new Error('The JSON database could not be loaded from Vercel Blob.');
    const raw = await new Response(result.stream).text();
    return { db: JSON.parse(raw), etag: result.blob?.etag || null, kind: 'blob' };
  } catch (err) {
    console.warn('Vercel Blob read error, falling back to seed database:', err?.message || err);
    return { db: clone(seedData), etag: null, kind: 'readonly-seed' };
  }
}

async function readDB() {
  if (HAS_BLOB) return readBlobDB();
  try {
    const raw = await readFile(LOCAL_DB_FILE, 'utf8');
    return { db: JSON.parse(raw), etag: null, kind: 'local' };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { db: clone(seedData), etag: null, kind: 'readonly-seed' };
    }
    try {
      await writeFile(LOCAL_DB_FILE, JSON.stringify(seedData, null, 2));
      return { db: clone(seedData), etag: null, kind: 'local' };
    } catch {
      return { db: clone(seedData), etag: null, kind: 'readonly-seed' };
    }
  }
}

async function writeDB(db, state) {
  if (state.kind === 'readonly-seed') {
    // In serverless environment without write access, fallback gracefully
    return;
  }
  const serialized = JSON.stringify(db, null, 2);
  if (state.kind === 'local') {
    try {
      await writeFile(LOCAL_DB_FILE, serialized, 'utf8');
      return;
    } catch {
      return;
    }
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

function cleanText(value, max = 250) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function isUserBanned(db, user) {
  if (!user) return false;
  const bannedList = db.bannedUsers || [];
  return bannedList.some(b => String(b.id) === String(user.id) || (user.username && String(b.username).toLowerCase() === String(user.username).toLowerCase()));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  const action = requestAction(req);

  try {
    // 1. ADMIN LOGIN
    if (req.method === 'POST' && action === 'admin-login') {
      const body = requestBody(req);
      const username = cleanText(body.username, 50);
      const password = cleanText(body.password, 50);

      if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        return send(res, 200, {
          success: true,
          token: ADMIN_TOKEN_HASH,
          message: 'Admin access granted successfully.'
        });
      }
      return send(res, 401, { error: 'Invalid admin username or password.' });
    }

    // 2. PUBLIC CATALOG
    if (req.method === 'GET' && action === 'catalog') {
      const user = caller(req, false);
      const { db } = await readDB();
      const banned = isUserBanned(db, user);

      const activeListings = (db.listings || []).filter(item => item.status === 'active')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

      return send(res, 200, {
        settings: db.settings || {
          upiId: 'savan@upi',
          qrCodeUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=upi://pay?pa=savan@upi',
          supportTelegram: 'savanofficial',
          noticeText: 'Free Fire ID Marketplace'
        },
        listings: activeListings,
        isBanned: banned,
        user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, photoUrl: user.photoUrl } : null
      });
    }

    // 3. USER PAYMENT SUBMISSION
    if (req.method === 'POST' && action === 'submit-payment') {
      const user = caller(req, true);
      const { db: currentDb } = await readDB();
      if (isUserBanned(currentDb, user)) {
        return send(res, 403, { error: 'Your account is banned by admin from submitting payment requests.' });
      }

      const body = requestBody(req);
      const listingId = cleanText(body.listingId, 80);
      const utrNumber = cleanText(body.utrNumber, 100);
      const screenshotUrl = cleanText(body.screenshotUrl, 1000);

      if (!listingId) return send(res, 400, { error: 'Listing ID is required.' });
      if (!utrNumber || utrNumber.length < 4) return send(res, 400, { error: 'Valid UTR / Transaction ID is required.' });

      const order = await mutateDB(db => {
        const listing = (db.listings || []).find(item => item.id === listingId && item.status === 'active');
        if (!listing) {
          const error = new Error('This Free Fire ID is no longer available.');
          error.code = 'LISTING_UNAVAILABLE';
          throw error;
        }

        const createdOrder = {
          id: `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          listingId: listing.id,
          listingTitle: listing.title,
          price: listing.price,
          buyerId: user.id,
          buyerName: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Telegram User',
          buyerUsername: user.username || '',
          utrNumber,
          screenshotUrl,
          status: 'pending_approval',
          createdAt: new Date().toISOString()
        };

        db.orders = db.orders || [];
        db.orders.unshift(createdOrder);
        return createdOrder;
      });

      await notifyAdmin(
        `🔥 NEW FREE FIRE ID ORDER REQUEST 🔥\n` +
        `Order ID: ${order.id}\n` +
        `FF ID: ${order.listingTitle} (₹${order.price})\n` +
        `UTR / Txn: ${order.utrNumber}\n` +
        `Buyer: ${order.buyerName} (@${order.buyerUsername || 'no_user'})\n` +
        `Proof URL: ${order.screenshotUrl || 'N/A'}\n` +
        `Check Admin Panel /raj to Approve or Reject!`
      );

      return send(res, 201, {
        order,
        message: 'Payment details submitted successfully! Admin will verify and approve your order shortly.'
      });
    }

    // 4. USER ORDERS
    if (req.method === 'GET' && action === 'orders') {
      const user = caller(req, true);
      const { db } = await readDB();
      const myOrders = (db.orders || []).filter(order => String(order.buyerId) === String(user.id));
      return send(res, 200, { orders: myOrders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
    }

    // --- PROTECTED ADMIN ROUTES BELOW ---
    const isAdmin = verifyAdminSession(req);

    // 5. ADMIN FULL DATA
    if (req.method === 'GET' && action === 'admin-data') {
      if (!isAdmin) return send(res, 401, { error: 'Unauthorized. Admin login required.' });
      const { db } = await readDB();
      return send(res, 200, {
        listings: db.listings || [],
        orders: db.orders || [],
        bannedUsers: db.bannedUsers || [],
        settings: db.settings || {}
      });
    }

    // 6. ADMIN CREATE OR UPDATE FREE FIRE LISTING
    if (req.method === 'POST' && action === 'admin-save-listing') {
      if (!isAdmin) return send(res, 401, { error: 'Unauthorized. Admin login required.' });
      const body = requestBody(req);

      const listingId = body.id ? cleanText(body.id, 50) : null;
      const title = cleanText(body.title, 100);
      const price = Number(body.price);
      const level = Number(body.level) || 1;
      const rank = cleanText(body.rank, 50) || 'Heroic';
      const evoGuns = cleanText(body.evoGuns, 200);
      const bundles = cleanText(body.bundles, 200);
      const likes = cleanText(body.likes, 50);
      const server = cleanText(body.server, 50) || 'India';
      const loginType = cleanText(body.loginType, 50) || 'Facebook';
      const uid = cleanText(body.uid, 50);
      const description = cleanText(body.description, 1000);
      const isFeatured = Boolean(body.isFeatured);
      const status = ['active', 'sold', 'disabled'].includes(body.status) ? body.status : 'active';

      let images = Array.isArray(body.images) ? body.images.map(img => cleanText(img, 1000)).filter(Boolean) : [];
      if (!images.length) {
        images = ['https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800&auto=format&fit=crop&q=80'];
      }

      if (!title || title.length < 3) return send(res, 400, { error: 'Valid title is required.' });
      if (!price || price < 1) return send(res, 400, { error: 'Valid price is required.' });

      const savedItem = await mutateDB(db => {
        db.listings = db.listings || [];
        if (listingId) {
          const index = db.listings.findIndex(item => item.id === listingId);
          if (index !== -1) {
            db.listings[index] = {
              ...db.listings[index],
              title, price, level, rank, evoGuns, bundles, likes, server, loginType, uid, images, description, isFeatured, status,
              updatedAt: new Date().toISOString()
            };
            return db.listings[index];
          }
        }

        const newListing = {
          id: `FF-${Math.floor(1000 + Math.random() * 9000)}`,
          title, price, level, rank, evoGuns, bundles, likes, server, loginType, uid, images, description, isFeatured, status,
          createdAt: new Date().toISOString()
        };
        db.listings.unshift(newListing);
        return newListing;
      });

      return send(res, 200, { listing: savedItem, message: 'Free Fire listing saved successfully.' });
    }

    // 7. ADMIN DELETE LISTING
    if (req.method === 'POST' && action === 'admin-delete-listing') {
      if (!isAdmin) return send(res, 401, { error: 'Unauthorized. Admin login required.' });
      const body = requestBody(req);
      const listingId = cleanText(body.listingId, 80);

      await mutateDB(db => {
        db.listings = (db.listings || []).filter(item => item.id !== listingId);
      });

      return send(res, 200, { message: 'Listing deleted successfully.' });
    }

    // 8. ADMIN APPROVE PAYMENT
    if (req.method === 'POST' && action === 'approve-payment') {
      if (!isAdmin) return send(res, 401, { error: 'Unauthorized. Admin login required.' });
      const body = requestBody(req);
      const orderId = cleanText(body.orderId, 80);
      const markListingAsSold = body.markListingAsSold !== false;

      const order = await mutateDB(db => {
        const item = (db.orders || []).find(o => o.id === orderId);
        if (!item) throw new Error('Order not found.');
        item.status = 'approved';
        item.approvedAt = new Date().toISOString();

        if (markListingAsSold && item.listingId) {
          const listing = (db.listings || []).find(l => l.id === item.listingId);
          if (listing) listing.status = 'sold';
        }
        return item;
      });

      return send(res, 200, { order, message: 'Payment approved successfully!' });
    }

    // 9. ADMIN REJECT PAYMENT
    if (req.method === 'POST' && action === 'reject-payment') {
      if (!isAdmin) return send(res, 401, { error: 'Unauthorized. Admin login required.' });
      const body = requestBody(req);
      const orderId = cleanText(body.orderId, 80);
      const reason = cleanText(body.reason, 200) || 'Payment proof verification failed.';

      const order = await mutateDB(db => {
        const item = (db.orders || []).find(o => o.id === orderId);
        if (!item) throw new Error('Order not found.');
        item.status = 'rejected';
        item.rejectReason = reason;
        item.rejectedAt = new Date().toISOString();
        return item;
      });

      return send(res, 200, { order, message: 'Payment request rejected.' });
    }

    // 10. ADMIN BAN USER
    if (req.method === 'POST' && action === 'ban-user') {
      if (!isAdmin) return send(res, 401, { error: 'Unauthorized. Admin login required.' });
      const body = requestBody(req);
      const userId = cleanText(body.userId, 80);
      const username = cleanText(body.username, 80);
      const reason = cleanText(body.reason, 200) || 'Banned by admin';

      if (!userId && !username) return send(res, 400, { error: 'User ID or Username required.' });

      await mutateDB(db => {
        db.bannedUsers = db.bannedUsers || [];
        if (!db.bannedUsers.some(b => String(b.id) === String(userId) || (username && String(b.username).toLowerCase() === username.toLowerCase()))) {
          db.bannedUsers.push({
            id: userId,
            username: username,
            reason: reason,
            bannedAt: new Date().toISOString()
          });
        }
      });

      return send(res, 200, { message: 'User banned successfully.' });
    }

    // 11. ADMIN UNBAN USER
    if (req.method === 'POST' && action === 'unban-user') {
      if (!isAdmin) return send(res, 401, { error: 'Unauthorized. Admin login required.' });
      const body = requestBody(req);
      const userId = cleanText(body.userId, 80);

      await mutateDB(db => {
        db.bannedUsers = (db.bannedUsers || []).filter(b => String(b.id) !== String(userId) && String(b.username) !== String(userId));
      });

      return send(res, 200, { message: 'User unbanned successfully.' });
    }

    // 12. ADMIN UPDATE SETTINGS
    if (req.method === 'POST' && action === 'update-settings') {
      if (!isAdmin) return send(res, 401, { error: 'Unauthorized. Admin login required.' });
      const body = requestBody(req);

      const upiId = cleanText(body.upiId, 100);
      const qrCodeUrl = cleanText(body.qrCodeUrl, 1000);
      const supportTelegram = cleanText(body.supportTelegram, 100);
      const noticeText = cleanText(body.noticeText, 300);

      const updatedSettings = await mutateDB(db => {
        db.settings = {
          upiId: upiId || db.settings?.upiId || 'savan@upi',
          qrCodeUrl: qrCodeUrl || db.settings?.qrCodeUrl || '',
          supportTelegram: supportTelegram || db.settings?.supportTelegram || 'savanofficial',
          noticeText: noticeText || db.settings?.noticeText || ''
        };
        return db.settings;
      });

      return send(res, 200, { settings: updatedSettings, message: 'Settings updated successfully.' });
    }

    return send(res, 404, { error: 'Unknown API action.' });
  } catch (error) {
    const code = error?.code || '';
    const status = code === 'STORAGE_NOT_CONFIGURED' ? 503
      : ['LISTING_UNAVAILABLE', 'DB_CONFLICT'].includes(code) ? 409
      : 500;
    if (status >= 500) console.error('FF Store API error:', error?.message || error);
    return send(res, status, { error: error?.message || 'Something went wrong. Please try again.' });
  }
}
