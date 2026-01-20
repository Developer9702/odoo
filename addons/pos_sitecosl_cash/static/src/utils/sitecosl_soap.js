//Transport Layer (Enviar/Recibir)
/** @odoo-module **/
import { rpc } from "@web/core/network/rpc";

const SITECOSL_NS = "http://Servidor.net.sitecosl.desarrollo/";
function buildSoapEnvelope(innerXml) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:tns="${SITECOSL_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    ${innerXml}
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(t);
    }
}

export async function callSitecoslSoap({ hostAddress, action, bodyInnerXml, timeoutMs = 5000 }) {
    const endpoint = `http://${hostAddress}/ServicioCobro/ServicioCobro`;

    const soapBody = buildSoapEnvelope(bodyInnerXml);

    const headers = {
        "Content-Type": "text/xml; charset=utf-8",
    };

    // Si el servicio exige SOAPAction, lo activas
    if (action) {
        headers["SOAPAction"] = action;
    }

    const res = await fetchWithTimeout(
        endpoint,
        { method: "POST", headers, body: soapBody },
        timeoutMs
    );

    const text = await res.text();

    if (!res.ok) {
        throw new Error(`Sitecosl SOAP HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return text;
}

export async function appInfo(hostAddress) {
    const result = await rpc("/pos_sitecosl_cash/appinfo", {
        host_address: hostAddress,
    });
    console.log("[SITECOSL] AppInfo via Odoo:", result);
    return !!result.ok;
}