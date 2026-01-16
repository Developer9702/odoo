import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { SitecoServicioCobroService} from "@pos_sitecosl_cash/sitecosl";

patch(PosStore.prototype, {
    async processServerData() {
        await super.processServerData();
        for (const pm of this.models["pos.payment.method"].getAll()) {
            if (pm.payment_method_type === "sitecosl_cash") {
                pm.payment_terminal = new SitecoServicioCobroService(this, pm);
            }
        }
    },
});
