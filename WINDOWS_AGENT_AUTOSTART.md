# Windows Printer Agent: Auto-connect after Windows sign-in

QR-To-Print can now start its Windows Printer Agent automatically after each sign-in to the SAME Windows user account. One-time setup is required on EACH shop PC.

**This is NOT automatic printing.** The Agent reports the PC's printer names and online status, and can optionally perform a separate owner-approved fixed Canon diagnostic. It NEVER downloads/prints customer documents automatically. Customer files still require shop-owner review and manual printing.

**Login requirement:** The Windows user must first sign in; this setup deliberately does not run before the Windows login screen.

## Prerequisites

- Windows 10/11 PC with a working local Canon, HP, Epson, Brother or other compatible Windows printer and internet connection.
- Node.js 20+ installed and available via normal user PATH.
- An active shop owner's account: https://qr-to-print-new.onrender.com/shop-dashboard.html
- Trusted GitHub ZIP: https://github.com/mahadeventerprises24102024-ship-it/qr-to-print-new/archive/refs/heads/main.zip
- Use a normal Windows user. Do NOT choose Run as administrator.

## Install once

1. Open Shop Dashboard > Printers > Generate secure Windows pairing key > Copy pairing key.
2. On that SAME printer PC, download the repository ZIP and click Extract All.
3. In the extracted folder, double-click **Install-QR-To-Print-Agent.cmd**.
4. Installer uses the valid pairing key from the Windows clipboard. If clipboard is empty, it requests a hidden key entry. Never paste or screenshot the key in chat or GitHub.
5. Installer verifies Node.js, encrypts the key using Windows-user-bound DPAPI in a restricted folder inside LocalAppData, and registers a Windows Task Scheduler task which starts each time this user signs in.
6. Initial task launch is requested. Visit Shop Dashboard > Printers > Refresh status. Verify the Agent says **Online**. A registered task alone does not prove the connection succeeded.
7. After your next Windows sign-in, verify the Agent becomes Online without key entry.

The Agent keeps retrying after transient internet outages and reports installed printer names to its owning shop only.

## Security details

- Windows task name: QR-To-Print-Agent followed by the current Windows user SID.
- Uses Task Scheduler Logon trigger, Interactive user principal, Limited privileges, and no Windows login password.
- Encrypted secret path: %LOCALAPPDATA%\QR-To-Print-Agent\pairing-key.dpapi. No plaintext key is written to files, command-line arguments, GitHub or task definitions.
- Windows DPAPI normally allows decryption only for the same Windows user. Windows SYSTEM/local Administrators also have folder access.
- Windows Agent --auto-start mode refuses to use a clipboard value when its encrypted pairing key is missing or cannot be decrypted.
- Pairing key is sent over HTTPS as a bearer token for the existing authenticated heartbeat, never displayed in Agent logs; server stores only the hash.
- Windows policy may block scheduling tasks; do not weaken system protections. Contact the PC administrator if that happens.
- The .cmd runs only the trusted extracted PowerShell installer with a process-scoped execution policy override; no permanent system policy change is needed.
- This installer has automated source tests, but still needs a real Windows PC test for your specific Windows permissions, printers and network.

## Remove, rotate, troubleshoot

- **Uninstall:** In the ZIP folder, double-click **Uninstall-QR-To-Print-Agent.cmd** as the same Windows user. This removes the scheduled task and encrypted local key. Then in the Shop Dashboard click **Revoke connection** to invalidate the server key. This matters in case an older Node Agent process remains active.
- **New pairing key:** Creating another pairing key revokes the old one. Copy the new key and rerun the installer on the shop PC.
- **Not paired:** Generate/copy a valid key, then reinstall.
- **Paired, offline:** Confirm Windows signed in, correct local account, Node.js present, PC online, Task Scheduler task running and pairing key not revoked.
- **Online:** The device is reporting its printer names and heartbeat, but real customer auto-printing remains disabled.
- **Other printer brands:** Printer names can be discovered; local browser printing still requires shop approval and selecting the actual printer in the native dialog.

For **real customer uploads**, additional production work remains: malware scanning, encrypted storage/retention, abuse controls, backups, and human-verified printing. Do not use real private customer documents in TEST mode.
