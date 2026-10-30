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

## Shop Owner Payment via UPI QR (manual bank verification only)

UPI checkout: **https://qr-to-print-new.onrender.com/subscription-payment.html**

Newly registered shops are **pending**, so the checkout has a **billing-only login** using their shop-owner email/password. This session does **not** grant access to the shop dashboard. Existing active shops can use it to renew.

The platform itself calculates the payment amount from the subscription plan, never from untrusted customer-entered prices:

| Plan | 30 days | 90 days | 365 days |
| --- | ---: | ---: | ---: |
| Starter | ₹49 | ₹147 | ₹588 |
| Pro | ₹99 | ₹297 | ₹1,188 |
| Business | ₹199 | ₹597 | ₹2,388 |

**Demo (10 free printed pages)** and **Pay Per Page (₹0.15 per page)** remain available by manual Super Admin selection. No payment checkout is needed for free Demo. Pay Per Page usage is still recorded manually under the Admin Panel.

### Set up your own receiving UPI details on Render

Log in to your own Render Dashboard → **QR-To-Print Web Service → Environment** and set:

- **UPI_PAYMENT_VPA**: The **actual receiving UPI ID** from your bank or UPI app (e.g. a valid ID of the form *yourid@bank*, placeholder only).
- **UPI_PAYMENT_NAME**: The correct payee/beneficiary name shown by the receiving bank or UPI app.

Save these Environment changes and allow Render to redeploy. **Do not assume your bank account, phone number, or WhatsApp number is a UPI ID.** Double-check the payee and destination by scanning with your own UPI app before you collect any real money. No credentials or beneficiary IDs are hardcoded in GitHub.

The Super Admin dashboard shows whether UPI is configured. Without both valid settings, new UPI payment QR generation remains unavailable.

### Flow and security

1. Owner opens **subscription-payment.html**, signs into their billing-only session and chooses Starter, Pro or Business, plus 30/90/365 days.
2. The server saves a shop-scoped **pending** payment request with the exact amount and a snapshot of the configured receiving UPI ID/payee name, then generates the QR image.
3. The owner scans with a UPI app and verifies the **merchant name, receiving UPI ID and amount** on their own payment screen before sending funds.
4. After successful payment, the owner enters the UPI transaction reference / UTR. The request becomes **submitted**. This is only an assertion, **not** bank verification. A QR scan, reference or screenshot alone is **not** proof that funds were received.
5. In **Super Admin → Shop Subscription Payments**, independently check the **actual credited funds, exact amount, recipient and UTR** from your own bank account/UPI app. Only when you have confirmed receipt, click **Verify bank receipt & Activate**. Otherwise reject the request. Both actions require separate confirmation.
6. Manual approval records the received amount, adds a subscription event and activates/extends the selected plan in **one database transaction**. A row lock prevents approving the same request twice. Existing shops and their print orders are not mixed.
7. Owners can view request statuses **pending / submitted / paid / rejected** in their billing page, and reopen an existing pending QR.

**IMPORTANT:** This is a manual UPI QR payment workflow, **not** an automatic online payment gateway. It does **not** verify UPI transactions, debit accounts, or process refunds automatically. No Paytm or Razorpay gateway is included in this change; an automated payment gateway can be implemented later when you request it.

## Safety and launch limitations

- Current shop accounts are grandfathered as active legacy accounts; new registration is pending.
- No auto-deletion on suspension; existing test files retain the one-day private R2 expiry policy.
- Shop/session and shop-specific QR requests are checked against active subscription state.
- A separate admin session is required. Shop-owner/customer accounts have no admin privileges.
- No automatic charging or UPI verification, payment gateway integration, refund processing, password reset, email verification, true printer page-count hardware enforcement, real customer print-job automation, malware scanning, full accounting, GST invoicing or refund system is implemented.
- Real commercial selling requires further security/privacy reviews, operational monitoring, backups, recovery, tax/compliance and real customer printing protections. **Do not upload real Aadhaar or any sensitive ID/document into the current disposable test system.**
