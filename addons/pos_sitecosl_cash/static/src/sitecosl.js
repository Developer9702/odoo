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

        //Flag para indicar si está en proceso de cobro o no
        this._paymentInProgress = true/false;

        //Timers conexion y health check
        this._timer = null;
        this._failCount = 0;
        this._hasEverConnected = false;
        this._lastPopupAt = 0;

        //Flags para pop up de conexion
        this._shownConnectedOnce = false;
        this._shownDisconnectedOnce = false;
        this._lastStatus = null; // "CONNECTED" | "DISCONNECTED"

        // tiempos (ajústalos a gusto)
        this.RETRY_MS_DISCONNECTED = 5000;   // cuando falla
        this.HEALTHCHECK_MS_CONNECTED = 30000; // cuando va bien
        this.FAILS_BEFORE_POPUP = 3;        // umbral
        this.POPUP_COOLDOWN_MS = 60000;     // 1 min

        console.log(
        "[SITECOSL] setup() called id=",this.payment_method_id?.id,
        "host=",this.payment_method_id?.sitecosl_host_address );

       this.state = reactive({
            status: "DISCONNECTED",
        });

        this._startHealthLoop();

        console.log("[SITECOSL] setup() called", this.payment_method_id);
    }

    get hostAddress() {
        return this.payment_method_id.sitecosl_host_address || "127.0.0.1:8080";
    }

    //Verifica la conexión con el servicio web
    async checkConnection({ silent = false } = {}) {
        try {
            const result = await appInfo(this.hostAddress);

            // ✅ soporta objeto o boolean por seguridad
            const ok = typeof result === "boolean" ? result : !!result.ok;
            const error = typeof result === "object" && result ? (result.error || null) : null;

            console.log(
                "[SITECOSL] AppInfo raw result id=",
                this.payment_method_id?.id,
                "host=",
                this.hostAddress,
                "result=",
                result,
                "computed ok=",
                ok
            );

            if (!ok && !silent) {
                this.showError(this._makeConnectionErrorMessage(error));
            }
            return { ok, error };
        } catch (e) {
            console.error("[SITECOSL] AppInfo ERROR:", e);
            const error = e?.message || String(e);
            if (!silent) {
                this.showError(this._makeConnectionErrorMessage(error));
            }
            return { ok: false, error };
        }
    }


    // Esto lo llamará Odoo cuando intentes cobrar con este método
    async send_payment_request() {
        console.log("[SITECO SL ]: LLEGA EL INTENTO DE COBRO");
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

    _makeConnectionErrorMessage(details) {
        // Mensaje “bonito” como Glory, sin detalles técnicos
        const base = _t(
            "Failed to connect to Siteco cash service. Please ensure it is running and reachable from the POS."
        );

        // Si quieres mostrar detalles SOLO a veces, puedes concatenarlo.
        // Yo por defecto lo dejaría fuera para no confundir a usuario.
        if (!details) return base;

        // Si quieres incluir detalles:
        // return `${base}\n\n${_t("Details")}: ${details}`;

        return base;
    }


   _startHealthLoop() {
        if (this._timer) clearTimeout(this._timer);

        const tick = async () => {
            const { ok, error } = await this.checkConnection({ silent: true });

            if (ok) {
                this._failCount = 0;
                this._hasEverConnected = true;
                this.state.status = "CONNECTED";

                //Aviso UNA vez cuando cambia a conectado
                this._notifyStatusOnce("CONNECTED");

                this._timer = setTimeout(tick, this.HEALTHCHECK_MS_CONNECTED);
                return;
            }

            this.state.status = "DISCONNECTED";
            this._failCount += 1;

            //Solo avisar UNA vez de desconexión, y solo tras N fallos seguidos
            if (this._failCount >= this.FAILS_BEFORE_POPUP) {
                this._notifyStatusOnce("DISCONNECTED", error);
            }

            console.log(
                `[SITECOSL] Disconnected (fail #${this._failCount}). Retrying in ${this.RETRY_MS_DISCONNECTED}ms`,
                error || ""
            );
            //Si está en proceso de pago, no se consulta el estado.
            if(this._paymentInProgress){
            this._timer = setTimeout(tick, this.RETRY_MS_DISCONNECTED);
            return;
            }
        };

        tick();
    }

    _notifyStatusOnce(newStatus, details = null) {
        // Si no ha cambiado, no hagas nada
        if (this._lastStatus === newStatus) return;

        this._lastStatus = newStatus;

        if (newStatus === "CONNECTED") {
            // resetea el de desconectado para futuros cambios
            this._shownDisconnectedOnce = false;

            if (!this._shownConnectedOnce) {
                this._shownConnectedOnce = true;
                this.showInfo(
                    _t("Connected to Siteco Cash Machine."),
                    _t("Cash Machine")
                );
            }
            return;
        }

        if (newStatus === "DISCONNECTED") {
            // resetea el de conectado para futuros cambios
            this._shownConnectedOnce = false;

            if (!this._shownDisconnectedOnce) {
                this._shownDisconnectedOnce = true;
                this.showError(
                    this._makeConnectionErrorMessage(details),
                    _t("Cash Machine Error")
                );
            }
        }
    }
    showInfo(msg, title) {
    this.dialog.add(AlertDialog, {
        title: title || _t("Information"),
        body: msg,
    });
}



}
