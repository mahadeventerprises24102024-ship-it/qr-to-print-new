# UPI QR payment for TEST print orders — shop owner verifies, then Print Dialog

## What happens

1. Shop Owner opens **Shop Dashboard → Pricing & Bills**, sets their own UPI ID and bank/payee name, checks the recipient personally, and enables **UPI QR**. Every shop has its own recipient.
2. Customer scans that shop's QR page, chooses a harmless TEST file or **Aadhaar-style DUMMY TEST Front + Back layout**, and submits it using existing private TEST file upload (R2 and optional guest TEST uploads must already be configured). **Do not upload real Aadhaar, identity documents, addresses, or other private customer information.**
3. The owner reviews and accepts the harmless TEST document, then chooses **Set UPI QR TEST price** and provides the verified page count. A dummy front/back sample is **one combined A4 page** and uses the shop's **Aadhaar B&W rate per copy** when B&W is selected. Regular PDF/photo jobs use the saved B&W/colour per-page rates. Only a single immutable quote is created for each order.
4. Customer supplies shop-specific Order ID and private Tracking Code to show the shop's actual **UPI QR / Open UPI App** payment request. Normal UPI payments can deduct **real money**, even though files are TEST-only. Check the recipient/payee before making any payment.
5. After paying, customer presses **मैंने पेमेंट कर दिया**. **No UTR is required.** This is recorded as an **unverified payment claim**, NOT Paid. Customer claims, screenshots or messages cannot establish a bank deposit.
6. The owner opens **Shop Dashboard → Pricing & Bills → Customer UPI Claims**, verifies the bank account/UPI app genuinely received the exact amount, and clicks **Payment Received**. Only the owner can record the confirmation (with timestamp and shop owner ID).
7. Following successful verification, the owner's current desktop browser opens the **TEST print preview**, which requests the **native browser Print Dialog automatically for TEST PNG/JPG images**. The owner chooses printer, copies, paper and colour, and clicks Print. **Print Dialog may be blocked by browser pop-up/automatic printing restrictions**: there is a clickable fallback. For TEST PDFs, use the PDF viewer and **Ctrl+P** because browsers cannot reliably open the PDF Print Dialog programmatically.
8. After inspecting paper output, the owner manually marks the accepted TEST file Printed.

## Security and limits

- The customer never supplies a trusted payment amount, nor any UPI PIN, bank login, OTP or Merchant Key. The backend computes the amount from shop rate settings and saved order copies.
- The owner must check real bank credit; no PSP / bank webhook automatically verifies the receipt.
- One immutable UPI quote per order, maximum ₹2500, shop-specific private Tracking Code, shop-isolated database queries.
- Print-dialog launch is allowed only for the **same authenticated shop owner**, for a **fresh accepted TEST file** with **manually verified UPI payment**. The local Windows Agent remains preview-only and receives **no customer documents**.
- The real Aadhaar document workflow is **NOT live**. Only dummy/sample non-sensitive front/back images may be combined into one local PNG TEST page, with one separate Front picker and one Back picker. They are combined inside the customer's browser and uploaded as one flat private TEST image. Composite expires on the existing storage lifecycle; upload only if the existing R2 TEST storage is specifically enabled.
- Normal UPI QR is a **real-money request**, not a sandbox. Do not use it for harmless demo transactions unless you intend to pay actual money.
- Owner confirmation is manual and not independently verified by the bank API. If multiple identical amounts arrive, the owner should reconcile independently before marking the correct order Paid.
- Customers cannot automatically print just by clicking "I Paid". **No silent printing**: the shop owner must inspect and confirm the native Print Dialog. Auto-dialog may be blocked by the browser and is not guaranteed.
- For production real documents (including Aadhaar), complete malware scanning/CDR, isolated rendering, storage encryption, short retention and deletion, permissioned access, compliance, logging, payments reconciliation and trustworthy printer queue handling before enabling uploads.

## Merchant setup

The shop UPI recipient is configured from the Shop Dashboard. **Paytm Gateway credentials are not needed** for this standard UPI QR workflow. The platform's subscription UPI account and optional Paytm staging gateway are separate.
