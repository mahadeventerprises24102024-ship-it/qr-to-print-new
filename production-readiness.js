"use strict";

// Only factual, server-checkable prerequisites. Never present a missing
// capability as ready just because an operator set an environment flag.
const { storageSettings, guestTestUploadsEnabled } = require("./private-test-uploads");

function productionReadiness(env = process.env) {
  const storage = storageSettings(env);
  const guest = guestTestUploadsEnabled(env);
  const checks = [
    {
      id: "private_storage",
      label: "Private file storage configuration",
      ready: storage.enabled,
      detail: storage.enabled ?
        "R2 credentials and a valid private endpoint are configured (access and lifecycle still need independent verification)." :
        "Configure a private R2 bucket, credentials and ENABLE_TEST_UPLOADS only for harmless sample files."
    },
    {
      id: "guest_sample_upload",
      label: "Guest SAMPLE upload opt-in",
      ready: guest,
      detail: guest ?
        "Harmless guest SAMPLE uploads are opted in; this is NOT permission for sensitive files." :
        "Guest sample uploads are off; enable only after checking private storage and sample-only limits."
    },
    {
      id: "malware_scan",
      label: "Malware scanning and file sanitization",
      ready: false,
      detail: "The current signature checks are not virus scanning. Install and validate fail-closed scanning/CDR and sandboxed decoding before any real document uploads."
    },
    {
      id: "isolated_rendering",
      label: "Isolated PDF/image rendering",
      ready: false,
      detail: "A hardened worker and document rendering sandbox are not implemented for untrusted customer files."
    },
    {
      id: "retention",
      label: "Verified encryption, access and automatic deletion",
      ready: false,
      detail: "Private bucket access, encryption, 24-hour object expiry, and deletion/audit controls have not been independently verified end to end."
    },
    {
      id: "payment_settlement",
      label: "Trusted payment settlement reconciliation",
      ready: false,
      detail: "The UPI claim flow requires the owner to check real bank credit manually; customer claims must never automatically release a job."
    },
    {
      id: "printer_queue",
      label: "Auditable printer queue and safe release",
      ready: false,
      detail: "The browser opens an owner-controlled print dialog after owner confirmation, not an isolated production queue with delivery/print guarantees."
    }
  ];
  // This product does not have a genuine-document release mode.
  // Never make this depend on a single environment flag.
  return {
    productionReady: false,
    documentUploads: "SAMPLE_ONLY",
    printRelease: "OWNER_VERIFIED_BROWSER_DIALOG_ONLY",
    canAcceptRealIdentityDocuments: false,
    checks,
    note: "Website and shop management are live; production handling of real Aadhaar/PAN/personal files is not enabled. No admin toggle can bypass these requirements."
  };
}
module.exports = { productionReadiness };
