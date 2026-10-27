# QR-To-Print — Shop Owner Login (Preview)

This change adds a **separate shop-owner account system** to the existing Node.js/Express + PostgreSQL application. It is for evaluation and testing only.

## Where to open it

Use the **Render** web-service domain (not the GitHub Pages static domain):

- Shop registration/login: `https://qr-to-print-new.onrender.com/shop-login.html`
- Protected shop dashboard: `https://qr-to-print-new.onrender.com/shop-dashboard.html`
- Existing customer login remains at `/login.html`.

## After deployment

1. Ensure Render already has `DATABASE_URL`, `SESSION_SECRET` (at least 32 characters) and `NODE_ENV=production`. Never put secret values into GitHub.
2. Render deploys the updated code. The server creates `shops` and `shop_owners` tables at startup; the existing `customers` table and session table remain.
3. Open `/shop-dashboard.html` in a private window: it should redirect to `/shop-login.html`.
4. At `/shop-login.html`, use **Create Shop** to create a test-only shop with a fresh email and a unique password of at least 12 characters.
5. Log in, verify the shop name appears on the sidebar, refresh, then log out.
6. Open `/api/shop/me` while logged out: it should return HTTP 401. Log back in and it should return only the current shop owner's name/email and shop's name/ID.

## APIs

- `POST /api/shop/register` — registers a new test shop and owner.
- `POST /api/shop/login` — creates a new shop-only session.
- `GET /api/shop/me` — authenticated owner profile and shop ID.
- `POST /api/shop/logout` — destroys the active session.

Registration and login accept JSON. State-changing APIs require a same-origin `Origin` header, and registration/login are rate-limited. Password hashes are stored using bcrypt, not plaintext. Session IDs are rotated on login and session records remain in PostgreSQL.

The previous customer login APIs, frontend, and `/dashboard.html` still exist. Logging in as a shop owner replaces any current customer session in the browser, and vice versa.

## Not ready for commercial production

- Email verification and password reset are not implemented.
- More sophisticated anti-abuse protection, alerting, monitoring and backup/recovery still need work.
- Render's free PostgreSQL database has an expiration period and should not be used for live customer/shop data.
- Printer agent, file storage, per-shop customer QR routing, print orders, payments and wallet are **not connected**.
- The existing shop dashboard is a **design preview** with placeholder metrics.
- The public GitHub Pages copy is a static-only frontend and **cannot provide secure authentication or the backend APIs**.

Do not enroll real shops, upload sensitive print documents or collect payment until these controls and persistent storage are in place.
