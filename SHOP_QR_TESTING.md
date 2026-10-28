# Shop-specific Customer QR — Demo Setup

This change creates a stable public QR URL **for each shop** and an associated public customer print-preview page.

## What changes

- Existing and new shops receive unique 32-character public codes in PostgreSQL.
- Shop-only `GET /api/shop/me` now includes `shop.publicCode` for the logged-in shop.
- The shop dashboard's QR and **Copy link** action now target `/print.html?shop=<publicCode>`.
- Public `GET /api/public/shops/:code` provides only the shop name and public code (never the owner email or password).
- `/print.html` displays the correct shop name and a disabled print-upload demo.
- Customer Login, Shop Login, and private dashboards remain separate.

## Test after deploy

1. Open the **Render** URL `https://qr-to-print-new.onrender.com/shop-login.html` and log in with your test shop account.
2. On `/shop-dashboard.html`, confirm the QR image loads and **Open shop print page** opens the new page.
3. The print page should show your own shop name; it must not show another shop's private information.
4. Scan the QR with your phone and verify the same shop name appears.
5. Copy the link, sign out, and open it in a private browser: the public print-preview page should still display the shop name without requiring shop login.
6. Reload the shop dashboard after signing in again. The copied link should remain the same.
7. Verify `/api/shop/me` returns HTTP 401 when logged out.
8. Confirm the existing Customer Login and Shop Login still work.

The Print Upload button is **disabled by design**: no customer documents, real print jobs or payment details are collected, stored or transmitted by this page.

## Deployment and limitations

- Database migration runs as part of app startup. PostgreSQL 18 provides `gen_random_uuid()`.
- The existing Render environment variables `DATABASE_URL`, `SESSION_SECRET` and `NODE_ENV=production` remain required. No new secrets needed.
- Avoid putting real customer information in a preview; Render free PostgreSQL is not durable production storage.
- This is **not yet a complete QR-to-printer workflow**. File storage, shop-linked order APIs, printer agent, payment processing and robust operational controls remain to be built.
- Use the **Render host**, not the GitHub Pages host. GitHub Pages cannot serve the shop lookup API.
- QR images are requested through a third-party QR generation endpoint. Public shop-link URLs (not passwords) are sent to that provider.

## Privacy

The public QR code is a shareable identifier, not an authorization credential. Public lookups return only the shop name; shop-owner authentication remains required for private account and dashboard data.
