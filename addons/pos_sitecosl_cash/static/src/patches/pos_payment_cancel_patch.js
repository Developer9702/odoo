/** @odoo-module **/
console.log("[SITECOSL] pos_payment_cancel_patch LOADED");

import { patch } from "@web/core/utils/patch";
import { PosPayment } from "@point_of_sale/app/models/pos_payment";

patch(PosPayment.prototype, {
    async cancel() {
        const pm = this.payment_method_id;
        const terminal = pm?.payment_terminal;
        const order = this.pos?.getOrder?.();

        // Solo Siteco
        if (pm?.payment_method_type === "sitecosl_cash" && terminal) {
            console.log("[SITECOSL] PosPayment.cancel() -> forwarding to terminal", {
                uuid: this.uuid,
                paymentId: this.id,
            });

            // Esto es lo que PaymentInterface documenta
            if (typeof terminal.sendPaymentCancel === "function") {
                await terminal.sendPaymentCancel(order, this.uuid);
            }
        }

        // Comportamiento normal: borrar línea, etc.
        return await super.cancel(...arguments);
    },
});
