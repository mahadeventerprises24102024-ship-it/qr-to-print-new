# QR-To-Print — Private TEST File Upload Setup

This is a **restricted trial upload**, not a production-ready print service. Only use disposable, non-sensitive sample files. Real customer documents and payments must wait for malware scanning, security review, backups, billing and operational controls.

## Step 1 — Private Cloudflare R2 bucket

1. Open Cloudflare Dashboard: https://dash.cloudflare.com/
2. Go to **Storage & databases → R2 → Overview**.
3. Choose **Create bucket** and create a bucket such as `qr-to-print-test-private`.
4. Leave the bucket **PRIVATE**. Do not enable a public custom domain or `r2.dev` access.
5. In the bucket's **Settings → Object Lifecycle Rules**, add an expiration rule for prefix `test-uploads/` to **delete objects after 1 day**. This is required for privacy and storage hygiene. Cloudflare may remove objects later than the exact 24-hour mark.
6. In **R2 → Manage API Tokens**, create a scoped **Object Read & Write** key for this bucket only. Save the S3 API endpoint, Access Key ID and Secret Access Key in a password manager.

Official documentation:
- https://developers.cloudflare.com/r2/get-started/s3/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/

## Step 2 — Render Environment Variables

In Render → your `qr-to-print-new` web service → **Environment**, add:

| Name | Value |
| --- | --- |
| `FILE_STORAGE_ENDPOINT` | `https://YOUR_32_CHARACTER_ACCOUNT_ID.r2.cloudflarestorage.com` |
| `FILE_STORAGE_BUCKET` | `qr-to-print-test-private` (your actual bucket name) |
| `FILE_STORAGE_ACCESS_KEY_ID` | Your **bucket-scoped** R2 Access Key ID |
| `FILE_STORAGE_SECRET_ACCESS_KEY` | Your R2 Secret Access Key |
| `ENABLE_TEST_UPLOADS` | `true` **only after the private bucket and 1-day lifecycle are ready** |

Keep existing `DATABASE_URL`, `SESSION_SECRET` and `NODE_ENV=production`. Never commit credentials to GitHub, paste them into a chat, share screenshots of them, or put them in frontend code.

The implementation supports **Cloudflare R2 endpoints only** to minimize accidental use of non-private remote storage.

If any required setting is absent, the upload feature **stays disabled**. The existing shop QR and metadata-only demo continue to work.

## Step 3 — Test after the Render deployment is Live

1. Open `https://qr-to-print-new.onrender.com/api/test-upload/config`:
   - `enabled:false`: storage has not been configured (safe default).
   - `enabled:true`: test upload form may be used.
2. Open the **shop QR customer page** on a phone or in an incognito window.
3. Use the Customer Login link. If you haven't created a customer account, create a disposable test account on the Customer Login page, then log in.
4. After login, you should return to the same shop's QR page.
5. Use **Private file upload • TEST ONLY** with a sample PDF, JPG or PNG of **at most 2 MB**, choose copies and Black & White or Color. Do not use real personal, medical, ID, financial or confidential documents.
6. After submission, the page should display a **TEST order ID**. This file is stored privately but **not printed**.
7. On a **separate browser/device** (since shop and customer share a session cookie), log in as the shop owner, open **Print orders**, click **Refresh private files**, and confirm the TEST order.
8. Click **Download TEST**, check the file downloads as an attachment and cannot be downloaded while signed out.
9. Click **Delete** and confirm the object and order record disappear.
10. When finished, remove any test files and change `ENABLE_TEST_UPLOADS=false`. Ensure no credentials are visible in screenshots.

## Server protections in this trial

- Upload POST requires a logged-in **customer** and same-origin browser request.
- Shop-only list/download/delete uses server-side session authorization and a shop-ID join.
- Only 1 file per request; maximum **2 MB**; PDF, JPG and PNG content is checked for basic signatures and expected MIME type.
- Maximum 10 stored test files per shop, with 5 submissions per IP per hour.
- Files stored under random object keys; original filenames are never retained.
- Files are downloaded as attachments (not inline).
- Owner download endpoint rejects test files older than 24 hours; the R2 lifecycle must delete the underlying objects.
- File checksum is recorded and checked when the owner downloads a file.
- Customer order list shows only that signed-in customer's test orders.

## Important limitations

Basic file signatures **are not a malware scan**, and document previews/printing are not implemented. Never open an unknown file on a production print-shop computer.

The database table stores test-order metadata for longer than the R2 object's 1-day lifetime until records are explicitly deleted. Render's free PostgreSQL is temporary; move to a durable backed-up production database before any real business use. A complete system still needs malware scanning, an upload cleanup process, file encryption/key management review, audit logs, reliable printer agent and billing.

The current data path is: Customer Login → Private R2 upload → Database test order → Authenticated shop owner download / delete. **No automatic printer job or payment occurs.**
