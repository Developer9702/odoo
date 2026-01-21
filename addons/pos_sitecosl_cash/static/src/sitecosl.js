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
import {appInfo,
        sitecoStartPayment,
        sitecoGetPaymentStatus,
        sitecoCancelPayment,
} from "@pos_sitecosl_cash/utils/sitecosl_soap";

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
            // ✅ durante cobro, no molestamos con health-check
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
        console.log("[SITECOSL] send_payment_request()");
       
        // 1) aseguramos conexión (si estaba desconectado)
        if (this.state.status !== "CONNECTED") {
            const { ok } = await this.checkConnection({ silent: false });
            this.state.status = ok ? "CONNECTED" : "DISCONNECTED";
            if (!ok) return false;
        }
        const order = this.pos.getOrder();
        const line = this.paymentLine || null;

        if (!line) {
            this.showError(_t("No active payment line found for Siteco."));
            return false;
        }

        this._setLineStatus(line, "waiting");
       
        if (!order || !line) {
            this.showError(_t("No active payment line found for Siteco."));
            return false;
        }

        // Importe de la línea en céntimos
        const cents = Math.round(line.amount * Math.pow(10, this.pos.currency.decimal_places));
        if (!cents || cents <= 0) {
            this.showError(_t("Invalid amount for Siteco payment."));
            return false;
        }

        this._paymentInProgress = true;
        this._cancelRequested = false;
        this._currentOperationId = null;

        try {
            // 2) Start cobro (backend ya hace el bucle de op_id hasta 40s)
            const startRes = await sitecoStartPayment(this.hostAddress, cents);
            if (!startRes?.ok) {
                this.showError(_t("Failed to start Siteco payment.") + "\n\n" + (startRes?.error || ""));
                return false;
            }

            const operationId = startRes.operation_id;
            if (!operationId) {
                this.showError(_t("Siteco did not return an operation id."));
                return false;
            }
            this._currentOperationId = operationId;

            // 3) Poll status (como C#)
            const TIMEOUT_MS = 60000; // similar a tu param.TIME_OPCURSO (1 min por defecto)
            const POLL_MS = 500;
            const startedAt = Date.now();

            let st = null;

        while (Date.now() - startedAt < TIMEOUT_MS) {
            // Si el usuario pidió cancelar, cancelamos YA y salimos
            if (this._cancelRequested) {
                await this._cancelAndWaitAbort(operationId);
                this._setLineStatus(line, "retry");
                this.showError(_t("Payment cancelled."), _t("Cash Machine Error"));
                return false;
            }

            st = await sitecoGetPaymentStatus(this.hostAddress, operationId);
            if (!st?.ok) {
                this._setLineStatus(line, "retry");
                this.showError(_t("Failed to read Siteco payment status.") + "\n\n" + (st?.error || ""));
                return false;
            }

            console.log("[SITECOSL] status op=", operationId, "state=", st.machine_state, "saldo=", st.saldo_cents, "deuda=", st.deuda_cents);

            if (st.machine_state === "SUB_EST_NCRSO") {
                await new Promise((r) => setTimeout(r, POLL_MS));
                continue;
            }

            // ✅ ya no está en curso: salimos del loop y procesamos resultado
            break;
        }

        // Timeout (no rompió por estado final)
        if (!st || st.machine_state === "SUB_EST_NCRSO") {
            await this._cancelAndWaitAbort(operationId);
            this._setLineStatus(line, "retry");
            this.showError(_t("Payment timeout. Operation cancelled."), _t("Cash Machine Error"));
            return false;
        }

        // Si el usuario pidió cancelar justo al final, la cancel manda
        if (this._cancelRequested) {
            await this._cancelAndWaitAbort(operationId);
            this._setLineStatus(line, "retry");
            this.showError(_t("Payment cancelled."), _t("Cash Machine Error"));
            return false;
        }

        // Resultado final
        const deuda = st.deuda_cents ?? 0;

        if (deuda === 0) {
            this._setLineStatus(line, "done");
            this.showInfo(_t("Payment completed successfully."), _t("Cash Machine"));
            return true;
        }

        // deuda > 0
        this._setLineStatus(line, "retry");
        const deudaAmount = deuda / Math.pow(10, this.pos.currency.decimal_places);
        this.showError(_t("Payment not completed. Remaining debt: %s", deudaAmount), _t("Cash Machine Error"));
        return false;
        } catch (e) {
            console.error("[SITECOSL] send_payment_request ERROR:", e);
            this.showError(_t("Unexpected error during payment."), _t("Cash Machine Error"));
            return false;
        } finally {
            this._paymentInProgress = false;
            this._currentOperationId = null;
            this._cancelRequested = false;
        }
    }

    //En caso de que se cancele el pago
    async sendPaymentCancel() {
        return await this._requestCancelFromUI();
    }

    async send_payment_cancel() {
        return await this._requestCancelFromUI();
    }
    
    async _cancelAndWaitAbort(operationId) {
        try {
            await sitecoCancelPayment(this.hostAddress);

            // Esperar a SUB_EST_ABRTD (como C#)
            const POLL_MS = 500;
            const TIMEOUT_MS = 15000;
            const startedAt = Date.now();

            while (Date.now() - startedAt < TIMEOUT_MS) {
                const st = await sitecoGetPaymentStatus(this.hostAddress, operationId);
                if (st?.ok && st.machine_state === "SUB_EST_ABRTD") {
                    return true;
                }
                await new Promise((r) => setTimeout(r, POLL_MS));
            }
        } catch (e) {
            console.error("[SITECOSL] cancel/wait ERROR:", e);
        }
        return false;
    }

    async _requestCancelFromUI() {
        console.log("[SITECOSL] CANCEL requested by UI");

        this._cancelRequested = true;

        // si hay línea activa, cambia estado visual a "cancelando"
        const line = this.paymentLine;
        if (line) {
            this._setLineStatus(line, "waitingCancel");
        }

        // ✅ cancelar YA si ya hay operación activa
        if (this._paymentInProgress && this._currentOperationId) {
            try {
                const res = await sitecoCancelPayment(this.hostAddress);
                console.log("[SITECOSL] CancelacionOperacion sent:", res);
            } catch (e) {
                console.error("[SITECOSL] CancelacionOperacion ERROR:", e);
            }
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
}

