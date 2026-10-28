# Test-only Print Requests

This adds a limited demonstration of order details, not real printing.

- A shop QR opens /print.html with that shop's public code.
- A customer selects a sample PDF, PNG or JPG locally and chooses 1-10 copies.
- Only document type, reported size and copy count are sent as JSON.
- No document contents or filename are sent or saved.
- The shop owner can view the last 30 test requests in Shop Dashboard > Print orders.
- Nothing is billed, downloaded or sent to a printer.

## Check after deployment

1. Open a signed-in shop dashboard.
2. Scan the QR and choose a non-sensitive test file up to 10 MB.
3. Send the test request details and note its ID.
4. Return to the shop dashboard, open Print orders, and press Refresh orders.
5. Confirm it appears with the right type and number of copies.
6. Logout and confirm the private owner orders API returns 401.
7. Confirm the existing Login and QR features still work.

Limits: 8 demo submissions per IP per hour, maximum 30 per shop. Data is for prototyping only. Render's free database is temporary. Real print orders require secure persistent file storage, authorization and a printer agent, none of which are included here.
