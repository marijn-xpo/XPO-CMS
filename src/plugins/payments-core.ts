import { registerPlugin, registerPaymentProvider } from "../core/plugins.js";

registerPlugin({
  name: "payments-core",
  setup() {
    registerPaymentProvider({
      name: "stub", label: "Lokale teststub",
      createPayment(i) { return { id: "stub_" + Math.random().toString(36).slice(2, 10), checkoutUrl: "/pay/" + i.orderRef }; },
    });
    registerPaymentProvider({
      name: "mollie", label: "Mollie (iDEAL, kaarten, Apple Pay)",
      async createPayment(i) {
        const key = process.env.MOLLIE_KEY;
        if (!key) return { id: "mollie_unconfigured_" + i.orderRef, checkoutUrl: "/pay/" + i.orderRef };
        // Echte Mollie-call gaat hier (fetch naar api.mollie.com) zodra de live-sleutel is gezet.
        return { id: "mollie_" + Math.random().toString(36).slice(2, 10), checkoutUrl: "https://www.mollie.com/checkout/" + i.orderRef };
      },
    });
  },
});
