{
    'name': 'POS Siteco SL Cash Machine',
    'version': '1.0',
    'category': 'Sales/Point of Sale',
    'summary': 'Integrate your POS with a Siteco SL automatic cash payment device',
    'depends': ['point_of_sale'],
    'installable': True,
    'data': [
        'views/pos_payment_method_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_sitecosl_cash/static/src/sitecosl.js',
              "pos_sitecosl_cash/static/src/utils/sitecosl_soap.js",
        ],
        'web.assets_unit_tests': [
            'pos_sitecosl_cash/static/tests/**/*',
        ],
    },
    'author': 'Odoo S.A.',
    'license': 'LGPL-3',
}
