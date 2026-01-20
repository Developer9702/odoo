# -*- coding: utf-8 -*-
import logging
import requests
import xml.etree.ElementTree as ET
import re

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class PosSitecoslCashController(http.Controller):

    @http.route("/pos_sitecosl_cash/appinfo", type="jsonrpc", auth="user")
    def sitecosl_appinfo(self, host_address):
        """
        Llama al SOAP AppInfo desde el backend (sin CORS) y devuelve True/False.
        host_address ejemplo: 127.0.0.1:8080
        """
        url = f"http://{host_address}/ServicioCobro/ServicioCobro"
        soap = """<?xml version="1.0" encoding="utf-8"?>
            <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                            xmlns:tns="http://Servidor.net.sitecosl.desarrollo/">
            <soapenv:Header/>
            <soapenv:Body>
                <tns:AppInfo/>
            </soapenv:Body>
            </soapenv:Envelope>"""

        try:
            resp = requests.post(
                url,
                data=soap.encode("utf-8"),
                headers={"Content-Type": "text/xml; charset=utf-8"},
                timeout=5,
            )
            text = resp.text or ""
            ok = resp.status_code == 200 and "AppInfoResponse" in text
            _logger.info("[SITECOSL] AppInfo %s -> %s (HTTP %s)", url, ok, resp.status_code)
            return {"ok": ok, "http_status": resp.status_code}
        except Exception as e:
            _logger.exception("[SITECOSL] AppInfo failed calling %s: %s", url, e)
            return {"ok": False, "error": str(e)}
        

    def _soap_call(self, host_address: str, inner_xml: str, timeout: int = 10) -> str:
        url = f"http://{host_address}/ServicioCobro/ServicioCobro"
        soap = self._soap_envelope(inner_xml)
        resp = requests.post(
            url,
            data=soap.encode("utf-8"),
            headers={"Content-Type": "text/xml; charset=utf-8"},
            timeout=timeout,
        )
        text = resp.text or ""
        if resp.status_code != 200:
            raise Exception(f"SOAP HTTP {resp.status_code}: {text[:200]}")
        return text

    def _extract_first_int(self, xml_text: str):
        # Extrae el primer entero que aparezca entre tags >123<
        m = re.search(r">(-?\d+)<", xml_text)
        return int(m.group(1)) if m else None

    def _extract_estado(self, xml_text: str):
        # Busca literal SUB_EST_...
        m = re.search(r"(SUB_EST_[A-Z0-9_]+)", xml_text)
        return m.group(1) if m else None

    @http.route("/pos_sitecosl_cash/pay/start", type="jsonrpc", auth="user")
    def sitecosl_pay_start(self, host_address, amount_cents):
        """
        Inicia cobro: CobrarHasta(cents) y devuelve operation_id.
        Replica la lógica C#: espera hasta 40s a que ConsultaCodigoUltimaOperacionVenta != 0
        """
        try:
            amount_cents = int(amount_cents)

            # 1) Start
            self._soap_call(
                host_address,
                f"<tns:CobrarHasta><arg0>{amount_cents}</arg0></tns:CobrarHasta>",
                timeout=10,
            )

            # 2) Poll operation id up to 40s (como en C#)
            import time

            deadline = time.time() + 40.0
            op_id = 0

            while time.time() < deadline and op_id == 0:
                xml_code = self._soap_call(
                    host_address,
                    "<tns:ConsultaCodigoUltimaOperacionVenta/>",
                    timeout=10,
                )
                op_id = self._extract_first_int(xml_code) or 0
                if op_id == 0:
                    time.sleep(0.5)  # 500ms, ajustable

            _logger.info(
                "[SITECOSL] CobrarHasta amount=%s op_id=%s host=%s",
                amount_cents,
                op_id,
                host_address,
            )

            if op_id == 0:
                return {"ok": False, "error": "Operation id not returned within 40s", "operation_id": 0}

            return {"ok": True, "operation_id": op_id}

        except Exception as e:
            _logger.exception("[SITECOSL] pay/start failed: %s", e)
            return {"ok": False, "error": str(e)}


    @http.route("/pos_sitecosl_cash/pay/status", type="jsonrpc", auth="user")
    def sitecosl_pay_status(self, host_address, operation_id):
        """
        Consulta estado + saldo + (si terminó) deuda.
        """
        try:
            operation_id = int(operation_id)

            xml_estado = self._soap_call(
                host_address,
                f"<tns:EstadoOperacionID><arg0>{operation_id}</arg0></tns:EstadoOperacionID>",
                timeout=10,
            )
            machine_state = self._extract_estado(xml_estado) or "UNKNOWN"

            xml_saldo = self._soap_call(
                host_address,
                f"<tns:ConsultaSaldoIdOperacion><arg0>{operation_id}</arg0></tns:ConsultaSaldoIdOperacion>",
                timeout=10,
            )
            saldo = self._extract_first_int(xml_saldo) or 0

            deuda = None
            if machine_state != "SUB_EST_NCRSO":
                xml_deuda = self._soap_call(
                    host_address,
                    f"<tns:DeudaFinalIdOperacion><arg0>{operation_id}</arg0></tns:DeudaFinalIdOperacion>",
                    timeout=10,
                )
                deuda = self._extract_first_int(xml_deuda) or 0

            return {
                "ok": True,
                "machine_state": machine_state,
                "saldo_cents": int(saldo),
                "deuda_cents": (int(deuda) if deuda is not None else None),
            }
        except Exception as e:
            _logger.exception("[SITECOSL] pay/status failed: %s", e)
            return {"ok": False, "error": str(e)}

    @http.route("/pos_sitecosl_cash/pay/cancel", type="jsonrpc", auth="user")
    def sitecosl_pay_cancel(self, host_address):
        """
        Cancela operación en curso.
        """
        try:
            self._soap_call(host_address, "<tns:CancelacionOperacion/>", timeout=10)
            _logger.info("[SITECOSL] CancelacionOperacion host=%s", host_address)
            return {"ok": True}
        except Exception as e:
            _logger.exception("[SITECOSL] pay/cancel failed: %s", e)
            return {"ok": False, "error": str(e)}
