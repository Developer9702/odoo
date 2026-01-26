/** @odoo-module **/

console.log("[SITECOSL] payment_screen_force_done_patch LOADED");

import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";

patch(PaymentScreen.prototype, {
    async sendForceDone(line) {
        const pm = line?.payment_method_id;
        const terminal = pm?.payment_terminal;

        // Solo Siteco: Force Done = Cancel
        if (pm?.payment_method_type === "sitecosl_cash" && terminal) {
            console.log("[SITECOSL] Force Done clicked -> calling terminal.sendPaymentCancel()", {
                uuid: line.uuid,
                paymentId: line.id,
                pmId: pm.id,
            });

            const order = this.pos.getOrder();

            // Llama al contrato de PaymentInterface:
            if (typeof terminal.sendPaymentCancel === "function") {
                await terminal.sendPaymentCancel(order, line.uuid);
            } else if (typeof terminal.send_payment_cancel === "function") {
                await terminal.send_payment_cancel(order, line.uuid);
            } else {
                console.warn("[SITECOSL] terminal has no sendPaymentCancel");
            }

            // Deja la línea en estado "retry" para que NO quede como done
            if (typeof line.setPaymentStatus === "function") line.setPaymentStatus("retry");
            else if (typeof line.set_payment_status === "function") line.set_payment_status("retry");
            else line.payment_status = "retry";

            if (typeof line.setAmount === "function") line.setAmount(0);
            else line.amount = 0;

            return false;
        }

        // resto de métodos, comportamiento normal
        return await super.sendForceDone(...arguments);
    },
});
