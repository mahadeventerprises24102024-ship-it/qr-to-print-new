# QR-To-Print Windows Printer PC — Connection Preview

This feature is a **printer-PC connection test only**. It does **not** send customer files, download documents, produce paper prints, charge customers, or turn on a print queue. Only a heartbeat and an integer count of Windows-installed printers are transmitted to the shop's Render backend.

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
- Only the single `POST /api/agent/heartbeat` endpoint accepts a non-browser request without an Origin header; it requires a valid bearer key and rejects browser Origins. Other API mutations retain their original same-origin checks.
- Each shop can have one active agent pairing key; rotating or revoking it disconnects the previous one.
- No printer model names, file contents, documents, IP addresses inside the heartbeat payload, or customer data are transmitted by the Windows script. Render web logs and access logs can still contain standard request metadata.
- **Printer count is informational only**; it does not mean any printer is configured to accept jobs.
- The pairing key is never written to disk by the agent. Windows clipboard history or clipboard sync could retain a copied key; after starting the agent, clear your Windows clipboard by copying harmless text or using Windows clipboard controls.
- If you close the terminal, copy the pairing key again only if you saved it securely outside the terminal. Otherwise generate a new key in Shop Dashboard to invalidate the lost one.

## Production work remaining

Printer discovery/selection, secure per-job authorization, malware scanning of uploaded files, safe rendering, print preview, printer drivers, spooler error handling, cancellation, job reporting, rate limits, billing and audit logs. Production and real printing must remain disabled until these are designed and tested.

This phase only verifies that the shop's own Windows PC can securely send a heartbeat and display **Online** in the QR-To-Print Dashboard.
