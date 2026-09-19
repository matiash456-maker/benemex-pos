const Database = require('better-sqlite3');
const db = new Database('pos.db');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_barras TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    categoria TEXT NOT NULL DEFAULT 'Hogar',
    costo REAL NOT NULL DEFAULT 0,
    precio REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    stock_minimo INTEGER NOT NULL DEFAULT 5,
    imagen TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS historial_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha DATETIME DEFAULT (DATETIME('now', 'localtime')),
    producto_id INTEGER NOT NULL,
    producto_nombre TEXT NOT NULL,
    categoria TEXT NOT NULL DEFAULT 'Hogar',
    cantidad INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    detalle TEXT DEFAULT '',
    FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha DATETIME DEFAULT (DATETIME('now', 'localtime')),
    subtotal REAL NOT NULL,
    descuento REAL DEFAULT 0,
    pago_efectivo REAL DEFAULT 0,
    pago_tarjeta REAL DEFAULT 0,
    pago_transferencia REAL DEFAULT 0,
    pago_qr REAL DEFAULT 0,
    total REAL NOT NULL,
    cliente_nombre TEXT DEFAULT 'Venta de Mostrador'
  );
  CREATE TABLE IF NOT EXISTS detalle_ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id INTEGER NOT NULL,
    producto_id INTEGER NOT NULL,
    cantidad INTEGER NOT NULL,
    precio_unitario REAL NOT NULL,
    costo_unitario REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (venta_id) REFERENCES ventas(id) ON DELETE CASCADE,
    FOREIGN KEY (producto_id) REFERENCES productos(id)
  );
  CREATE TABLE IF NOT EXISTS egresos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha DATETIME DEFAULT (DATETIME('now', 'localtime')),
    categoria TEXT NOT NULL DEFAULT 'Varios',
    concepto TEXT NOT NULL,
    monto REAL NOT NULL,
    metodo_pago TEXT NOT NULL DEFAULT 'efectivo',
    tipo TEXT CHECK(tipo IN ('gasto', 'otro')) DEFAULT 'gasto'
  );
  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id INTEGER DEFAULT NULL,
    codigo_pedido TEXT DEFAULT '',
    cliente_nombre TEXT NOT NULL,
    cliente_telefono TEXT DEFAULT '',
    cliente_dni TEXT DEFAULT '',
    fecha DATETIME DEFAULT (DATETIME('now', 'localtime')),
    subtotal REAL NOT NULL DEFAULT 0,
    descuento REAL DEFAULT 0,
    base_sena REAL DEFAULT 0,
    sena_efectivo REAL DEFAULT 0,
    sena_tarjeta REAL DEFAULT 0,
    sena_transferencia REAL DEFAULT 0,
    sena_qr REAL DEFAULT 0,
    saldo_pendiente REAL NOT NULL,
    tipo_entrega TEXT DEFAULT 'local',
    provincia TEXT DEFAULT '',
    localidad TEXT DEFAULT '',
    codigo_postal TEXT DEFAULT '',
    tipo_direccion TEXT DEFAULT 'sucursal',
    direccion_domicilio TEXT DEFAULT '',
    transporte TEXT DEFAULT '',
    tracking TEXT DEFAULT '',
    estado TEXT DEFAULT 'falta_saldar',
    observacion TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS detalle_pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id INTEGER NOT NULL,
    producto_id INTEGER NOT NULL,
    cantidad INTEGER NOT NULL,
    precio_unitario REAL NOT NULL,
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
    FOREIGN KEY (producto_id) REFERENCES productos(id)
  );
  CREATE TABLE IF NOT EXISTS historial_devoluciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha DATETIME DEFAULT (DATETIME('now', 'localtime')),
    venta_id INTEGER DEFAULT NULL,
    pedido_id INTEGER DEFAULT NULL,
    producto_id INTEGER DEFAULT NULL,
    producto_nombre TEXT NOT NULL,
    producto_imagen TEXT,
    cantidad INTEGER NOT NULL,
    precio_unitario REAL NOT NULL DEFAULT 0,
    monto_devuelto REAL NOT NULL,
    origen TEXT NOT NULL,
    detalle_pago TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS caja (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_apertura DATETIME DEFAULT (DATETIME('now', 'localtime')),
    personal TEXT NOT NULL,
    monto_inicial REAL NOT NULL,
    fecha_cierre DATETIME,
    monto_final REAL,
    diferencia REAL,
    estado TEXT DEFAULT 'abierta'
  );
`);

// Migraciones automáticas de columnas para bases de datos ya existentes
const migraciones = [
  "ALTER TABLE pedidos ADD COLUMN codigo_pedido TEXT DEFAULT ''",
  "ALTER TABLE pedidos ADD COLUMN cliente_dni TEXT DEFAULT ''",
  "ALTER TABLE pedidos ADD COLUMN localidad TEXT DEFAULT ''",
  "ALTER TABLE pedidos ADD COLUMN codigo_postal TEXT DEFAULT ''",
  "ALTER TABLE pedidos ADD COLUMN tipo_direccion TEXT DEFAULT 'sucursal'",
  "ALTER TABLE pedidos ADD COLUMN direccion_domicilio TEXT DEFAULT ''"
];
for (let sql of migraciones) {
  try { db.exec(sql); } catch (e) {}
}

module.exports = db;