/* ==========================================================
   PUBLIC SITE CONFIGURATION — the one place to edit on the website.
   Everything here is PUBLIC (anyone can read this file).
   NEVER put secret keys, webhook secrets, private download links
   or passwords here. Secrets live in the API's secret store (see SETUP.md).
   Leave a value "" until you have the REAL one: empty values make
   the site show honest "not available / not published" states.
   ========================================================== */
window.ZYVTRON_CONFIG = {
  siteUrl: "https://changajatt.github.io/2",  // where this site is hosted (no trailing slash). Change when you add a custom domain.

  // --- Purchase: choose ONE mode ---
  apiBase: "",        // MODE A (full automation): public https URL of your deployed API (api/ folder), e.g. https://zyvtron-api.<you>.workers.dev
  checkoutUrl: "",    // MODE B (simplest): a hosted payment-link URL from a provider that sells AND delivers files itself. Used only if apiBase is empty.
  priceLabel: "$27 USD", // Shown until the API reports its own price (API price is authoritative in Mode A). Must match what is charged.

  // --- Support and policies (only YOU can supply these) ---
  supportEmail: "",   // real, monitored support inbox
  policiesApproved: false, // set true ONLY after you have reviewed and approved the four policy pages (with a lawyer if possible)
  policiesUpdated: "",     // e.g. "1 March 2027" (shown as the effective date)
  business: { name: "", jurisdiction: "", address: "" }, // legal/trading name; governing country/state; address if required where you operate
  paymentProviderName: "", // e.g. the gateway you chose (named in the privacy policy)
  emailProviderName: "",   // e.g. the email service you chose (named in the privacy policy)
  refundTerms: [],    // YOUR actual refund/cancellation conditions, one sentence per item, e.g. ["…", "…"]. Empty = refund page stays unpublished.

  // --- Mode B only (Mode A states delivery automatically once the API reports it is ready) ---
  deliveryNote: "",   // one honest sentence about how the provider delivers the file
  refundNote: ""      // optional one-line summary of refund terms for the buy box
};
