# Customer Order System — TEST workflow

This release connects the existing **shop-specific customer QR page** with a status-aware **shop owner order inbox**. It is a test/prototype, **not a live production print platform**. Do not upload private or sensitive customer documents or assume an order was actually printed.

## 1. Customer sends order details (works without R2 or login)

- Shop owner logs into `/shop-dashboard.html` and shares their own **QR code**.
- A guest scans and opens `/print.html?shop=<shop-code>`, verifies shop name, and uses **Demo request (file stays on your device)**.
- Guest selects an example PDF/JPG/PNG *locally* and copies (1–10). **Only file type, reported file size and number of copies are saved; the file bytes never leave the device.**
- The response contains an **Order ID** and **48-character private Tracking Code**. It is shown in the status tracker below the form. The guest must save both for later. Neither password, phone number, identity document nor customer payment is requested.
- On the same page, **Track your TEST order** accepts the Order ID, Tracking Code and Demo order type. It reports one of:
  - `demo_only`: received, owner has not reviewed
  - `reviewed`: owner reviewed the metadata; **no file was uploaded or printed**
  - `closed`: the owner closed/archived this test request; **no file was printed**
- Shop owner sees only their own shop’s Demo requests in **Customer Order Inbox**. The buttons are **Mark Reviewed** and **Close demo request**. Closed is terminal.
- The tracking code is generated with cryptographically secure randomness. PostgreSQL stores **only its SHA-256 hash**. The code is never placed in a URL or sent to analytics. Anonymous status checks require a matching shop QR code, order ID and secret, and are rate limited. Legacy demo orders have no tracking code and remain visible only to their shop owner.

## 2. Optional private non-sensitive TEST file orders

File upload remains **disabled unless explicitly configured** with private R2 test storage and an *independent* guest-upload opt-in. Enable only in a safe staging context with disposable files; existing malware scanning, lifecycle and operational security limitations remain.

Required Render Environment variables are documented in the existing private test-upload setup:

- `ENABLE_TEST_UPLOADS=true`
- `ENABLE_GUEST_TEST_UPLOADS=true`
- `FILE_STORAGE_ENDPOINT`, `FILE_STORAGE_BUCKET`, `FILE_STORAGE_ACCESS_KEY_ID`, `FILE_STORAGE_SECRET_ACCESS_KEY`

With those **correctly configured**, the customer can send a **single non-sensitive PDF/JPEG/PNG test file up to 2 MB**, copy count and black-and-white/colour option without signing in. A tracking code is generated. The file resides in a **private bucket** accessible through owner-only download routes. File download is limited to **24 hours** and the bucket should use a **1-day expiry lifecycle**. Customer status tracking reveals **status only, never a download URL or file content**.

Shop Inbox supports the status transitions:

| Test file status | Meaning |
| --- | --- |
| `test_only` | Request received, awaiting owner decision |
| `accepted` | Shop owner accepted this test sample for review/possible manual printing |
| `rejected` | Shop owner declined; cannot be marked printed |
| `printed` | Shop owner manually confirmed that **physical paper came out**, after accepting and reviewing the file |

To process a private test file, shop owner opens their **Print orders → Private TEST file orders**. They can **Review TEST file**, **Accept test order** or **Reject test order**. A rejected order cannot later be printed. Accepted files can be handled through the existing **Review & Print** page: the browser opens the print dialog, not any automatic printer agent. **Mark Printed** is available only after acceptance and explicit physical paper confirmation. The existing separate shop billing page can create a simple bill *after* the order is marked printed.

**No real-world per-page billing or Demo print quota is automatically metered.** The platform’s Demo 10-page and Pay Per Page ₹0.15 plans still require administrator confirmation of real physical pages. A submitted/accepted test order does not consume the Demo quota automatically.

## 3. Verify after deployment

1. Confirm the GitHub change is merged, and Render shows a successful updated deployment.
2. From the logged-in Shop Owner Dashboard, open the correct shop QR page.
3. Send a disposable Demo metadata request; ensure an ID and Tracking Code appear.
4. Use **Track your TEST order** → `demo_only`.
5. Shop owner uses **Mark Reviewed**; customer refreshes status → `reviewed`.
6. Shop owner chooses **Close demo request**; customer refreshes status → `closed`.
7. For private file tests, leave file storage OFF unless you have private R2 + guest opt-in and are using truly non-sensitive, disposable samples.
8. Ensure Mahadev Enterprises cannot read or update Demo Print Shop orders and vice versa.

## 4. Security/limitations

- Uploaded sample MIME types/size/signatures are checked but **not malware scanned**; do **not** accept sensitive documents for real users.
- No customer identity verification, guaranteed delivery, automatic Windows/Canon printing, page-count hardware metering, refund process, push notifications or real-time payment settlement.
- Rate limits and size caps are for testing, not a comprehensive abuse/malware control system.
- Anonymous Tracking Code is a bearer secret for **status only**. Do not share it. Existing past orders will not have a tracking code retroactively.
- No automatic data retention/clearing of metadata: only short-lived R2 object downloads are enforced; configure lifecycle and future DB retention before production launch.
