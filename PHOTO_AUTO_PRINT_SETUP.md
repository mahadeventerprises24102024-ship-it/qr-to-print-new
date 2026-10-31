# QR-To-Print — Windows Photo Auto Print (shop-by-shop opt-in)

This feature reuses the existing **Render Free**, Postgres database, private **Cloudflare R2**, and per-shop Windows pairing keys. It needs no paid Render upgrade.

## What it will and will not print

- **Supported:** a customer's **non-sensitive, server-sanitized JPEG photo** uploaded through **Mobile → Customer Photo**. The payment must have a shop-owner-created UPI quote and a customer claim. The shop owner must personally confirm the actual bank credit by clicking **Payment Received** with the exact amount.
- **Never auto printed:** PDFs, Aadhaar/PAN cards, identity documents, dummy/sample uploads, cash/manual-test orders, rejected orders, deleted/expired files, claimed-but-unverified UPI payments, and Paytm Soundbox audio notifications alone.
- **Not automatic settlement verification.** Paytm Soundbox speaks only via its Paytm merchant QR relationship. The platform does **not** infer success from a sound, screenshot, callback, or customer claim.
- A Windows **spooled** status means the Windows spooler accepted the print request; it does not mean the paper was produced. The shopkeeper must check actual paper and record Printed separately.

## One-time setup per shop

1. Install the printer in **Windows 10/11**, using the correct Canon/HP/Epson/Brother/other USB or network printer driver. Print one ordinary Windows test page.
2. Install **Node.js 20+** on the shop PC. Use a normal signed-in Windows user.
3. Sign in at https://qr-to-print-new.onrender.com/access.html?role=shop and open **Shop Dashboard → Printers**.
4. Click **Generate secure Windows pairing key**, then **Copy pairing key**. Do not share it in chats or screenshots.
5. Download the repository ZIP: https://github.com/mahadeventerprises24102024-ship-it/qr-to-print-new/archive/refs/heads/main.zip. Extract All.
6. Double-click **Install-QR-To-Print-Auto-Print.cmd** in the extracted folder, while signed in as the normal Windows user and with the key in the clipboard. Do **not** run as Administrator. The installer saves only a Windows DPAPI-encrypted pairing key, then schedules the photo worker to run when that Windows user logs in.
7. In **Printers → Refresh status**, verify the Windows Agent is online. Under **Choose your own printer**, pick one of the detected printer names and click **Save preferred printer**.
8. Under **Photo Auto Print**, explicitly choose **Auto Print ON**, confirm the warning, and click **Save Auto Print Settings**. This is disabled by default and is reset OFF whenever a new pairing key is created.
9. Open a customer QR on a phone. Upload a **non-sensitive** JPG/PNG under **Customer Photo**; the private server normalizes it. The shopkeeper accepts the order, sets the UPI amount and independently verifies bank credit. Only new UPI confirmations after opt-in are eligible for Auto Print.
10. Use **Printers → Refresh Queue** to check queued / claimed / spooled / failed / needs_review statuses. Monitor actual paper output.

The printer's driver must support **A4**. Requested copies are 1–10. Black-and-white requests are converted to grayscale JPEG on the server before printing.

## Failure / duplication controls

- Each order has a single database job by unique order ID. A server-side claim contains a short-lived random lease token which is stored **hashed**.
- The agent downloads only its own claimed private photo. A claim whose 2-minute lease expires is marked **needs_review**, not automatically requeued.
- Failed/uncertain jobs require manual review; do **not** click the browser Print Dialog if a job may already have spooled.
- If power, network, printer, or driver is unavailable, the job may be queued or need review. The browser is still available for a deliberate manual print.
- The pairing key is a privileged device secret. **Revoke connection** immediately if the shop PC is stolen or no longer trusted. To remove Windows setup, run **Uninstall-QR-To-Print-Agent.cmd** and also revoke the agent in the shop dashboard.

## Limitations

This is a first real-photo implementation, **not** approved for arbitrary document uploads, identity documents, unattended document retention, or PDF conversion. Live Windows printer integration testing is still required on each printer model. It is possible for a driver to queue a job without printing paper. The old `Install-QR-To-Print-Agent.cmd` is only a discovery/heartbeat test; use `Install-QR-To-Print-Auto-Print.cmd` for this photo worker. No Windows UI can be accessed directly from the website without the local agent.
