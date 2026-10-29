# QR-To-Print Windows Printer PC — Connection & Test Features

The **baseline connection feature** sends only a heartbeat and an integer printer count.
The agent also supports two **separately enabled, owner-approved TEST-only**
printing experiments: a fixed Canon G2010 page, and a small, reviewed private
PDF/photo sample. The private file test requires
`ENABLE_OWNER_APPROVED_TEST_PRINTS=true`, private test storage and an
independent SumatraPDF installation. See [Owner-approved test print setup](OWNER_APPROVED_AGENT_TEST_PRINT.md).
No normal/production customer printing or billing is enabled.

## Before you start

- Use **your shop's Windows PC** with Windows PowerShell and Node.js 20+ installed.
- Keep using a disposable shop account and test-only documents. Never print real customer material through this preview.
- The current test server is **https://qr-to-print-new.onrender.com**. Migrating to `qrtoprint.in` requires separate URL/domain changes and production safety reviews.
- Do **not** share your shop agent pairing key in ChatGPT, GitHub, logs, PowerShell commands, screenshots, or messages.

## Steps

1. Open `https://qr-to-print-new.onrender.com/shop-login.html` and sign in as the **shop owner**.
2. In Shop Dashboard, open **Printers** in the left navigation.
3. Click **Generate printer PC pairing key** and confirm. This invalidates any previous key.
4. Click **Copy pairing key**. The key is only displayed once and hidden after copying or after 90 seconds.
5. In a Windows browser, visit the repository: `https://github.com/mahadeventerprises24102024-ship-it/qr-to-print-new`.
6. Click **Code → Download ZIP**, then extract the ZIP to a local folder.
7. In File Explorer, open the extracted project folder containing `windows-print-agent.js`. Right-click an empty area → **Open in Terminal**, or open PowerShell and navigate there.
8. First, click **Copy pairing key** in the shop Dashboard. With that key still in the Windows clipboard, open the project folder in PowerShell or CMD and run:

   ```powershell
   node windows-print-agent.js
   ```

   **No paste is needed.** The new agent automatically checks the Windows clipboard for the copied key. If a correct key is found, it starts connecting. If not, it displays the older hidden-key prompt; copy the key again, close that prompt with Ctrl+C, and rerun the script. The key is not written to a file or shown on the screen.

9. The tool will try to count printers using Windows `Get-Printer`. It sends a small authenticated heartbeat every 30 seconds. PowerShell stays open while it runs.
10. Back in the Shop Dashboard → **Printers**, click **Refresh status**. You should see **Online (test heartbeat)**, the number of installed Windows printers, and the last heartbeat time.

## Troubleshooting

- **`node` not recognized**: install Node.js 20 or later and reopen PowerShell.
- **Printer count 0**: verify printers under Windows Settings → Bluetooth & devices → Printers & scanners. The agent also returns 0 if Get-Printer cannot run, so it does not prove no devices exist.
- **Paired, offline**: keep the Windows terminal open; check the internet connection; wait until the next heartbeat (30 seconds), then refresh.
- **401 rejected/revoked**: Generate a new pairing key and restart the Windows script with the new key.
- **Render idle delay**: Free plans may sleep and delay the first heartbeat; keep the terminal running to retry.
- **Unauthorized connection**: Click **Revoke connection** to invalidate the key immediately and stop the Windows script. Creating a replacement key also invalidates any earlier key.

## Privacy and security

- The pairing key has 256 bits of randomness and is stored only as a SHA-256 hash in PostgreSQL. The plaintext is sent once to the logged-in shop owner. Protect it like a password.
- Shop dashboard endpoints require an authenticated shop-owner session; database queries scope status and updates to that shop.
- The agent's `POST /api/agent/heartbeat` and opt-in claimed-job `GET /api/agent/approved-test-print/:jobId/file` use the bearer token and reject browser Origins. The file endpoint additionally checks shop ownership, job status, expiry and R2 digest. Other state-changing APIs retain their same-origin checks.
- Each shop can have one active agent pairing key; rotating or revoking it disconnects the previous one.
- No printer model names, file contents or IP addresses are sent in the heartbeat. Only when the owner separately enables and approves the private TEST print feature does the paired agent download one bounded, verified private test sample. Render logs can include standard request metadata.
- **Printer count is informational only**; it does not mean any printer is configured to accept jobs.
- The pairing key is never written to disk by the agent. Windows clipboard history or clipboard sync could retain a copied key; after starting the agent, clear your Windows clipboard by copying harmless text or using Windows clipboard controls.
- If you close the terminal, copy the pairing key again only if you saved it securely outside the terminal. Otherwise generate a new key in Shop Dashboard to invalidate the lost one.

## Production work remaining

Printer discovery/selection, secure per-job authorization, malware scanning of uploaded files, safe rendering, print preview, printer drivers, spooler error handling, cancellation, job reporting, rate limits, billing and audit logs. Production and real printing must remain disabled until these are designed and tested.

Connection can be verified independently of printing. Optional, owner-approved diagnostic/sample printing is documented separately; production customer printing remains disabled.
