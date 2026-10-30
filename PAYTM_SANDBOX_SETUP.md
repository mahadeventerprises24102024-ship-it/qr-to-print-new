# Paytm Payment Gateway for QR-To-Print — SANDBOX TEST only

This adds **server-verified Paytm staging/sandbox payments** for disposable, non-sensitive private TEST file orders. It does NOT activate live money, automatic document printing, or real customer document uploads.

## Workflow

1. Customer scans their shop's QR and uploads a harmless TEST PDF/PNG/JPG (max 2 MB). This requires the existing private R2 TEST storage and separate guest TEST opt-in to be enabled.
2. Shop Owner reviews the sample, clicks **Accept TEST order for printing**, then **Set Paytm TEST price** and enters the actual pages per copy (1–20).
3. The server calculates the amount from the stored B&W/colour rate, pages per copy and original copies. Quote is immutable; only one payment attempt per TEST order is allowed.
4. Customer's shop QR page has **Pay with Paytm (TEST ONLY)** when staging is configured. The customer must enter their private Order ID and Tracking Code, and can check the verified payment status at any time.
5. Server calls Paytm's signed Initiate Transaction API and returns a token for the official Paytm staging hosted checkout. QR-To-Print never collects card numbers.
6. Paytm's signed callback is checked with the merchant key, then the server independently verifies the signed Paytm Transaction Status response, order/MID, amount, success code and unique transaction ID. Only a verified, matching success is recorded as Paid. Browser input cannot mark Paid.
7. **Paid does NOT automatically print.** Shop Owner must still manually review and print the TEST file. This sandbox never reports actual received money.

## Configure in Render ONLY (staging credentials)

First obtain Paytm STAGING merchant account credentials from the official merchant dashboard. In Render Web Service -> Environment, add:

- PAYTM_TEST_ENABLED = true
- PAYTM_MID = your staging MID
- PAYTM_MERCHANT_KEY = your staging Merchant Key
- PAYTM_WEBSITE_NAME = WEBSTAGING (or assigned Paytm staging website name)
- PAYTM_CALLBACK_BASE_URL = https://qr-to-print-new.onrender.com

Callback URL: https://qr-to-print-new.onrender.com/api/paytm-print/callback

The merchant key is secret. Do not share it in chats, GitHub, screenshots or browser scripts. Do not hardcode it. The server has hardcoded Paytm **staging** gateway URLs and cannot take real money in this version. Paytm merchant onboarding may require callback domain verification.

The existing UPI QR used for shop plan subscriptions is SEPARATE and unchanged.

## R2 TEST storage requirement

Customer upload stays off unless ENABLE_TEST_UPLOADS=true with valid private FILE_STORAGE settings and the independent ENABLE_GUEST_TEST_UPLOADS=true switch. Both are for disposable non-sensitive TEST files only; do not upload Aadhaar, IDs, or any real customer documents. The metadata-only demo order cannot be paid.

The Paytm flow cannot be used for rejected, unaccepted, expired, or other shop's TEST files. There is no forged Paid button. The customer's private tracking token is needed for both checkout and status lookup.

## Real money and unattended printing are NOT ready

Before enabling live Paytm payments or payment-triggered auto-printing, complete:
- Paytm Production MID/key, verified merchant settlement/business KYC, payout/refund/dispute controls.
- Antivirus or CDR/isolation of PDFs/images, validated page counts, private encrypted storage, reliable deletion policies, abuse limits and logging.
- Exactly-once, shop-isolated print job claims, device queue authentication, safe driver integration, retry/double-print protection, printer status/physical page confirmation, handling failed print/refunds, and per-shop isolation.
- End-to-end security testing and actual Windows printer tests.

Sandbox Paid does NOT imply successful printing or production payment; customer printing on the Windows Agent is still OFF.

## Official documentation

- https://www.paytmpayments.com/docs/show-payment-page/
- https://www.paytmpayments.com/docs/api/initiate-transaction-api/
- https://www.paytmpayments.com/docs/api/v3/transaction-status-api/
- https://www.paytmpayments.com/docs/checksum-implementation/

## Troubleshooting

- Paytm option missing: staging credentials and PAYTM_TEST_ENABLED are not configured.
- No quote: Shop Owner must accept the safe TEST order, then create the Paytm quote in Review & Print.
- Checkout already started: do not pay twice. Check existing status first; a provider network failure may have started an unknown transaction.
- Pending: not Paid; a callback alone does not confirm payment.
- Paid, not printed: expected in SANDBOX. Customer document automatic printing remains disabled.
