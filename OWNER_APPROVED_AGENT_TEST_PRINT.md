# QR-To-Print: Owner-approved private TEST PDF/photo printing (Canon G2010)

**Prototype only. Not safe for genuine customer documents.** No antivirus/malware
scanning, document sandbox, abuse monitoring, durable production job handling,
printer feedback verification or billing is included.

This feature does NOT print merely because a customer uploads a document.
Shop-owner review + explicit confirmation is required per file.

## 1. Windows prerequisite: official SumatraPDF

The Windows Agent uses [SumatraPDF](https://www.sumatrapdfreader.org/) to submit
PDF and PNG/JPEG sample files to the Canon G2010 via Windows print queue.
It cannot silently print these types using the previous built-in fixed test page.

1. Install the latest official [SumatraPDF for Windows](https://www.sumatrapdfreader.org/download-free-pdf-viewer)
   from its vendor website. Do **not** use unknown mirror sites.
2. Install normally under one of the default paths:
   - `C:\Program Files\SumatraPDF\SumatraPDF.exe`
   - `C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe`
   - `%LOCALAPPDATA%\SumatraPDF\SumatraPDF.exe`
3. In Windows, verify the `Canon G2010 series` printer exists and can print a
   regular Windows Test Page. This project requires Canon G2010 explicitly.
4. Close the old Windows Agent CMD window. Do not paste the pairing key in chats.

SumatraPDF supports PDF, PNG and JPEG and the `-print-to` and `-print-settings`
options for specifying copies, color mode and A4 paper. See its official
[command-line printing instructions](https://www.sumatrapdfreader.org/docs/Command-line-arguments).

## 2. Enable the limited TEST print feature separately

After the GitHub PR is merged and Render deploys the new main branch:

1. Render > your `qr-to-print-new` service > Environment.
2. Add `ENABLE_OWNER_APPROVED_TEST_PRINTS` = `true`.
3. Save and Deploy; confirm service is **Live**.
4. Keep the existing private R2 bucket and its 1-day `test-uploads/` object
   expiry policy. This feature requires `ENABLE_TEST_UPLOADS=true` and valid
   private R2 credentials; otherwise it remains OFF even if the new flag is true.
5. To stop new approved test printing, set
   `ENABLE_OWNER_APPROVED_TEST_PRINTS=false` and Save/Deploy.

This flag is **false by default**. The existing diagnostic test page flag
(`ENABLE_CANON_TEST_PRINT`) is independent.

## 3. Update and pair the Windows Agent

1. Download a fresh ZIP from GitHub main (Code > Download ZIP), Extract All.
2. In Shop Dashboard > Printers, click **Generate printer PC pairing key**,
   then **Copy pairing key**. Generating a new key revokes the previous key.
3. Open CMD inside the **newly extracted** project folder; run:

   ```cmd
   node windows-print-agent.js
   ```

4. The key is read from Windows clipboard automatically; no paste is needed.
5. Wait for **PC online**. Keep CMD running and clear the clipboard afterward.
6. If CMD says SumatraPDF missing, make sure installed under a default path
   and restart the new Agent. Don't enable testing until it is detected.

## 4. First safe test (use your own harmless file ONLY)

1. Using your shop QR, anonymously upload your own disposable PDF/JPG/PNG
   sample under 2 MB with **1 copy**. Do NOT use real private documents.
2. Shop Dashboard > Print orders > **Refresh private files**.
3. First click **Review & Print** to inspect what the sample contains.
4. Then click **Approve & Print (TEST)** next to that *specific* file.
5. Read the confirmation and click **OK**. The Windows Agent will claim the
   job at its next heartbeat, fetch only that shop's approved file, verify its
   SHA-256 digest and basic type signature, and submit it to the Canon G2010.
6. Refresh private files to read the job state. **Submitted** means SumatraPDF
   handed it off to Windows; it does NOT guarantee printed paper. Physically
   check the Canon paper tray/output and Windows print queue.

## Protections & limits

- Only authenticated shop owner may approve, per order, after explicit consent.
- Each private test file may be approved only **once**, no automatic retries;
  one active job per shop and at most **3** test jobs per hour.
- Samples are at most **2 MB**, and approval allows **1-2 copies**.
  **PDF prints only pages 1-2** for this prototype; use A4, simplex.
- A job expires after 3 minutes unclaimed or 5 minutes claimed. Agent cannot
  fetch files after claim expiry or revoked pairing key.
- The Agent downloads only a **claimed** job with its secret bearer token; no
  public R2 URLs, end-user filenames or arbitrary commands are transmitted.
- Local files are placed in a short-lived randomly named temp folder and
  deleted after command completion. Windows print spooler and SumatraPDF may
  retain printed content temporarily; configure local privacy controls.
- Approved-print status is `queued`, `claimed`, `submitted`, `failed`
  or `expired`. This project deliberately does NOT mark an order as
  physically `Printed` without printer feedback.
- If file appears suspicious, **do not click Approve & Print**. Use a known
  safe file you created for testing, never a real public upload. The current
  basic PDF/PNG/JPEG checks **are not malware scanning**.
- The Shop Owner Login remains mandatory for approval and downloads even
  when public guest QR test uploads are enabled.

## Future production requirements

Before accepting real users' files: malware scanning, isolated document
normalization, proper content inspection, abuse controls for anonymous uploads,
printer capabilities and spooler receipt monitoring, audited owner approvals,
secure file retention/deletion, data privacy assessment and durable backups.
Payment/wallet and full production workflow remain disabled.
