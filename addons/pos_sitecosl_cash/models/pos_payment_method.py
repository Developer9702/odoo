from odoo import fields, models


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    sitecosl_websocket_address = fields.Char('Cash Machine IP:PORT')
    sitecosl_username = fields.Char('Cash Machine Username')
    sitecosl_password = fields.Char('Cash Machine Password')

# Método que devuelve una lista de posibles métodos de pago POS y se añade Cash Siteco
    def _get_payment_method_type(self):
        return super()._get_payment_method_type() + [('sitecosl_cash', 'Cash Machine (Siteco S.L)')]
    
#Este método define qué campos del modelo pos.payment.method se mandan desde el backend al frontend del POS (la UI del TPV en el navegador).
    def _load_pos_data_fields(self, config_id):
        return super()._load_pos_data_fields(config_id) + ['sitecosl_websocket_address', 'sitecosl_username', 'sitecosl_password']
