from odoo import fields, models


class PosPaymentMethod(models.Model):
    _inherit = "pos.payment.method"

    sitecosl_host_address = fields.Char(
        string="Cash Machine IP:PORT",
        default="127.0.0.1:8080",
        help="Example: 127.0.0.1:8080 (TPV local). In tests you can use 192.168.x.x:8080",
    )

    # Añade un nuevo tipo de método de pago
    def _get_payment_method_type(self):
        return super()._get_payment_method_type() + [
            ("sitecosl_cash", "Cash Machine (Siteco S.L)"),
        ]

    # Campos que se envían al frontend del POS
    def _load_pos_data_fields(self, config_id):
        return super()._load_pos_data_fields(config_id) + [
            "sitecosl_host_address",
        ]
