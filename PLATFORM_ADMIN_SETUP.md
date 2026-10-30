# QR-To-Print • Multi-Shop Super Admin (TEST/FOUNDATION)

This feature lets the platform operator sell/approve QR-To-Print accounts for other print shop owners. It adds a **separate Super Admin role**, shop approvals, plan dates, renewals and suspensions. It does **not** turn the existing sample-file prototype into a fully secure production print service.

## Roles

| Role | Sign-in | Access |
| --- | --- | --- |
| Platform Super Admin | /admin-login.html | Manage shops, approve/renew/suspend plans, view subscription activity |
| Shop Owner | /shop-login.html | Own QR, shop dashboard, own test orders, own rates and bills |
| Customer/Guest | Shop-specific QR | Shop name/rates and disposable test uploads if explicitly enabled |

The admin panel does not download shop customers' PDF uploads or expose customer document contents.

## Set up the Super Admin privately on Render

1. Merge and deploy this PR. Existing shop accounts stay active on a legacy plan with no expiry.
2. On your Windows computer, open the repository directory from GitHub (clone or download ZIP) and run: **npm install**.
3. In PowerShell, run: **node scripts/generate-admin-hash.js**. Enter a strong new password, minimum 12 characters. It is typed invisibly. Copy only the resulting bcrypt hash into Render, never into chat.
4. In Render Dashboard → Web Service → Environment add:
   - **PLATFORM_ADMIN_EMAIL** — your personal administrator email address (not a shared shop login).
   - **PLATFORM_ADMIN_PASSWORD_HASH** — the entire bcrypt hash generated locally, including the $2b$ prefix.
5. Save/deploy your Render environment changes, then go to **https://qr-to-print-new.onrender.com/admin-login.html** and sign in with the chosen email and the ORIGINAL password, not the hash.
6. After login, open **/admin-dashboard.html** to see registered shops and pending approvals.

If the environment variables are not configured, the Super Admin sign-in fails closed. Keep these secrets out of GitHub, screenshots and chat.

## Sell an account to a shop

1. Send the new shop owner **https://qr-to-print-new.onrender.com/shop-login.html**.
2. They click **Create Shop**, fill their own name, shop name, email and password.
3. New shop starts **Pending**, unable to log into a shop dashboard or accept test uploads.
4. You sign in to **/admin-dashboard.html** and find the new pending shop.
5. Choose a plan from **Starter ₹49/month, Pro ₹99/month, Business ₹199/month, Pay Per Page ₹0.15/page, or Demo (one-time, 10 free printed pages)**. Duration for monthly plans: 30/90/365 days, priced as 1/3/12 months. Demo lasts 30 days or until 10 manually confirmed printed pages are used. Enter **actual received money** only after independent confirmation; use ₹0 + No payment for a trial or an unpaid plan.
6. Press **Activate shop**. Owner can then log in, get a unique shop QR and set their own rates.
7. Use **Renew / Extend plan** when renewing or **Suspend shop** when disabling access. Expiry and suspension stop owner APIs and QR customer requests, including existing active sessions.

Plan names remain feature-access labels; they do not unlock separate feature tiers yet. Monthly listed rates are fixed in the server catalogue. The admin panel calculates a **plan quote** but records separately the **amount actually received**. This is not an online charge, invoice, or proof of payment.

## Published plan catalogue

| Plan | Price | Duration / usage |
| --- | ---: | --- |
| Starter | ₹49 per nominal month | 30/90/365 days => ₹49/₹147/₹588 |
| Pro | ₹99 per nominal month | 30/90/365 days => ₹99/₹297/₹1,188 |
| Business | ₹199 per nominal month | 30/90/365 days => ₹199/₹597/₹2,388 |
| Pay Per Page | ₹0.15 (15 paise) per printed page | No monthly base charge, admin manually records confirmed pages |
| Demo | ₹0 | One-time 30-day trial, max 10 manually confirmed printed pages |

**Important Demo limitation:** This is a manual/test implementation, not a tamper-proof printer meter. An admin enters the **actual page count printed** under each active Demo shop via **Record Demo printed pages**. The server refuses entries that exceed the lifetime 10-page quota and blocks **new customer QR API requests** after all 10 confirmed pages are recorded. The Canon test print agent does **not** automatically report page counts or stop external/manual printing. Confirm a page count from real paper output, never from file size or an unverified customer request. A shop gets a Demo grant at most once, even if expired. Existing Demo printing outside the manual count cannot be reliably tracked.

**Pay Per Page limitation:** The admin manually records printed pages and the server calculates 15 paise/page. The fee remains **unpaid** until cash/UPI receipt is separately confirmed. Recording usage does not debit a shop or verify a transaction. No automated metering, wallet, recharge or tax processing is implemented.

## What the admin can see

- Registered shop name, owner name/email, plan, expiry, status and shop ID
- Aggregate test order and bill counts (no customer files)
- Five plan price cards with 30/90/365-day quote preview
- Demo shop used/remaining pages (out of 10) and manual confirmed page recording
- Pay Per Page manually confirmed usage and unpaid/paid charge history
- Total shops, active shops and pending approvals
- Activate/renew/suspend controls
- Manual Cash/UPI amount confirmed received and subscription event history

## Shop-owner Subscription Payments: UPI QR + Paytm

Checkout: **https://qr-to-print-new.onrender.com/subscription-payment.html**. Pending shops can sign in with their owner email/password to a **billing-only session**, which does not grant shop-dashboard access. Active owners may renew the same way.

**Checkout prices:** Starter ₹49/₹147/₹588, Pro ₹99/₹297/₹1188, Business ₹199/₹597/₹2388 for 30/90/365 days. These are one-time plan purchases, not automatic monthly debits. Demo (10 free pages) and Pay Per Page (₹0.15 per page) remain manually administered.

### UPI QR (manual receipt)

In Render → Web Service → Environment set two values:
- **UPI_PAYMENT_VPA**: your own verified UPI ID. Example merchant@bank is a placeholder, not an account to use.
- **UPI_PAYMENT_NAME**: your registered beneficiary/payee name.

The owner selects a plan, receives a QR for the server-calculated amount, pays from a UPI app, and submits a UTR. A UTR alone is **NOT payment verification**. Super Admin must independently verify the amount received in their own bank/UPI account, then choose **Verify bank receipt & Activate**. Reject unverified claims. No automatic UPI payment confirmation or debit is performed.

### Paytm Payment Gateway (server-confirmed payment)

Use your own Paytm PG merchant account and get staging/live credentials through the [Paytm Merchant Dashboard](https://dashboard.paytmpayments.com/next/apikeys). Configure on Render **only**, never in GitHub/chat:
- **PAYTM_MID**: merchant ID for test/live environment
- **PAYTM_MERCHANT_KEY**: secret merchant key, server-side only
- **PAYTM_ENV**: test (default) or live (only after merchant account activation)
- **PAYTM_WEBSITE_NAME**: WEBSTAGING in test; your Paytm-issued website name (often DEFAULT) in live
- **PUBLIC_BASE_URL**: https://qr-to-print-new.onrender.com (or your public HTTPS origin)

Paytm checkout:
1. Creates a pending payment order with a server-calculated price, with a unique order ID.
2. Calls Paytm **Initiate Transaction API** with a checksum signature created by the official paytmchecksum package.
3. Opens Paytm JS Checkout using MID + transaction token, never your Merchant Key.
4. Uses a signed Paytm callback at **/api/payments/paytm/callback**, plus shop-owner/Admin **Check Paytm Status** buttons to reconcile.
5. Independently calls Paytm **Transaction Status API**, validates the signed response, order ID, merchant, exact INR amount and test/live mode.
6. For **verified Live TXN_SUCCESS only**, marks the payment as paid and activates/extends the subscription in one database transaction. Repeat checks cannot extend a plan twice. TEST payments are recorded as test_paid, with **no live activation**.

No payment is collected by the site until you configure real UPI details or your own Paytm merchant credentials. The two methods are not interchangeable: QR needs manual review, whereas Paytm uses gateway verification. Fees, GST/taxes, refunds, chargebacks, disputes, password resets and merchant onboarding remain independent setup tasks. Always test with staging credentials before enabling live.

## Safety and launch limitations

- Current shop accounts are grandfathered as active legacy accounts; new registration is pending.
- No auto-deletion on suspension; existing test files retain the one-day private R2 expiry policy.
- Shop/session and shop-specific QR requests are checked against active subscription state.
- A separate admin session is required. Shop-owner/customer accounts have no admin privileges.
- Paytm payment gateway requires independent merchant onboarding and staging/live verification; UPI QR still requires manual receipt checks. No recurring autopay, automatic UPI verification, refund/reconciliation automation, password reset, email verification, true printer page-count hardware enforcement, live print-job automation, malware scanning, full accounting or GST invoicing is implemented.
- Real commercial selling requires further security/privacy reviews, operational monitoring, backups, recovery, tax/compliance and real customer printing protections. **Do not upload real Aadhaar or any sensitive ID/document into the current disposable test system.**
