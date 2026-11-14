const { createClient } = @libsql/client;

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function inicializarBaseDatos() {
  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo_barras TEXT,
        nombre TEXT NOT NULL,
        categoria TEXT,
        costo REAL DEFAULT 0,
        precio REAL NOT NULL,
        stock INTEGER NOT NULL,
        imagen TEXT
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS caja_turnos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        personal_cargo TEXT,
        monto_inicial REAL NOT NULL,
        monto_final REAL,
        diferencia REAL,
        estado TEXT DEFAULT 'abierta',
        fecha_apertura DATETIME DEFAULT CURRENT_TIMESTAMP,
        fecha_cierre DATETIME
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS egresos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caja_turno_id INTEGER,
        categoria TEXT NOT NULL,
        concepto TEXT,
        monto REAL NOT NULL,
        metodo_pago TEXT DEFAULT 'efectivo',
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS comisionados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        porcentaje REAL NOT NULL,
        datos TEXT
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS ventas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caja_turno_id INTEGER,
        cliente_nombre TEXT,
        comisionado_id INTEGER,
        subtotal REAL NOT NULL,
        descuento REAL DEFAULT 0,
        pago_efectivo REAL DEFAULT 0,
        pago_tarjeta REAL DEFAULT 0,
        pago_transferencia REAL DEFAULT 0,
        pago_qr REAL DEFAULT 0,
        total REAL NOT NULL,
        codigo_pedido TEXT,
        devuelta INTEGER DEFAULT 0,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS detalle_ventas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venta_id INTEGER,
        producto_id INTEGER,
        cantidad INTEGER NOT NULL,
        precio_unitario REAL NOT NULL,
        costo_unitario REAL DEFAULT 0,
        porcentaje_comision REAL DEFAULT 0,
        monto_comision REAL DEFAULT 0
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caja_turno_id INTEGER,
        codigo_pedido TEXT,
        cliente_nombre TEXT,
        cliente_telefono TEXT,
        cliente_dni TEXT,
        comisionado_id INTEGER,
        subtotal REAL NOT NULL,
        descuento REAL DEFAULT 0,
        sena_efectivo REAL DEFAULT 0,
        sena_tarjeta REAL DEFAULT 0,
        sena_transferencia REAL DEFAULT 0,
        sena_qr REAL DEFAULT 0,
        saldo_pendiente REAL NOT NULL,
        tipo_entrega TEXT,
        provincia TEXT,
        localidad TEXT,
        codigo_postal TEXT,
        tipo_direccion TEXT,
        direccion_domicilio TEXT,
        transporte TEXT,
        estado TEXT DEFAULT 'falta_saldar',
        observacion TEXT,
        tracking TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS detalle_pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pedido_id INTEGER,
        producto_id INTEGER,
        cantidad INTEGER NOT NULL,
        precio_unitario REAL NOT NULL
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS pagos_pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pedido_id INTEGER,
        caja_turno_id INTEGER,
        monto_efectivo REAL DEFAULT 0,
        monto_tarjeta REAL DEFAULT 0,
        monto_transferencia REAL DEFAULT 0,
        monto_qr REAL DEFAULT 0,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS comisiones_pagos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comisionado_id INTEGER,
        monto REAL NOT NULL,
        metodo_pago TEXT,
        tipo TEXT DEFAULT 'pago',
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS historial_devoluciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origen TEXT,
        origen_id INTEGER,
        detalles TEXT,
        total_monto REAL,
        detalle_pago TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS historial_stock (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER,
        variacion INTEGER,
        tipo TEXT,
        detalle TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("Base de datos conectada y verificada correctamente.");
  } catch (error) {
    console.error("Error al inicializar la base de datos:", error);
  }
}

inicializarBaseDatos();

module.exports = {
  query: async (sql, params = []) => {
    const result = await client.execute({ sql, args: params });
    return result.rows.map(row => {
      let obj = {};
      result.columns.forEach((col, index) => {
        obj[col] = row[index];
      });
      return obj;
    });
  }
};
