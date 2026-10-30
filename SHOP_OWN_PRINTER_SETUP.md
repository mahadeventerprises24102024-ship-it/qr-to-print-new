# Each shop prints on its OWN printer — manual test rollout

This feature removes the Canon G2010 requirement **from the existing owner-approved browser print workflow**. A shop can use any compatible locally installed printer, such as **Canon, HP, Epson, Brother or a network/USB/Wi-Fi printer**. No shop can command another shop's printer; the Windows Agent still has customer printing **disabled**.

> **TEST-ONLY**: Do not upload real customers' personal documents. Private TEST uploads require explicitly enabled R2 storage and separate guest test-upload opt-in, strict 2 MB cap and non-sensitive throwaway samples. Malware scanning, retention, operational safeguards and live customer printing are not ready for production.

## A. Print using a shop's own printer (Agent not required)

1. On the **same Windows computer** that will print, install your printer driver. Confirm the printer works in Windows **Settings → Bluetooth & devices → Printers & scanners**.
2. Sign in to your shop's `/shop-dashboard.html` account on that computer.
3. Open the **Printers** tab, then select **Print a local test page (any printer)**. The separate owner-authenticated test page contains **no customer data**.
4. Click **Open Print Dialog**, choose your own installed printer, verify A4/B&W/one copy, and confirm printing in the system dialog.
5. Physically check the printed diagnostic page.
6. If **private TEST file upload** is already safely configured with R2 and non-sensitive sample files, go to **Print orders**, review a sample, **Accept test order**, then select **Review & Print**. For images the browser opens the native print dialog; for PDF choose the PDF viewer's own print dialog. **Select your own locally installed printer**, copies and colour there.
7. After physically inspecting all pages, choose **Mark Printed**. Only accepted test orders can be marked printed. A browser dialog closing is *not* proof of printed paper; never mark printed without actual paper output.

**Important:** Browsers cannot reliably force a specific installed printer or silently print. The human shop operator must select/confirm the destination in the native print dialog. If you use a phone, printer availability depends on the phone OS and compatible print service; the documented test path uses a Windows PC.

## B. Optional Windows Agent — discover printer names and save a per-shop preference

The existing `windows-print-agent.js` now reports installed **printer names** as well as the count. This is optional and for shop **discovery only**, not for remote customer file printing.

1. In the shop **Printers** tab, generate the pairing key and copy it privately. Do not disclose the key in chat, screenshots, source code or logs.
2. On that shop's Windows PC install Node.js 20+, download the updated repository, then launch PowerShell in the extracted directory and run:
   `node windows-print-agent.js`
3. Paste the pairing key into the hidden prompt or the Windows Clipboard. The Agent connects by authenticated HTTPS heartbeat, reporting Windows-installed printer names.
4. Back in Shop Dashboard, click **Refresh status**. Choose your printer under **Preferred printer** and press **Save preferred printer**.
5. This is only a reminder stored for the signed-in shop account. At print time **choose that printer manually in the native dialog**. Saving a preference does not change the Windows default printer or route a job remotely.
6. Pairing a new PC revokes the old key and resets its reported printers/preferences. The Admin cannot pick printers for other shops.

The optional **Canon G2010-only** remote fixed diagnostic remains separately available only if `ENABLE_CANON_TEST_PRINT=true`. Its job is a constant test page, *not customer documents*. All other printers use the browser-based test described in A. No other Render variables or paid service are required for **local diagnostic printing**.

## C. Start Windows Agent automatically after sign-in (NEW)

You no longer need to run the Node script manually after every Windows login:

1. On the PC connected to your shop printer, install Node.js 20+ and open your own Shop Dashboard > Printers.
2. Click Generate secure Windows pairing key and Copy pairing key.
3. Download the GitHub ZIP, extract it, then double-click **Install-QR-To-Print-Agent.cmd** (normal Windows user, **not** Run as Administrator).
4. The setup encrypts the key under the same Windows user with DPAPI and registers a least-privileged Windows Task Scheduler logon trigger.
5. After setup and at future **Windows sign-ins**, the Agent starts itself, retries the HTTPS heartbeat after internet interruptions and displays this shop's detected printer names in Dashboard > Printers.

Full installation, error handling, security boundary, and one-click removal instructions: **WINDOWS_AGENT_AUTOSTART.md**.

**Important:** This feature starts at **Windows user login, not before login**. It still does not download/print customer files automatically. Shop owner confirmation remains required.

## Security model and limitations

- Printer names are obtained using a fixed PowerShell `Get-Printer` command, capped at 30 names, each at most 100 characters; no printer name is executed or interpreted as PowerShell.
- The Agent heartbeat requires its previously issued bearer key. The server only returns printer names to the corresponding authenticated Shop Owner. Database updates are scoped by shop owner and the printer list must contain any saved preference.
- The original printer-agent response stays `printingEnabled: false`. Customer files are **never downloaded, stored locally or automatically dispatched by the Agent**.
- Manual browser printing is already possible for accepted disposable TEST files on locally installed printers only. To go to real production, add malware scanning, durable encrypted file storage/retention, capacity monitoring, abuse prevention and privacy/security review.
- Shop-owner printer preference is **not** a proof that Windows actually used that printer. The operator must verify actual paper.
- No verified page meter or automatic fee is collected. Demo printed pages and ₹0.15/page platform usage are still recorded manually by Super Admin after physical confirmation.
