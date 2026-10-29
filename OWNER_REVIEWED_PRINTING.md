# Owner-reviewed PDF / photo printing — safe first step

This change adds **Review & Print** to a shop's private test upload order cards.
It lets the authenticated shop owner inspect a small uploaded PDF/JPG/PNG in a
browser, then deliberately open the Windows/Chrome print dialog.

**Important:** This is NOT automatic agent printing, production/customer print
fulfilment, or an antivirus-safe printing service. It is a manual shop-owner
workflow for the existing test uploads only.

## How to try it with Canon G2010

1. Review/merge the GitHub Pull Request and let Render deploy the new main.
2. Open `https://qr-to-print-new.onrender.com/shop-dashboard.html#orders`
   and sign in as the shop owner.
3. If no recent private test file is available, sign in as a *test customer*
   using the shop QR link and upload a harmless PDF/JPG/PNG sample under 2 MB.
   The private test upload feature must be enabled in Render. Do not upload
   sensitive or untrusted customer files while the system is in test mode.
4. In **Print orders → Private test uploads**, click **Review & Print**.
   Browser opens a new private review tab after shop authentication.
5. Inspect the file and check the display for requested copies and print mode.
6. For a JPG/PNG: click **Print image on Canon G2010**, confirm and select
   **Canon G2010 series**, A4, copies and colour/B&W in your print dialog.
7. For a PDF: click **Open PDF to Print**; inspect the PDF in the PDF viewer,
   click its Print icon (or Ctrl+P), select Canon G2010 and set print options.
8. Confirm physical paper output. The website does **not** mark jobs as printed
   or charge payment. Browser printing is local to the current shop computer.

## Privacy and limits

- Shop preview page requires authenticated shop-owner session.
- The file request uses the existing owner-scoped download API and its R2
  SHA-256 integrity verification and 24-hour database age limit.
- Downloaded content is held in the browser memory as a limited-size Blob
  object and discarded when the page is closed.
- Source files stay in private Cloudflare R2; the file is never sent to the
  Windows printer agent by this change.
- Chrome/Edge PDF viewer and Windows printer driver handle local printing;
  select the correct printer manually. Do not use unknown/untrusted PDFs.
- Print controls cannot enforce copies or actual printer selection. The shop
  owner must verify those settings in the native print dialog.
- The existing 1-day storage lifecycle will delete test file objects.
  Expired or removed files cannot be previewed.
- The Canon fixed diagnostic test print is unchanged and remains separately
  controlled by `ENABLE_CANON_TEST_PRINT`.

## Before production / automatic printing

Implement malware scanning, file type verification beyond magic bytes,
safe server-side document normalization in an isolated environment, a durable
per-shop job queue with manual approval, acknowledgments, revocation, spooler
status, retention, deletion, print/copy settings, printer selection, secure
monitoring and access auditing, and operator safeguards for real user content.
Only then should a future Windows agent consume and print customer documents.
