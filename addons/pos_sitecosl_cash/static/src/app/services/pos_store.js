/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
//import { SitecoServicioCobroService} from "@pos_sitecosl_cash/sitecosl";
//import { SitecoServicioCobroService } from "@pos_sitecosl_cash/static/src/sitecosl";
import { SitecoServicioCobroService } from "@pos_sitecosl_cash/sitecosl";

patch(PosStore.prototype, {
    async processServerData(...args) {
        await super.processServerData(...args);

        for (const pm of this.models["pos.payment.method"].getAll()) {
            // ✅ ESTE es el campo correcto (igual que Glory)
            if (pm.payment_method_type === "sitecosl_cash") {
                // ✅ evita doble instancia si se ejecuta 2 veces
                if (!pm.payment_terminal) {
                    pm.payment_terminal = new SitecoServicioCobroService(this, pm);
                    console.log("[SITECOSL] PM", pm.id, pm.name, pm.payment_method_type, pm.sitecosl_host_address);
                }
            }
        }
    },
});

