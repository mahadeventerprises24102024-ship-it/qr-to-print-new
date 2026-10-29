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
5. Choose a plan label (Starter, Pro, Business), duration (30, 90 or 365 days) and **manual payment amount** if money was actually received. For trial, use ₹0 and No payment.
6. Press **Activate shop**. Owner can then log in, get a unique shop QR and set their own rates.
7. Use **Renew / Extend plan** when renewing or **Suspend shop** when disabling access. Expiry and suspension stop owner APIs and QR customer requests, including existing active sessions.

Plan names are currently labels only: they do not yet unlock different feature tiers. No default subscription prices were assumed. Prices and any manual payment amount are chosen by the operator.

## What the admin can see

- Registered shop name, owner name/email, plan, expiry, status and shop ID
- Aggregate test order and bill counts (no customer files)
- Total shops, active shops and pending approvals
- Activate/renew/suspend controls
- Manual Cash/UPI amount confirmed received and subscription event history

## Safety and launch limitations

- Current shop accounts are grandfathered as active legacy accounts; new registration is pending.
- No auto-deletion on suspension; existing test files retain the one-day private R2 expiry policy.
- Shop/session and shop-specific QR requests are checked against active subscription state.
- A separate admin session is required. Shop-owner/customer accounts have no admin privileges.
- No online charging, subscription webhook, verified payment gateway, password reset, email verification, real customer print-job automation, malware scanning, full accounting, GST invoicing or refund system is implemented.
- Real commercial selling requires further security/privacy reviews, operational monitoring, backups, recovery, tax/compliance and real customer printing protections. **Do not upload real Aadhaar or any sensitive ID/document into the current disposable test system.**
