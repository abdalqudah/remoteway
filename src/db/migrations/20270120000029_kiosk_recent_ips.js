// The addresses a QR screen was seen from recently (IPv4 and IPv6 can both appear on the same Wi-Fi).
exports.up = (knex) => knex.schema.alterTable('attendance_kiosks', (t) => { t.text('recent_ips').nullable(); });
exports.down = (knex) => knex.schema.alterTable('attendance_kiosks', (t) => { t.dropColumn('recent_ips'); });
