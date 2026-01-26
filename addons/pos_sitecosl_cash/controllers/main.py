# -*- coding: utf-8 -*-
import logging
import requests
import re
import time
import xml.etree.ElementTree as ET

from odoo import http

_logger = logging.getLogger(__name__)


class PosSitecoslCashController(http.Controller):
    
    @staticmethod
    def _is_non_recyclable_hopper(hopper: str) -> bool:
        """
        Hoppers que NO se usan para dar cambio (no reciclables).
        Ajusta la lista si en tu instalación hay más códigos.
        """
        return (hopper or "").upper() in {"HOPPER_CM", "HOPPER_CB"}

    @staticmethod
    def _group_inventory_by_hopper_value(inventory_rows):
        """
        Agrupa por (hopper, value_cents).
        Si vienen duplicados B-00/B-01 con el mismo total, evita duplicar:
        - total_cents: máximo (o el que no sea 0)
        - pieces: recalculado desde total/value
        """
        grouped = {}
        for r in inventory_rows:
            hopper = r.get("hopper")
            value_cents = int(r.get("value_cents") or 0)
            total_cents = int(r.get("total_cents") or 0)
            key = (hopper, value_cents)

            if key not in grouped:
                grouped[key] = {
                    "hopper": hopper,
                    "value_cents": value_cents,
                    "total_cents": total_cents,
                }
            else:
                # evita duplicar B-00/B-01: nos quedamos con el mayor
                grouped[key]["total_cents"] = max(grouped[key]["total_cents"], total_cents)

        # recalcular pieces a partir del total final
        for v in grouped.values():
            vc = v["value_cents"]
            v["pieces"] = int(v["total_cents"] / vc) if vc else 0

        return sorted(grouped.values(), key=lambda x: (x["hopper"] or "", x["value_cents"]))


    @staticmethod
    def _parse_rows(xml_text: str):
        ns_strip = lambda t: t.split("}", 1)[-1] if "}" in t else t
        root = ET.fromstring(xml_text)
        rows = []
        for ret in root.iter():
            if ns_strip(ret.tag) != "return":
                continue
            row = {}
            for col in list(ret):
                if ns_strip(col.tag) != "columnas":
                    continue
                k = v = None
                for child in list(col):
                    tag = ns_strip(child.tag)
                    if tag == "clave":
                        k = (child.text or "").strip()
                    elif tag == "valor":
                        v = (child.text or "").strip()
                if k:
                    row[k] = v
            rows.append(row)
        return rows
    

    @http.route("/pos_sitecosl_cash/appinfo", type="jsonrpc", auth="user")
    def sitecosl_appinfo(self, host_address):
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

    # -------------------------
    # ✅ HELPERS (DENTRO DE LA CLASE)
    # -------------------------
    def _soap_envelope(self, inner_xml: str) -> str:
        return f"""<?xml version="1.0" encoding="utf-8"?>
        <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:tns="http://Servidor.net.sitecosl.desarrollo/">
        <soapenv:Header/>
        <soapenv:Body>
            {inner_xml}
        </soapenv:Body>
        </soapenv:Envelope>"""

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
        m = re.search(r">(-?\d+)<", xml_text)
        return int(m.group(1)) if m else None

    def _extract_estado(self, xml_text: str):
        m = re.search(r"(SUB_EST_[A-Z0-9_]+)", xml_text)
        return m.group(1) if m else None
    # -------------------------
    # ✅ PAY START
    # -------------------------
    @http.route("/pos_sitecosl_cash/pay/start", type="jsonrpc", auth="user")
    def sitecosl_pay_start(self, host_address, amount_cents):
        try:
            amount_cents = int(amount_cents)

            # CobrarHasta
            self._soap_call(
                host_address,
                f"<tns:CobrarHasta><arg0>{amount_cents}</arg0></tns:CobrarHasta>",
                timeout=10,
            )

            # Poll operation id hasta 40s
            deadline = time.time() + 40.0
            op_id = 0
            while time.time() < deadline and op_id == 0:
                xml_code = self._soap_call(host_address, "<tns:ConsultaCodigoUltimaOperacionVenta/>", timeout=10)
                op_id = self._extract_first_int(xml_code) or 0
                if op_id == 0:
                    time.sleep(0.5)

            _logger.info("[SITECOSL] CobrarHasta amount=%s op_id=%s host=%s", amount_cents, op_id, host_address)

            if op_id == 0:
                return {"ok": False, "error": "Operation id not returned within 40s", "operation_id": 0}

            return {"ok": True, "operation_id": op_id}
        except Exception as e:
            _logger.exception("[SITECOSL] pay/start failed: %s", e)
            return {"ok": False, "error": str(e)}

    @http.route("/pos_sitecosl_cash/pay/status", type="jsonrpc", auth="user")
    def sitecosl_pay_status(self, host_address, operation_id):
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

            return {"ok": True, "machine_state": machine_state, "saldo_cents": int(saldo), "deuda_cents": (int(deuda) if deuda is not None else None)}
        except Exception as e:
            _logger.exception("[SITECOSL] pay/status failed: %s", e)
            return {"ok": False, "error": str(e)}

    @http.route("/pos_sitecosl_cash/pay/cancel", type="jsonrpc", auth="user")
    def sitecosl_pay_cancel(self, host_address):
        try:
            self._soap_call(host_address, "<tns:CancelacionOperacion/>", timeout=10)
            return {"ok": True}
        except Exception as e:
            _logger.exception("[SITECOSL] pay/cancel failed: %s", e)
            return {"ok": False, "error": str(e)}

   # -------------------------
   # ✅ INVENTORY
   # -------------------------
    @http.route("/pos_sitecosl_cash/cash/pagadores_fraccion", type="jsonrpc", auth="user")
    def sitecosl_pagadores_fraccion(self, host_address):
        """
        Mantenimiento_ConsultaPagadoresFraccion:
        devuelve qué pagadores/hoppers y fracciones existen (cod_fraccion).
        """
        try:
            xml = self._soap_call(host_address, "<tns:Mantenimiento_ConsultaPagadoresFraccion/>", timeout=15)
            rows = self._parse_rows(xml)
            return {"ok": True, "rows": rows}
        except Exception as e:
            _logger.exception("[SITECOSL] pagadores_fraccion failed: %s", e)
            return {"ok": False, "error": str(e)}

    @http.route("/pos_sitecosl_cash/cash/pagadores_denominacion", type="jsonrpc", auth="user")
    def sitecosl_pagadores_denominacion(self, host_address):
        """
        Mantenimiento_ConsultaPagadoresDenominacion:
        devuelve el valor (centimos) y la cantidad/suma por hopper.
        """
        try:
            xml = self._soap_call(host_address, "<tns:Mantenimiento_ConsultaPagadoresDenominacion/>", timeout=15)
            rows = self._parse_rows(xml)
            return {"ok": True, "rows": rows}
        except Exception as e:
            _logger.exception("[SITECOSL] pagadores_denominacion failed: %s", e)
            return {"ok": False, "error": str(e)}

    @http.route("/pos_sitecosl_cash/cash/tabla_fracciones", type="jsonrpc", auth="user")
    def sitecosl_tabla_fracciones(self, host_address):
        """
        Mantenimiento_TablaFracciones:
        devuelve descripción y mapeo cod_fraccion -> desc/soporte.
        """
        try:
            xml = self._soap_call(host_address, "<tns:Mantenimiento_TablaFracciones/>", timeout=15)
            rows = self._parse_rows(xml)
            return {"ok": True, "rows": rows}
        except Exception as e:
            _logger.exception("[SITECOSL] tabla_fracciones failed: %s", e)
            return {"ok": False, "error": str(e)}

    @http.route("/pos_sitecosl_cash/cash/inventory", type="jsonrpc", auth="user")
    def sitecosl_cash_inventory(self, host_address):
        """
        Devuelve inventario normalizado para el POS:
        [
          {
            "hopper": "HOPPER_1000",
            "cod_fraccion": "EUR010+02-B-00",
            "value_cents": 1000,
            "total_cents": 13000,
            "pieces": 13,
            "support_type": "SUB_SPT_BILLE",
            "label_long": "DIEZ EUROS VIEJO",
            "label_short": "10 EUR VIEJO"
          },
          ...
        ]
        """
        try:
            # 1) ConsultaPagadoresFraccion -> (hopper, cod_fraccion, suma_valor?)
            xml_pf = self._soap_call(host_address, "<tns:Mantenimiento_ConsultaPagadoresFraccion/>", timeout=15)
            rows_pf = self._parse_rows(xml_pf)

            # 2) ConsultaPagadoresDenominacion -> (hopper, valor_fraccion, suma_valor)
            xml_pd = self._soap_call(host_address, "<tns:Mantenimiento_ConsultaPagadoresDenominacion/>", timeout=15)
            rows_pd = self._parse_rows(xml_pd)

            # 3) TablaFracciones -> (cod_fraccion, desc l/c, tipo soporte)
            xml_tf = self._soap_call(host_address, "<tns:Mantenimiento_TablaFracciones/>", timeout=15)
            rows_tf = self._parse_rows(xml_tf)

            # Map cod_fraccion -> metadata
            frac_meta = {}
            for r in rows_tf:
                cod = r.get("ALIAS_CAMPO_COD_FRACCION")
                if not cod:
                    continue
                frac_meta[cod] = {
                    "support_type": r.get("ALIAS_CAMPO_TIPO_SOPORTE"),
                    "label_long": r.get("ALIAS_CAMPO_DESCRIPCIONL"),
                    "label_short": r.get("ALIAS_CAMPO_DESCRIPCIONC"),
                }

            # Map hopper+value -> total_cents (de denominacion)
            # (valor_fraccion ya viene en "céntimos": 2000, 1000, 50, 20, etc.)
            denom_by_hopper_value = {}
            for r in rows_pd:
                hopper = r.get("ALIAS_CAMPO_COD_HOPPER")
                value_cents = r.get("ALIAS_CAMPO_VALOR_FRACCION")
                total_cents = r.get("ALIAS_CAMPO_SUMA_VALOR")
                if not hopper or value_cents is None:
                    continue
                try:
                    value_cents_i = int(value_cents)
                    total_cents_i = int(total_cents or 0)
                except Exception:
                    continue
                denom_by_hopper_value[(hopper, value_cents_i)] = total_cents_i

            # Para estimar value_cents de un cod_fraccion:
            # Ej: EUR010+02-B-00 => 10 EUR => 1000 cents
            # Ej: EUR050+00-M-00 => 50 cents => 50
            # Regla: EUR + 3 dígitos -> euros/centimos según soporte.
            # Pero ya tienes "valor_fraccion" en ConsultaPagadoresDenominacion,
            # así que hacemos join por hopper usando la relación (hopper,cod_fraccion) y buscamos value más probable:
            # si un hopper tiene varias value (como HOPPER_200_100) nos quedamos con las que "casan" con el código.
            def infer_value_cents_from_cod(cod_fraccion: str):
                # cod_fraccion: "EUR010+02-B-00" or "EUR050+00-M-00"
                m = re.search(r"EUR(\d{3})\+", cod_fraccion or "")
                if not m:
                    return None
                n = int(m.group(1))  # 010, 050, 200, 500...
                # Si es billete (B) normalmente son euros => *100
                if "+02-B" in cod_fraccion:
                    return n * 100
                # Si es moneda (M) puede ser céntimos o euros:
                # EUR002+02-M-00 en tu tabla es 2 EUR => 200
                if "+02-M" in cod_fraccion:
                    return n * 100  # 2 -> 200, 1 -> 100
                # EUR050+00-M-00 es 50 céntimos => 50
                if "+00-M" in cod_fraccion:
                    return n  # 50 -> 50, 20 -> 20, 10 -> 10, 5 -> 5...
                return None

            # Construir inventario final usando PagadoresFraccion
            inventory = []
            for r in rows_pf:
                hopper = r.get("ALIAS_CAMPO_COD_HOPPER")
                cod = r.get("ALIAS_CAMPO_COD_FRACCION")
                if not hopper or not cod:
                    continue

                #OMITIR NO-RECICLABLES (CM / CB)
                if self._is_non_recyclable_hopper(hopper):
                    continue

                value_cents = infer_value_cents_from_cod(cod) or 0

                total_cents = denom_by_hopper_value.get((hopper, value_cents))
                if total_cents is None:
                    # fallback: el propio SUMA_VALOR de PagadoresFraccion a veces trae el total
                    try:
                        total_cents = int(r.get("ALIAS_CAMPO_SUMA_VALOR") or 0)
                    except Exception:
                        total_cents = 0

                pieces = int(total_cents / value_cents) if value_cents else 0

                meta = frac_meta.get(cod, {})
                inventory.append({
                    "hopper": hopper,
                    "cod_fraccion": cod,
                    "value_cents": int(value_cents),
                    "total_cents": int(total_cents),
                    "pieces": int(pieces),
                    "support_type": meta.get("support_type"),
                    "label_long": meta.get("label_long"),
                    "label_short": meta.get("label_short"),
                })

           # return {"ok": True, "inventory": inventory}
            grouped_inventory = self._group_inventory_by_hopper_value(inventory)
            return {"ok": True, "inventory": grouped_inventory}

        except Exception as e:
            _logger.exception("[SITECOSL] cash/inventory failed: %s", e)
            return {"ok": False, "error": str(e)}
