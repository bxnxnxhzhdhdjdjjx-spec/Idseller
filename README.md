# Free Fire ID Store — Telegram Mini App & Admin Panel

A modern, highly advanced Free Fire account marketplace Telegram Mini App with an integrated Admin Panel.

## Features

- **Exclusive Free Fire Theme**: Modern dark esports UI with gaming orange (`#ff5500`), gold accents, rank badges, level indicators, evo gun tags, and responsive design.
- **Dedicated Admin Route `/raj`**:
  - Access URL ending with `/raj` or `#raj` to open the Admin Panel authentication modal.
  - Required Login Credentials:
    - **Username**: `savan`
    - **Password**: `savanishere`
  - Highly Advanced Admin Dashboard:
    - View live sales revenue, active listings, pending payment orders, and banned users.
    - Full CRUD management of Free Fire account listings (multiple image URLs, level, rank, evo guns, bundles, likes, server, login type, UID, full description).
    - Payment Approval / Rejection Queue.
    - User Ban / Unban control.
    - Store Settings (UPI ID, QR Code image URL, Support Telegram username, Top notice banner text).
- **User Mini App Experience**:
  - Browse verified Free Fire accounts with rank filter chips (Grandmaster, Heroic, Diamond, All).
  - Account detail view with multi-image gallery carousel and full specifications.
  - Payment Modal with Admin QR Code, UPI ID copy button, UTR / Transaction ID submission.
  - "My Orders" tab tracking real-time order approval/rejection status.
  - Instant ban enforcement if a user is banned by admin.

## API Setup & Vercel Deployment

Set environment variables on Vercel:
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob store token for database persistence.
- `BOT_TOKEN` — Telegram Bot Token.
- `ADMIN_CHAT_ID` — Telegram Chat ID for instant admin notifications on new orders.
