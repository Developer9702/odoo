import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface"; //la clase base que Odoo usa para integrar “terminales” o métodos de pago especiales.
import { uuidv4 } from "@point_of_sale/utils";
//import { CancelDialog } from "@pos_sitecosl_cash/app/components/cancel_dialog";
import { reactive } from "@odoo/owl"; //Framework UI de Odoo
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog"; //Popup error o info
import { _t } from "@web/core/l10n/translation"; //Traducciones
import { sortBy } from "@web/core/utils/arrays"; //Ordenar arrays
import { browser } from "@web/core/browser/browser"; //Info navegador
import { ask } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { Logger } from "@bus/workers/bus_worker_utils"; //Archivo logger

//Propios de siteco
import { appInfo  } from "@pos_sitecosl_cash/utils/sitecosl_soap";

console.log("[SITECOSL] sitecosl.js loaded");

export class SitecoServicioCobroService extends PaymentInterface {
   setup() {
        super.setup(...arguments);
        this.dialog = this.env.services.dialog;
        this.logger = new Logger("pos_sitecosl_cash");

        this.state = reactive({
            status: "DISCONNECTED", // CONNECTED | DISCONNECTED
        });

        console.log("[SITECOSL] setup() called", this.payment_method_id);

        // Comprueba conexión al iniciar el servicio
        this.checkConnection();
    }

    get hostAddress() {
        return this.payment_method_id.sitecosl_host_address || "127.0.0.1:8080";
    }

    async checkConnection() {
        try {
        const ok = await appInfo(this.hostAddress);

        console.log(
            "[SITECOSL] AppInfo:",
            ok ? "CONNECTED" : "DISCONNECTED",
            "host:",
            this.hostAddress
        );

        this.state.status = ok ? "CONNECTED" : "DISCONNECTED";
        if (!ok) {
            this.showError(_t("Siteco service is not responding (AppInfo)."));
        }
        } catch (e) {
            this.state.status = "DISCONNECTED";
            console.error("[SITECOSL] AppInfo ERROR:", e);
            this.showError(_t("Failed to connect to Siteco service (AppInfo)."));
        }
    }


    // Esto lo llamará Odoo cuando intentes cobrar con este método
    async send_payment_request() {
        // Por ahora solo validamos conexión
        if (this.state.status !== "CONNECTED") {
            await this.checkConnection();
        }
        if (this.state.status !== "CONNECTED") {
            return false;
        }

        // Aquí, en la siguiente fase, irá "iniciar cobro" con el SOAP real
        this.showError(_t("Siteco payment not implemented yet (only AppInfo check)."));
        return false;
    }

    async send_payment_cancel() {
        // Cuando implementemos cobro real, aquí irá la cancelación SOAP
        return true;
    }

    showError(msg, title) {
        this.dialog.add(AlertDialog, {
            title: title || _t("Cash Machine Error"),
            body: msg,
        });
    }
}
