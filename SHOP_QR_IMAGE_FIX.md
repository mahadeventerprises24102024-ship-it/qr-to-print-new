# Shop QR Image Fix

## Problem

On the Shop Dashboard, **Mahadev Enterprises** and the Copy link button can appear but the QR graphic may be blank. The old image used an external provider (`api.qrserver.com`), which can be blocked or fail to load.

## Change

- Generate the QR PNG in **our own Render Node.js backend** using the `qrcode` npm package.
- Private `GET /api/shop/qr.png` requires an authenticated shop-owner session. It obtains the shop's `public_code` from PostgreSQL and encodes the customer's public print-page URL.
- The dashboard image now loads from `/api/shop/qr.png` instead of the third-party service.
- If the image fails, a clear fallback message tells owners to use **Open shop print page** or **Copy link**.

## How to test after deployment

1. Check Render shows **Live** and no new runtime errors.
2. Open `https://qr-to-print-new.onrender.com/shop-dashboard.html` and sign in as a test shop owner if needed.
3. Press **Ctrl+Shift+R** on desktop to reload the page.
4. Confirm the black-and-white QR image is visible near **Scan. Upload. Print.**
5. Use **Copy link**, paste it in another browser tab, and check it shows the expected test shop name.
6. Scan the QR from the computer screen with a phone camera. Confirm the same URL/shop name opens.
7. Logout, then visit `/api/shop/qr.png`; it should return 401 instead of an image. Public print page remains accessible without shop login.

## Notes

- Default public link origin is `https://qr-to-print-new.onrender.com`.
- If you later connect a custom production domain, set `PUBLIC_BASE_URL` to its HTTPS origin.
- No printer, wallet, payment or file-upload functionality was enabled by this QR-only fix. Print page remains a demo.
- Only use test shops while running Render's temporary Free PostgreSQL database.
