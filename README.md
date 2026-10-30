# QR-To-Print

QR-To-Print is a deployed Node.js/Express + PostgreSQL print-shop management portal.

**Public website:** https://qr-to-print-new.onrender.com/  
**Secure two-role login:** https://qr-to-print-new.onrender.com/access.html

## Working shop-management features

- **Super Admin:** platform shop approvals, subscriptions and manual payment review.
- **Shopkeeper:** private shop account, unique shop QR, shop-specific rates and order review, billing and print diagnostics.
- **Customer without login:** QR-specific *sample* print request, order ID and private tracking code.
- **QR generator:** general links and text, using an external QR-image service.
- **Testing:** shop PC local print preview and dummy sample front/back A4 layout.

The existing code still includes limited Paytm **sandbox** and UPI payment-claim workflows. A "paid" display from a customer claim is not proof of bank settlement; owners must verify credits directly.

## Critical distinction: live site ≠ production document printing

The website and supported shop-management UI can be online while the **customer document-upload and printer workflow remains sample-only**.

Do not use this app for real Aadhaar, PAN, identity documents or other sensitive customer files. Do not imply that automatically opening a browser print dialog is guaranteed silent/automatic printing. A shop owner must inspect sample paper output.

Before accepting genuine documents or commercial print orders, the deployment requires at least:

1. Private durable file storage with encryption review, strict access authorization, malware scanning/CDR, data minimization, and automatic retention/deletion verified in production.
2. Trustworthy settlement reconciliation, refunds/failed-payment workflows, auditing and appropriate privacy/legal review.
3. Printer isolation, reliable queue state, safe preview/rendering and confirmation of physical prints.
4. Production-grade operational monitoring, backups, recovery and durable PostgreSQL.

**Do not turn off the sample-only warnings as a substitute for these controls.**

## Local development

Install Node.js 20+ and PostgreSQL. From the repository root:

```sh
npm install
npm test
npm start
```

Set `DATABASE_URL` and a `SESSION_SECRET` at least 32 characters long. Keep credentials in environment settings, not GitHub.

See `PLATFORM_ADMIN_SETUP.md`, `SHOP_AUTH_SETUP.md`, `PRIVATE_TEST_UPLOAD_SETUP.md` and `UPI_PRINT_PAYMENT_SETUP.md` for the specific limited workflows and their security prerequisites.

## Deployment

The Render web service follows the repository's `main` branch with **automatic deploy on commits**. Wait for its deployment status to be **Live**, and verify the site and `/api/health` after each change. Do not trigger a duplicate manual deployment when auto-deploy has already started.

Note: GitHub Pages can publish the static HTML but cannot run the backend API, PostgreSQL sessions or shop data.
