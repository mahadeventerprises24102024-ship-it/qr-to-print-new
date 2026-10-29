# Shop Pricing & Simple Test Bills

This feature introduces **shop-owned rate settings, estimates and basic manually issued bills**. It is not a GST tax invoicing, verified payment, or production print service.

## Default Mahadev Enterprises rates

| Type | Pricing unit | Starting rate |
|---|---|---:|
| Black & White | Per printed page | ₹3 |
| Aadhaar B&W | Per card/copy | ₹5 |
| Colour | Per printed page | ₹10 |

Shop owners can change whole-rupee rates (₹1–₹1000) at **Shop Dashboard → Pricing & Bills**. The price list is public on the corresponding shop's verified QR page. Guest estimates are for the pages entered **for display only**; the page count is not trusted or uploaded with the test file. Aadhaar is a **pricing category only**—do not upload actual Aadhaar or any personal IDs in test mode.

## Billing calculation

For ordinary B&W / Colour, **amount = actual pages per copy × copies × price per printed page**. For Aadhaar B&W, **amount = card copies × card price** (one pricing unit per card/copy, regardless of front/back sides). Owners review the PDF and set the actual page count, up to 200 pages per copy. A customer upload currently allows only 1, 2, 5, or 10 copies; the server reads copies from the order, **not** from the client billing form.

Only an owner-confirmed **Printed** private test order can have a bill. Each order can have at most one saved bill. The billed price, print type, quantity and shop name are snapshotted at issue time, so changing shop rates does not change an already-issued bill. If a disposable sample file is deleted after its 24-hour test window, the billing snapshot is retained separately from the test file.

## Shop workflow

1. Sign in to the shop dashboard and select **Pricing & Bills**.
2. Check or save **₹3 B&W, ₹5 Aadhaar B&W, ₹10 Colour**.
3. Customer QR displays a provisional price estimate. There is no customer login and no payment collection.
4. With a harmless sample file, review and print manually, then confirm the physical paper output with **Mark Printed**.
5. Return to **Print orders → Private test uploads**, click **Create Bill** on the Printed order.
6. Select the appropriate print type and manually enter actual pages per copy. Click **Create simple bill**, after confirming the information.
7. On the printable bill page, select **Print / Save PDF**. Bill is marked **Payment pending**.
8. Only if cash or an external UPI payment was **actually received**, choose the method and confirm **Mark payment received**. No payment is initiated or verified through QR-To-Print.

The bill is explicitly labelled **Not a GST tax invoice**. No GST tax calculation, customer identity verification, sales reconciliation, cash drawer integration, automatic printer delivery or payment gateway is present.

## Security notes

- Pricing changes, bill creation, bill viewing and manual payment marking are **shop-owner-only**, scope queries by logged-in owner/shop, and inherit the server's same-origin protection.
- Customer shop QR publishes **prices only**. Guest customers cannot see other shops' bill or order details.
- Printed status is owner-confirmed; browser print dialog state alone does not prove physical output.
- The bill excludes customer names, uploaded document contents, original filenames and Aadhaar numbers.
- Keep the private R2 storage lifecycle at one day; do not invite real Aadhaar/ID uploads in the test workflow.
- Existing diagnostic printer agent and browser-based manual printing remain unchanged.
- Production billing requires durable database backups, auditing, GST/tax review as applicable, transparent cancellation/refund flows and reliable payment verification.
