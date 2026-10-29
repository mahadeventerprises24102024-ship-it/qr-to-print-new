# Canon PIXMA G2010 — owner-approved TEST page only

This milestone adds **one fixed text diagnostic page** to verify that the shop
dashboard can request a page and the paired Windows agent can submit it to the
Canon G2010 driver. This is not customer document printing.

## Before enabling

1. Verify your Canon G2010 prints a Windows test page (already tested by shop).
2. Review and merge the GitHub pull request after CI passes.
3. In Render service `qr-to-print-new`, go to **Environment**.
4. Add `ENABLE_CANON_TEST_PRINT` with value `true` only when you are ready
   to spend paper/ink on manual tests. **Default is OFF.**
5. Save the variable and wait for Render's deployment to finish.
6. Download a **fresh main-branch ZIP** (the old Windows agent cannot print).
7. Extract, then open CMD inside the new project folder.
8. In Shop Dashboard > Printers click **Generate printer PC pairing key** and
   **Copy pairing key**. Starting a new pairing key invalidates the old PC.
9. Run `node windows-print-agent.js`. The updated agent automatically reads
   a copied key from your Windows clipboard. Keep CMD open.
10. In Shop Dashboard > Printers, confirm Windows Agent is online, then
    click **Print Canon G2010 TEST page** and explicitly confirm.
11. Refresh test status. `submitted` means only the Windows print queue
    accepted the diagnostic command. Physically check the Canon printer.
12. Copy harmless text to clipboard after setup to avoid retaining the key.

## Safety constraints

- Nothing prints unless the shop owner clicks the diagnostic button and confirms.
- Only one fixed text page can be sent per request, with at most one active
  request per shop and at most 5 requests per hour.
- Queued requests expire after 5 minutes; claimed requests after 10 minutes.
  The claimed request is **never retried**, preventing repeat printing after
  intermittent connections.
- The server does not send any file bytes, URLs, text payloads or printer
  command arguments to the agent; just a fixed test job ID and kind.
- Windows agent locally selects a Windows printer named like
  `Canon G2010 series`; if missing or inaccessible, it records failure.
- Customer PDF/photo printing, prices, payment, third-party printing and
  automatic customer order processing are **disabled**.
- You can disable future diagnostic requests by setting the environment
  variable to `false` in Render. Revoke Agent connection if compromised.
- Print status does not verify paper physically printed: `submitted` only
  means the print request was sent to the Windows spooler.
- If you restart CMD and no longer have the secret, generate/copy a fresh key.
  Do not put the key in chat, code, screenshots, files, or command-line args.

## Common issues

**Button disabled:** Check Render variable and that Windows Agent is Online;
refresh the dashboard.

**Job stays queued:** New Windows Agent not running, or disconnected; old
versions only report heartbeat and cannot print.

**Job failed:** In Windows, check the G2010 name under `control printers`
and verify a normal Windows test page works. The local command only targets
`Canon G2010 series`, not arbitrary printers.

**No page, status submitted:** Inspect Windows printer queue, paper/ink,
driver errors or offline status. Submitted does not guarantee physical output.

**Want to stop:** Close CMD with Ctrl+C, disable the Render flag, or revoke
the pairing key in Dashboard. Already submitted Windows spooler pages may
require canceling from Windows queue.
