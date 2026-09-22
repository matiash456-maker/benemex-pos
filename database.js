const { createClient } = require('@libsql/client');
require('dotenv').config();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:pos.db",
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function initDB() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS caja (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monto_inicial REAL,
      personal TEXT,
      estado TEXT,
      fecha_apertura DATETIME DEFAULT CURRENT_TIMESTAMP,
      fecha_cierre DATETIME,
      monto_final REAL,
      diferencia REAL
    )`,
    `CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_barras TEXT UNIQUE,
      nombre TEXT,
      categoria TEXT,
      costo REAL,
      precio REAL,
      stock INTEGER,
      stock_minimo INTEGER DEFAULT 5,
      imagen TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS historial_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER,
      producto_nombre TEXT,
      categoria TEXT,
      cantidad INTEGER,
      tipo TEXT,
      detalle TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subtotal REAL,
      descuento REAL,
      pago_efectivo REAL,
      pago_tarjeta REAL,
      pago_transferencia REAL,
      pago_qr REAL,
      total REAL,
      cliente_nombre TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS detalle_ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER,
      producto_id INTEGER,
      cantidad INTEGER,
      precio_unitario REAL,
      costo_unitario REAL
    )`,
    `CREATE TABLE IF NOT EXISTS egresos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoria TEXT,
      concepto TEXT,
      monto REAL,
      metodo_pago TEXT,
      tipo TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_pedido TEXT,
      cliente_nombre TEXT,
      cliente_telefono TEXT,
      cliente_dni TEXT,
      subtotal REAL,
      descuento REAL,
      base_sena REAL,
      sena_efectivo REAL,
      sena_tarjeta REAL,
      sena_transferencia REAL,
      sena_qr REAL,
      saldo_pendiente REAL,
      tipo_entrega TEXT,
      provincia TEXT,
      localidad TEXT,
      codigo_postal TEXT,
      tipo_direccion TEXT,
      direccion_domicilio TEXT,
      transporte TEXT,
      tracking TEXT,
      estado TEXT,
      observacion TEXT,
      venta_id INTEGER,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS detalle_pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER,
      producto_id INTEGER,
      cantidad INTEGER,
      precio_unitario REAL
    )`,
    `CREATE TABLE IF NOT EXISTS historial_devoluciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER,
      pedido_id INTEGER,
      producto_id INTEGER,
      producto_nombre TEXT,
      producto_imagen TEXT,
      cantidad INTEGER,
      precio_unitario REAL,
      monto_devuelto REAL,
      origen TEXT,
      detalle_pago TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ], "write");
  console.log("Base de datos en Turso inicializada con éxito.");
}

initDB().catch(err => console.error("Error al conectar con Turso:", err));

module.exports = db;
