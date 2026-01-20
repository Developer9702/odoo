# -*- coding: utf-8 -*-
import logging
import requests

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class PosSitecoslCashController(http.Controller):

    @http.route("/pos_sitecosl_cash/appinfo", type="json", auth="user")
    def sitecosl_appinfo(self, host_address):
        """
        Llama al SOAP AppInfo desde el backend (sin CORS) y devuelve True/False.
        host_address ejemplo: 192.168.1.117:8080
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
