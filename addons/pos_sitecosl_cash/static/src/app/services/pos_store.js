import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
//import { SitecoServicioCobroService} from "@pos_sitecosl_cash/sitecosl";
//import { SitecoServicioCobroService } from "@pos_sitecosl_cash/static/src/sitecosl";
import { SitecoServicioCobroService } from "@pos_sitecosl_cash/sitecosl";


patch(PosStore.prototype, {
    async processServerData() {
        await super.processServerData();
        const methods = this.models["pos.payment.method"].getAll();
        console.log("[SITECOSL] payment methods loaded:", methods);
        for (const pm of this.models["pos.payment.method"].getAll()) {
            if (pm.payment_method_type === "sitecosl_cash") {
                pm.payment_terminal = new SitecoServicioCobroService(this, pm);
            }
        }
    },
});
