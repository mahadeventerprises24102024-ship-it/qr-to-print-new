# UPI QR payment for shop TEST print orders — owner verifies bank credit

This is a **real UPI payment request** (not a sandbox). Customers may transfer **real money** to the configured shop recipient. Use only with disposable, non-sensitive TEST documents until production file safety and printing are implemented.

## Workflow

1. Owner signs in to Shop Dashboard → **Pricing & Bills** → **UPI QR for Customer TEST Orders**, enters their own UPI ID and bank/payee name, checks account ownership personally, enables UPI and saves. The platform does NOT verify account ownership. Every shop has its **own recipient**.
2. Customer uploads a *non-sensitive TEST PDF/JPG/PNG under 2 MB* to the shop's private test flow (requires existing R2 private TEST storage + guest TEST opt-in). Customer receives private Order ID and Tracking Code.
3. Owner reviews uploaded content, clicks **Accept TEST order**, opens **Review & Print**, clicks **Set UPI QR TEST price**, and enters actual pages per copy (1–20). The backend calculates the total from that shop's stored price and original copies. The amount and payee are saved in one immutable quote.
4. Customer uses shop QR page, chooses **Private TEST file upload** in tracking, enters private Order ID and Tracking Code, clicks **Show UPI QR / Check Payment**. The UPI QR requests the saved amount with payment reference, shop's UPI VPA and recipient name. Customer checks payee and amount in UPI app before sending real money.
5. Customer optionally submits a **12–22-digit UTR**. The server records **customer_claimed** only. A UTR can be fabricated; it is NEVER evidence of verified payment.
6. Shop Owner opens Dashboard → Pricing & Bills → **Customer UPI Claims**, checks **actual receiving bank transaction history** (not screenshot/UTR alone), then clicks **Payment Received** and confirms the exact expected amount. The server atomically changes the claim to **paid_manual**, stores owner ID and confirmation time. Other shops' orders cannot be changed.
7. **Automatic printing remains OFF**, even if the owner marks payment received. Browser manual review/print for TEST files still applies. A manual confirmation is not bank API authentication.

## Security notes

- No bank passwords/OTP, MPIN or UPI credentials are collected or stored, only UPI ID and recipient name. Never share a UPI PIN.
- Unique shop/payment/order reference, unique claimed UTR across existing orders, maximum ₹2500 TEST request, one immutable quote per order, 24-hour expiry for original TEST upload.
- Customers need the correct private Tracking Code for the exact shop; statuses are private.
- The app does NOT automatically reconcile bank transactions. To enable automatic paid verification or payment-triggered unattended printing later would require authenticated PSP/bank webhook verification, secure production document scanning/deletion, durable printer queue, exactly-once dispatch and per-shop segregation.

## Current configuration

This feature needs no Paytm merchant credentials and no added Render UPI payment secret. Owner configures shop's UPI recipient inside Shop Dashboard. The existing platform subscription UPI account remains separate. The old optional Paytm SANDBOX flow also remains separate, OFF unless intentionally configured.

**Important:** Scanning the new normal UPI QR can transfer REAL funds. It is not a simulation. Confirm your receiving account and transact cautiously.

## Manual test

Open Shop Dashboard → Pricing & Bills. Save your own UPI ID and enable. Use a harmless uploaded TEST file, accept, quote, then visit shop QR from another browser. Confirm correct payee/amount, do not send money unless intended. A deliberately fake UTR is NOT credited until the shop owner manually verifies; never click Received without actual bank credit.

## Future steps for real operation

Production uploads need malware scanning and safe isolated rendering. Verified payment should be linked to trustworthy bank/gateway status, and print dispatch should be safe against multiple agent heartbeats, duplicate print requests, offline printers and failed jobs. Those features are NOT in this release.
