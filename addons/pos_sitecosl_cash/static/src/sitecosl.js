/** @odoo-module **/
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
import { patch } from "@web/core/utils/patch";
import { PosPayment } from "@point_of_sale/app/models/pos_payment";

//Propios de siteco
import {appInfo,
        sitecoStartPayment,
        sitecoGetPaymentStatus,
        sitecoCancelPayment,
        sitecoGetInventory ,
} from "@pos_sitecosl_cash/utils/sitecosl_soap";

this.state = reactive({
  status: "DISCONNECTED",
  inventory: [],
});

console.log("[SITECOSL] sitecosl.js loaded");

export class SitecoServicioCobroService extends PaymentInterface {
   setup() {
        super.setup(...arguments);
        this.dialog = this.env.services.dialog;
        this.logger = new Logger("pos_sitecosl_cash");

        //Flag para indicar si está en proceso de cobro o no
        this._paymentInProgress = false;
        this._cancelRequested = false;
        this._currentOperationId = null;

        //Timers conexion y health check
        this._timer = null;
        this._failCount = 0;
        this._hasEverConnected = false;
        this._lastPopupAt = 0;

        //Flags para pop up de conexion
        this._shownConnectedOnce = false;
        this._shownDisconnectedOnce = false;
        this._lastStatus = null; // "CONNECTED" | "DISCONNECTED"

        // tiempos para revisar la conexión con la máquina
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

    // ---------------------------
    // HEALTH CHECK (AppInfo)
    // ---------------------------

    //Verifica la conexión con el servicio web
    async checkConnection({ silent = false } = {}) {
        try {
            const result = await appInfo(this.hostAddress);
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
    
    _startHealthLoop() {
        if (this._timer) clearTimeout(this._timer);

        const tick = async () => {
            // durante cobro, no molestamos con health-check
            if (this._paymentInProgress) {
                this._timer = setTimeout(tick, this.HEALTHCHECK_MS_CONNECTED);
                return;
            }

            const { ok, error } = await this.checkConnection({ silent: true });

            if (ok) {
                this._failCount = 0;
                this.state.status = "CONNECTED";
                this._notifyStatusOnce("CONNECTED");
                this._timer = setTimeout(tick, this.HEALTHCHECK_MS_CONNECTED);
                await this.refreshInventory();

                return;
            }

            this.state.status = "DISCONNECTED";
            this._failCount += 1;

            if (this._failCount >= this.FAILS_BEFORE_POPUP) {
                this._notifyStatusOnce("DISCONNECTED", error);
            }

            console.log(
                `[SITECOSL] Disconnected (fail #${this._failCount}). Retrying in ${this.RETRY_MS_DISCONNECTED}ms`,
                error || ""
            );

            this._timer = setTimeout(tick, this.RETRY_MS_DISCONNECTED);
        };

        tick();
    }

    _notifyStatusOnce(newStatus, details = null) {
        if (this._lastStatus === newStatus) return;
        this._lastStatus = newStatus;

        if (newStatus === "CONNECTED") {
            this._shownDisconnectedOnce = false;
            if (!this._shownConnectedOnce) {
                this._shownConnectedOnce = true;
                this.showInfo(_t("Connected to Siteco cash service."), _t("Cash Machine"));
            }
            return;
        }

        if (newStatus === "DISCONNECTED") {
            this._shownConnectedOnce = false;
            if (!this._shownDisconnectedOnce) {
                this._shownDisconnectedOnce = true;
                this.showError(this._makeConnectionErrorMessage(details), _t("Cash Machine Error"));
            }
        }
    }

    _makeConnectionErrorMessage(details) {
        const base = _t(
            "Failed to connect to Siteco cash service. Please ensure it is running and reachable from the POS."
        );
        return base;
    }

    // ---------------------------
    // PAYMENT FLOW (CobrarHasta + polling)
    // ---------------------------
    get paymentLine() {
        const order = this.pos.getOrder();
        if (!order) return null;
        const lines = order.payment_ids.filter(
            (l) => l.payment_method_id === this.payment_method_id
        );

        // línea “activa” (en curso o esperando)
        return lines.find((l) => ["waiting", "waitingCancel"].includes(l.payment_status)) || lines.at(-1) || null;
    }

    _setLineStatus(line, status) {
        // status: "waiting" | "done" | "retry" | "waitingCancel"
        if (!line) return;

        if (typeof line.setPaymentStatus === "function") {
            line.setPaymentStatus(status);
            return;
        }
        if (typeof line.set_payment_status === "function") {
            line.set_payment_status(status);
            return;
        }
        // fallback: asignación directa
        line.payment_status = status;
    }


   async sendPaymentRequest() {
        console.log("[SITECOSL] sendPaymentRequest()");

        // 1) Verificar conexión
        if (this.state.status !== "CONNECTED") {
            const { ok } = await this.checkConnection({ silent: false });
            this.state.status = ok ? "CONNECTED" : "DISCONNECTED";
            if (!ok) return false;
        }

        const order = this.pos.getOrder();
        const line = this.paymentLine;

        if (!order || !line) {
            this.showError(_t("No active payment line found for Siteco."));
            return false;
        }

        // Importe en céntimos
        const cents = Math.round(line.amount * Math.pow(10, this.pos.currency.decimal_places));
        if (!cents || cents <= 0) {
            this.showError(_t("Invalid amount for Siteco payment."));
            return false;
        }

        // Inicializa flags
        this._paymentInProgress = true;
        this._cancelRequested = false;
        this._currentOperationId = null;

        // Estado equivalente a C#
        let cobro = true;        // en C# empieza true y pasa a false si cancelas o timeout
        let cancelada = false;   // cancelOP
        let deuda = cents;       // por defecto si falla

        this._setLineStatus(line, "waiting");

        try {
            // 2) CobrarHasta + ConsultaCodigoUltimaOperacionVenta (hasta 40s) -> backend
            const startRes = await sitecoStartPayment(this.hostAddress, cents);
            if (!startRes?.ok || !startRes.operation_id) {
                this._setLineStatus(line, "retry");
                this.showError(_t("Failed to start Siteco payment.") + "\n\n" + (startRes?.error || ""));
                return false;
            }

            const opId = startRes.operation_id;
            this._currentOperationId = opId;

            // 3) Mientras SUB_EST_NCRSO hasta TIME_OPCURSO (1 min) o cancel
            const TIME_OPCURSO_MS = 60000; // 1 min como param.TIME_OPCURSO
            const POLL_MS = 500;
            const startedAt = Date.now();

            let st = null;

            while (Date.now() - startedAt < TIME_OPCURSO_MS) {
                // cancelación solicitada por UI
                if (this._cancelRequested) {
                    cancelada = true;
                    cobro = false;
                    break;
                }

                st = await sitecoGetPaymentStatus(this.hostAddress, opId);
                if (!st?.ok) {
                    this._setLineStatus(line, "retry");
                    this.showError(_t("Failed to read Siteco payment status.") + "\n\n" + (st?.error || ""));
                    return false;
                }

                console.log("[SITECOSL] status op=", opId, "state=", st.machine_state, "saldo=", st.saldo_cents);

                // sigue en curso
                if (st.machine_state === "SUB_EST_NCRSO") {
                    await new Promise((r) => setTimeout(r, POLL_MS));
                    continue;
                }

                // ya no está en curso => salimos y evaluamos
                break;
            }

          // 1) ¿Salimos por timeout (seguía NCRSO) o no tenemos st?
            const stillInCourse = !st || st.machine_state === "SUB_EST_NCRSO";

            // 2) Si hubo cancelación pedida por UI en cualquier momento
            cancelada = !!this._cancelRequested;

            // 3) Si sigue en curso (timeout) o si el usuario pidió cancelación:
            //    -> CancelacionOperacion + esperar ABRTD
            if (stillInCourse || cancelada) {
                // en C#: si sigue en curso o cancelOP => cobro=false y se cancela operación
                await this._cancelAndWaitAbort(opId);

                // forzamos estado "abortado" lógico (aunque el último st fuera NCRSO o null)
                st = { ...(st || {}), machine_state: "SUB_EST_ABRTD" };
            }

            // 4) deuda final
            const deuda = st?.deuda_cents ?? 0;

            // 5) estado final exacto:
            //    solo éxito si FINALIZADO + deuda 0 + NO cancelada
            const isSuccess =
                st.machine_state === "SUB_EST_FNLZD" && !cancelada;

            if (isSuccess) {
                this._setLineStatus(line, "done");

                  // Si hay deuda, avisamos pero NO fallamos
                    if (deuda > 0) {
                        const deudaAmount = deuda / Math.pow(10, this.pos.currency.decimal_places);
                        this.showInfo(
                            _t("Payment completed, but pending change to return: %s", deudaAmount),
                            _t("Cash Machine")
                        );
                    } else {
                        this.showInfo(_t("Payment completed successfully."), _t("Cash Machine"));
                    }
                return true;
            }

            // 6) Si se canceló (UI o timeout) => NO éxito
            if (cancelada || st.machine_state === "SUB_EST_ABRTD") {
                this._setLineStatus(line, "retry");
                if (line.setAmount) line.setAmount(0);
                else line.amount = 0;

                this.showError(_t("Payment cancelled."), _t("Cash Machine Error"));
                return false;
            }

            // 7) Si no cancelada pero deuda > 0 (o estado distinto) => fallo con deuda
            this._setLineStatus(line, "retry");
            const deudaAmount = deuda / Math.pow(10, this.pos.currency.decimal_places);
            this.showError(
                _t("Payment not completed. Remaining debt: %s", deudaAmount),
                _t("Cash Machine Error")
            );
            return false;

        } catch (e) {
            console.error("[SITECOSL] sendPaymentRequest ERROR:", e);
            this._setLineStatus(line, "retry");
            this.showError(_t("Unexpected error during payment."), _t("Cash Machine Error"));
            return false;
        } finally {
            // Resolver cancel si alguien pulsó “Forzar terminación”
            if (this.cancellationResolver) {
                this.cancellationResolver(false);
                this.cancellationResolver = null;
            }

            this._paymentInProgress = false;
            this._currentOperationId = null;
            this._cancelRequested = false;
        }
    }

    async _cancelAndWaitAbort(operationId) {
        try {
            await sitecoCancelPayment(this.hostAddress);

            const POLL_MS = 500;
            const TIMEOUT_MS = 15000;
            const startedAt = Date.now();

            while (Date.now() - startedAt < TIMEOUT_MS) {
                const st = await sitecoGetPaymentStatus(this.hostAddress, operationId);
                if (st?.ok && st.machine_state === "SUB_EST_ABRTD") {
                    if (this.cancellationResolver) {
                        this.cancellationResolver(false);
                        this.cancellationResolver = null;
                    }
                    return true;
                }
                await new Promise((r) => setTimeout(r, POLL_MS));
            }
        } catch (e) {
            console.error("[SITECOSL] cancel/wait ERROR:", e);
        }
        return false;
    }


    //En caso de que se cancele el pago

    async sendPaymentCancel(order, uuid) {
        console.log("[SITECOSL] terminal.sendPaymentCancel CALLED", { uuid });

        this._cancelRequested = true;

        const line = this.paymentLine;
        if (line) this._setLineStatus(line, "waitingCancel");

        // dispara cancelación si hay operación activa
        if (this._paymentInProgress && this._currentOperationId) {
            await sitecoCancelPayment(this.hostAddress);
            console.log("[SITECOSL] CancelacionOperacion sent (backend)");
        }
        return true;
    }


    // ---------------------------
    // UI helpers
    // ---------------------------
    showError(msg, title) {
        this.dialog.add(AlertDialog, {
            title: title || _t("Cash Machine Error"),
            body: msg,
        });
    }

    showInfo(msg, title) {
        this.dialog.add(AlertDialog, {
            title: title || _t("Information"),
            body: msg,
        });
    }

   getDenominationsWithStatus(status) {
    // para compatibilidad con tu XML/UI (si quieres usarlo igual que Glory)
    // aquí status lo puedes interpretar como "BILLE" / "MONEDA" / etc
    if (status === "BILLS") {
        return this.state.inventory.filter((d) => d.support_type === "SUB_SPT_BILLE");
    }
    if (status === "COINS") {
        return this.state.inventory.filter((d) => d.support_type === "SUB_SPT_MONED");
    }
    return this.state.inventory;
}


    async refreshInventory() {
    try {
        const res = await sitecoGetInventory(this.hostAddress);
        if (res?.ok) {
            // ordena por value
            this.state.inventory = (res.inventory || []).sort((a, b) => a.value_cents - b.value_cents);
            console.log("[SITECOSL] inventory loaded", this.state.inventory);
        } else {
            console.warn("[SITECOSL] inventory load failed", res?.error);
        }
    } catch (e) {
        console.error("[SITECOSL] inventory ERROR", e);
    }
}


}


