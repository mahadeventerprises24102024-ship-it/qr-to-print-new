# Quick Print Panel — file selected → Print option (safe TEST mode)

## Goal

Every shop has its **own printer**, and the shop owner sees a **Review & Print** action when a customer submits an enabled private TEST file order. The shop owner has the final decision: there is **no automatic print dispatch**, and the customer cannot remotely operate a printer.

**This remains a TEST feature. Do not upload real customer documents, Aadhaar, identity proofs or other private files.** Production requires malware scanning, operational controls, encrypted durable private storage, retention/deletion controls, backups, access review, and independent printer verification.

## New owner-only page

After deployment, sign into the shop owner dashboard on your shop's PC and open:

`/shop-print-panel.html`

The page is also linked from the Shop Dashboard's top bar, Quick Actions and Print orders section.

### Customer file upload → shop Print option (private R2 TEST upload required)

1. Customer scans **that shop's own QR** and opens `/print.html?shop=<shop-code>`.
2. If and only if private R2 **TEST storage is fully configured and guest TEST file uploads were explicitly enabled**, the customer can submit one disposable **non-sensitive** PDF/JPG/PNG file up to **2 MB** with copies and B&W/colour.
3. The file is stored in the private TEST bucket and an order appears in the authenticated **Quick Print Panel → Incoming Print Orders** within about **10 seconds while the panel is visible**, or immediately after pressing Refresh.
4. A new order shows **Review & Accept to Print**. This opens the existing secure Shop Print Preview, where the owner reviews the safe TEST file and explicitly **Accepts** the order.
5. After acceptance, the panel shows **Print Now · Manual**. The owner selects the **shop's own installed printer**, number of copies and colour in the operating system/browser print dialog. For PDFs, the PDF viewer has its own Ctrl+P print dialog.
6. Only **after paper actually comes out** does the owner click **Mark Printed**; this is never inferred from closing a browser print dialog. The existing manually verified bill can then be created.

Never open untrusted files or print on a shared device containing sensitive information. Printed output and hardware page counts are not automatically verified.

### Shop PC: select local file → Print option immediately (no R2 needed)

If you only want to test your local Canon/HP/Epson/Brother/other printer, you **do not need a cloud upload or Windows Agent**. On the right side of the Quick Print Panel:

1. Choose a disposable, non-sensitive PDF/JPG/PNG file of up to **2 MB** on the same computer connected to the printer.
2. The **Print selected file** button becomes available immediately.
3. Set B&W/colour and copies as a reminder; choose those settings **again** in the native Print dialog.
4. For images, clicking Print opens the browser's native Print dialog. For PDF, a local PDF viewer opens; review and use **Ctrl+P**.
5. Physically confirm paper printed. Local files **are never uploaded, saved to the cloud, billed, or added to the customer order list**.

The local picker only validates extension, MIME type and size in the browser; there is **no malware scan**. Do not open suspicious or sensitive customer content.

## Privacy, cost and infrastructure notes

- Shop Print Panel requires an active authenticated **Shop Owner** session; private file list is tenant-scoped. Customers see their own tracking status, **not** shop print controls.
- Printer selection is manual. The Windows Agent remains optional for discovering installed printer names. It **cannot** automatically download or print customer files.
- The upload endpoint is **not enabled** merely by publishing the panel. It requires `ENABLE_TEST_UPLOADS=true`, `ENABLE_GUEST_TEST_UPLOADS=true` and valid `FILE_STORAGE_...` configuration; these should stay OFF for production unless all security controls are installed.
- Each shop's private TEST storage quota is limited to 10 files, anonymous guest test uploads are rate limited, and the private file download expires after 24 hours. Configure the bucket's 1-day lifecycle.
- The panel checks for new orders every 10 seconds **only while the page is visible**. The Render free web instance can sleep when inactive, so refresh or wake-up delays may occur.
- Printing uses the Windows/browser local print dialog: a remote customer's phone cannot silently send content to a shop's physical printer.
- A Demo metadata-only request is **not a file upload** and will **not** show a Print button. It appears in the existing demo inbox only; the document stays on the customer's device.
- Local file printing never adds/charges subscription pages. The Super Admin still manually confirms Demo 10 free printed pages and Pay Per Page ₹0.15/page records based on **real physically printed paper**.

## Suggested safe test

1. Merge the PR and confirm updated Render deployment.
2. Shop owner logs in from the printer PC and opens Quick Print Panel.
3. Select a harmless one-page TEST PDF or PNG on that PC. Confirm **Print selected file** appears immediately.
4. Click it, select shop printer and inspect actual printed output.
5. Only if R2 guest TEST upload is configured and safe, scan the QR in a separate browser and submit a disposable 1-page test image. Watch incoming orders appear within 10 seconds.
6. Click **Review & Accept to Print**, accept explicitly, then click **Print Now · Manual**, and mark Printed only after verifying physical output.
