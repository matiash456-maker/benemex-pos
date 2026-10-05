const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// INICIALIZACIÓN AUTOMÁTICA DE TABLAS Y COLUMNAS PARA COMISIONES
async function initComisionesDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS comisionados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        porcentaje REAL NOT NULL,
        datos TEXT
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS pagos_comisiones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comisionado_id INTEGER NOT NULL,
        monto REAL NOT NULL,
        metodo_pago TEXT NOT NULL,
        tipo TEXT NOT NULL,
        fecha DATETIME DEFAULT (DATETIME('now', 'localtime'))
      )
    `);
    try { await db.execute("ALTER TABLE ventas ADD COLUMN comisionado_id INTEGER"); } catch (e) {}
    try { await db.execute("ALTER TABLE pedidos ADD COLUMN comisionado_id INTEGER"); } catch (e) {}
  } catch (err) {
    console.error("Error inicializando tablas de comisiones:", err);
  }
}
initComisionesDatabase();

// RUTAS PARA SERVIR LAS PÁGINAS HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/catalogo', (req, res) => {
  res.sendFile(path.join(__dirname, 'catalogo.html'));
});

// HELPER FORMATO MÉTODO DE REEMBOLSO
function formatMetodoReembolso(met) {
  if (!met) return 'Efectivo';
  const m = String(met).trim().toLowerCase();
  if (m === '3' || m.includes('tarjeta')) return 'Devolucion por tarjeta';
  if (m === '2' || m.includes('transf')) return 'Reembolso por TRANSFERENCIA';
  if (m === '1' || m.includes('efectiv')) return 'Efectivo';
  return met;
}

// HELPER CREAR VENTA DESDE UN PEDIDO
async function registrarVentaDesdePedido(pedidoId) {
  const pRes = await db.execute({ sql: 'SELECT * FROM pedidos WHERE id = ?', args: [pedidoId] });
  const p = pRes.rows[0];
  if (!p) return null;

  if (p.venta_id) {
    const totalPagado = (p.sena_efectivo||0) + (p.sena_tarjeta||0) + (p.sena_transferencia||0) + (p.sena_qr||0);
    await db.execute({
      sql: 'UPDATE ventas SET subtotal = ?, descuento = ?, pago_efectivo = ?, pago_tarjeta = ?, pago_transferencia = ?, pago_qr = ?, total = ?, comisionado_id = ? WHERE id = ?',
      args: [p.subtotal, p.descuento, p.sena_efectivo, p.sena_tarjeta, p.sena_transferencia, p.sena_qr, totalPagado, p.comisionado_id || null, p.venta_id]
    });
    return p.venta_id;
  }

  const totalFinal = (p.sena_efectivo||0) + (p.sena_tarjeta||0) + (p.sena_transferencia||0) + (p.sena_qr||0);
  const vRes = await db.execute({
    sql: 'INSERT INTO ventas (subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre, comisionado_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: [p.subtotal, p.descuento, p.sena_efectivo, p.sena_tarjeta, p.sena_transferencia, p.sena_qr, totalFinal, p.cliente_nombre, p.comisionado_id || null]
  });
  const ventaId = Number(vRes.lastInsertRowid);

  const detRes = await db.execute({ sql: 'SELECT * FROM detalle_pedidos WHERE pedido_id = ?', args: [p.id] });
  for (const d of detRes.rows) {
    const costRes = await db.execute({ sql: 'SELECT costo FROM productos WHERE id = ?', args: [d.producto_id] });
    const costoUnitario = costRes.rows[0]?.costo || 0;
    await db.execute({
      sql: 'INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)',
      args: [ventaId, d.producto_id, d.cantidad, d.precio_unitario, costoUnitario]
    });
  }

  await db.execute({ sql: 'UPDATE pedidos SET venta_id = ? WHERE id = ?', args: [ventaId, p.id] });
  return ventaId;
}

// HELPER DE REVERSIÓN DE DEVOLUCIONES DE PRODUCTOS
async function revertirDevolucion(venta_id, pedido_id, producto_id, cantidad_a_revertir) {
  let campoWhere = venta_id ? 'venta_id = ?' : 'pedido_id = ?';
  let targetId = venta_id || pedido_id;
  let devsRes = await db.execute({
    sql: `SELECT * FROM historial_devoluciones WHERE ${campoWhere} AND producto_id = ? ORDER BY id DESC`,
    args: [targetId, producto_id]
  });
  
  let restante = cantidad_a_revertir;
  for (let d of devsRes.rows) {
    if (restante <= 0) break;
    if (d.cantidad <= restante) {
      restante -= d.cantidad;
      await db.execute({ sql: 'DELETE FROM historial_devoluciones WHERE id = ?', args: [d.id] });
    } else {
      let nuevaCant = d.cantidad - restante;
      let nuevoMonto = nuevaCant * d.precio_unitario;
      await db.execute({
        sql: 'UPDATE historial_devoluciones SET cantidad = ?, monto_devuelto = ? WHERE id = ?',
        args: [nuevaCant, nuevoMonto, d.id]
      });
      restante = 0;
    }
  }
}

// --- CAJA ---
app.get('/api/caja/estado', async (req, res) => {
  const r = await db.execute("SELECT * FROM caja WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
  res.json(r.rows[0] || { estado: 'cerrada' });
});

app.post('/api/caja/abrir', async (req, res) => {
  await db.execute({
    sql: "INSERT INTO caja (monto_inicial, personal, estado) VALUES (?, ?, 'abierta')",
    args: [req.body.monto_inicial, req.body.personal]
  });
  res.json({ mensaje: 'Caja abierta' });
});

app.get('/api/caja/pre-cierre', async (req, res) => {
  const cajaRes = await db.execute("SELECT * FROM caja WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
  const caja = cajaRes.rows[0];
  if(!caja) return res.json({ esperado: 0 });

  const ventasEf = (await db.execute({ sql: "SELECT SUM(pago_efectivo) as t FROM ventas WHERE fecha >= ?", args: [caja.fecha_apertura] })).rows[0]?.t || 0;
  const senasEf = (await db.execute({ sql: "SELECT SUM(sena_efectivo) as s FROM pedidos WHERE fecha >= ? AND estado = 'falta_saldar'", args: [caja.fecha_apertura] })).rows[0]?.s || 0;
  const egresosEf = (await db.execute({ sql: "SELECT SUM(monto) as m FROM egresos WHERE fecha >= ? AND metodo_pago = 'efectivo'", args: [caja.fecha_apertura] })).rows[0]?.m || 0;

  res.json({ esperado: caja.monto_inicial + ventasEf + senasEf - egresosEf });
});

app.post('/api/caja/cerrar', async (req, res) => {
  const { monto_final, esperado } = req.body;
  const diff = esperado < 0 ? (monto_final + esperado) : (monto_final - esperado);
  const cajaRes = await db.execute("SELECT * FROM caja WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
  const caja = cajaRes.rows[0];
  if(!caja) return res.status(400).json({error: 'Sin caja abierta'});

  await db.execute({
    sql: "UPDATE caja SET fecha_cierre = (DATETIME('now', 'localtime')), monto_final = ?, diferencia = ?, estado = 'cerrada' WHERE id = ?",
    args: [monto_final, diff, caja.id]
  });
  res.json({ mensaje: 'Caja cerrada' });
});

app.get('/api/caja/historial', async (req, res) => {
  let query = "SELECT * FROM caja WHERE estado = 'cerrada'";
  let params = [];
  
  if (req.query.fecha) {
    query += " AND (fecha_apertura LIKE ? OR fecha_cierre LIKE ?)";
    params.push(`${req.query.fecha}%`, `${req.query.fecha}%`);
  }
  
  query += " ORDER BY fecha_cierre DESC";
  const r = await db.execute({ sql: query, args: params });
  res.json(r.rows);
});

// --- PRODUCTOS E HISTORIAL DE REINGRESOS ---
app.get('/api/productos', async (req, res) => {
  const r = await db.execute('SELECT * FROM productos');
  res.json(r.rows);
});

app.get('/api/productos/buscar', async (req, res) => {
  const q = `%${req.query.q}%`;
  const cat = req.query.categoria;
  if (cat) {
    const r = await db.execute({ sql: 'SELECT * FROM productos WHERE categoria = ? AND (nombre LIKE ? OR codigo_barras LIKE ?) LIMIT 15', args: [cat, q, q] });
    res.json(r.rows);
  } else {
    const r = await db.execute({ sql: 'SELECT * FROM productos WHERE nombre LIKE ? OR codigo_barras LIKE ? LIMIT 10', args: [q, q] });
    res.json(r.rows);
  }
});

app.post('/api/productos', async (req, res) => {
  const { codigo_barras, nombre, categoria, costo, precio, stock, stock_minimo, imagen } = req.body;
  await db.execute({
    sql: `INSERT INTO productos (codigo_barras, nombre, categoria, costo, precio, stock, stock_minimo, imagen) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
          ON CONFLICT(codigo_barras) DO UPDATE SET 
          nombre = excluded.nombre, categoria = excluded.categoria, costo = excluded.costo, 
          precio = excluded.precio, stock = stock + excluded.stock, stock_minimo = excluded.stock_minimo, imagen = excluded.imagen`,
    args: [codigo_barras, nombre, categoria||'Hogar', costo||0, precio, stock, stock_minimo||5, imagen||'']
  });

  const pRes = await db.execute({ sql: 'SELECT id FROM productos WHERE codigo_barras = ?', args: [codigo_barras] });
  const prodId = Number(pRes.rows[0].id);

  await db.execute({
    sql: 'INSERT INTO historial_stock (producto_id, producto_nombre, categoria, cantidad, tipo, detalle) VALUES (?, ?, ?, ?, ?, ?)',
    args: [prodId, nombre, categoria||'Hogar', stock, 'Alta / Creación', 'Registro inicial de producto']
  });

  res.json({ mensaje: 'Guardado e ingresado al historial' });
});

app.post('/api/productos/reingreso', async (req, res) => {
  const { producto_id, cantidad, detalle } = req.body;
  const pRes = await db.execute({ sql: 'SELECT * FROM productos WHERE id = ?', args: [producto_id] });
  const p = pRes.rows[0];
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  await db.execute({ sql: 'UPDATE productos SET stock = stock + ? WHERE id = ?', args: [cantidad, producto_id] });
  await db.execute({
    sql: 'INSERT INTO historial_stock (producto_id, producto_nombre, categoria, cantidad, tipo, detalle) VALUES (?, ?, ?, ?, ?, ?)',
    args: [producto_id, p.nombre, p.categoria, cantidad, 'Reingreso Stock', detalle || 'Reingreso manual de mercadería']
  });

  res.json({ mensaje: 'Stock sumado correctamente' });
});

app.get('/api/productos/reingresos/historial', async (req, res) => {
  let query = 'SELECT * FROM historial_stock WHERE 1=1';
  let params = [];
  if (req.query.categoria) { query += ' AND categoria = ?'; params.push(req.query.categoria); }
  if (req.query.producto_id) { query += ' AND producto_id = ?'; params.push(req.query.producto_id); }
  if (req.query.fecha_desde) { query += ' AND DATE(fecha) >= ?'; params.push(req.query.fecha_desde); }
  if (req.query.fecha_hasta) { query += ' AND DATE(fecha) <= ?'; params.push(req.query.fecha_hasta); }
  query += ' ORDER BY fecha DESC LIMIT 150';

  const r = await db.execute({ sql: query, args: params });
  res.json(r.rows);
});

app.put('/api/productos/:id', async (req, res) => {
  const { codigo_barras, nombre, categoria, costo, precio, stock, imagen } = req.body;
  const pRes = await db.execute({ sql: 'SELECT stock FROM productos WHERE id = ?', args: [req.params.id] });
  const pActual = pRes.rows[0];
  const diff = stock - (pActual ? pActual.stock : 0);

  await db.execute({
    sql: `UPDATE productos SET codigo_barras = ?, nombre = ?, categoria = ?, costo = ?, precio = ?, stock = ?, imagen = ? WHERE id = ?`,
    args: [codigo_barras, nombre, categoria, costo, precio, stock, imagen, req.params.id]
  });

  if (diff !== 0) {
    await db.execute({
      sql: 'INSERT INTO historial_stock (producto_id, producto_nombre, categoria, cantidad, tipo, detalle) VALUES (?, ?, ?, ?, ?, ?)',
      args: [req.params.id, nombre, categoria, diff, 'Edición Manual', diff > 0 ? `Aumento manual (+${diff})` : `Disminución manual (${diff})`]
    });
  }

  res.json({ mensaje: 'Actualizado' });
});

app.delete('/api/productos/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM productos WHERE id = ?', args: [req.params.id] });
  res.json({ mensaje: 'Borrado' });
});

// --- COMISIONES ---
app.get('/api/comisionados', async (req, res) => {
  const r = await db.execute('SELECT * FROM comisionados ORDER BY nombre ASC');
  res.json(r.rows);
});

app.post('/api/comisionados', async (req, res) => {
  const { nombre, porcentaje, datos } = req.body;
  await db.execute({
    sql: 'INSERT INTO comisionados (nombre, porcentaje, datos) VALUES (?, ?, ?)',
    args: [nombre, porcentaje, datos || '']
  });
  res.json({ mensaje: 'Comisionado registrado' });
});

app.get('/api/comisiones/ventas', async (req, res) => {
  const query = `
    SELECT 
      v.id as venta_id,
      v.fecha,
      v.comisionado_id,
      c.nombre as comisionado_nombre,
      c.porcentaje as porcentaje_aplicado,
      p.codigo_pedido,
      p.estado as estado_pedido,
      prod.nombre as producto_nombre,
      prod.codigo_barras,
      dv.cantidad,
      dv.precio_unitario as precio_venta,
      dv.costo_unitario,
      (dv.cantidad * dv.precio_unitario * (c.porcentaje / 100.0)) as monto_comision
    FROM ventas v
    JOIN comisionados c ON c.id = v.comisionado_id
    JOIN detalle_ventas dv ON dv.venta_id = v.id
    JOIN productos prod ON prod.id = dv.producto_id
    LEFT JOIN pedidos p ON p.venta_id = v.id
    ORDER BY v.fecha DESC
  `;
  const r = await db.execute(query);
  res.json(r.rows);
});

app.get('/api/comisiones/pagos', async (req, res) => {
  const r = await db.execute('SELECT * FROM pagos_comisiones ORDER BY fecha DESC');
  res.json(r.rows);
});

app.post('/api/comisiones/pagos', async (req, res) => {
  const { comisionado_id, monto, metodo_pago, tipo } = req.body;
  await db.execute({
    sql: 'INSERT INTO pagos_comisiones (comisionado_id, monto, metodo_pago, tipo) VALUES (?, ?, ?, ?)',
    args: [comisionado_id, monto, metodo_pago, tipo]
  });
  res.json({ mensaje: 'Pago de comisión asentado' });
});

// --- VENTAS ---
app.get('/api/ventas', async (req, res) => {
  const cat = req.query.categoria;
  const cod = req.query.codigo_pedido;

  let query = `
    SELECT DISTINCT v.*, COALESCE(p.codigo_pedido, '') as codigo_pedido
    FROM ventas v
    LEFT JOIN pedidos p ON p.venta_id = v.id
    LEFT JOIN detalle_ventas dv ON dv.venta_id = v.id
    LEFT JOIN productos prod ON prod.id = dv.producto_id
    WHERE 1=1
  `;
  let params = [];

  if (cat) {
    query += ` AND prod.categoria = ?`;
    params.push(cat);
  }
  if (cod) {
    query += ` AND (p.codigo_pedido LIKE ? OR CAST(v.id AS TEXT) LIKE ?)`;
    params.push(`%${cod}%`, `%${cod}%`);
  }

  query += ` ORDER BY v.fecha DESC LIMIT 100`;
  const r = await db.execute({ sql: query, args: params });
  res.json(r.rows);
});

app.post('/api/ventas', async (req, res) => {
  const { subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre, items, comisionado_id } = req.body;
  const vRes = await db.execute({
    sql: 'INSERT INTO ventas (subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre, comisionado_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: [subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre || 'Venta de Mostrador', comisionado_id || null]
  });
  const ventaId = Number(vRes.lastInsertRowid);

  for (const i of items) {
    await db.execute({ sql: 'UPDATE productos SET stock = stock - ? WHERE id = ?', args: [i.cantidad, i.producto_id] });
    const costRes = await db.execute({ sql: 'SELECT costo FROM productos WHERE id = ?', args: [i.producto_id] });
    const costoUnitario = costRes.rows[0]?.costo || 0;
    await db.execute({
      sql: 'INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)',
      args: [ventaId, i.producto_id, i.cantidad, i.precio, costoUnitario]
    });
  }

  res.json({ mensaje: 'Venta registrada', venta_id: ventaId });
});

app.get('/api/ventas/:id/detalles', async (req, res) => {
  const vRes = await db.execute({ sql: 'SELECT * FROM ventas WHERE id = ?', args: [req.params.id] });
  const itemsRes = await db.execute({ sql: 'SELECT dv.*, p.nombre, p.imagen FROM detalle_ventas dv JOIN productos p ON p.id = dv.producto_id WHERE dv.venta_id = ?', args: [req.params.id] });
  const pedRes = await db.execute({ sql: 'SELECT id FROM pedidos WHERE venta_id = ?', args: [req.params.id] });

  res.json({ venta: vRes.rows[0], items: itemsRes.rows, es_pedido: !!pedRes.rows[0] });
});

app.post('/api/ventas/:id/modificar-cantidad', async (req, res) => {
  const { detalle_id, nueva_cantidad, metodo_reembolso } = req.body;
  const vRes = await db.execute({ sql: 'SELECT * FROM ventas WHERE id = ?', args: [req.params.id] });
  const v = vRes.rows[0];

  const detRes = await db.execute({ sql: 'SELECT dv.*, p.nombre, p.imagen FROM detalle_ventas dv JOIN productos p ON p.id = dv.producto_id WHERE dv.id = ?', args: [detalle_id] });
  const det = detRes.rows[0];
  if (!det || nueva_cantidad < 0) return res.json({ mensaje: 'Sin cambios' });

  const diff = nueva_cantidad - det.cantidad;
  if (diff > 0) {
    await db.execute({ sql: 'UPDATE productos SET stock = stock - ? WHERE id = ?', args: [diff, det.producto_id] });
    await revertirDevolucion(v.id, null, det.producto_id, diff);
  } else if (diff < 0) {
    const cantDev = Math.abs(diff);
    const devMonto = cantDev * det.precio_unitario;
    await db.execute({ sql: 'UPDATE productos SET stock = stock + ? WHERE id = ?', args: [cantDev, det.producto_id] });
    
    const metReembolsoStr = formatMetodoReembolso(metodo_reembolso);
    await db.execute({
      sql: 'INSERT INTO historial_devoluciones (venta_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [v.id, det.producto_id, det.nombre, det.imagen, cantDev, det.precio_unitario, devMonto, `Venta - ${v.cliente_nombre}`, metReembolsoStr]
    });
  }

  if (nueva_cantidad === 0) {
    await db.execute({ sql: 'DELETE FROM detalle_ventas WHERE id = ?', args: [det.id] });
  } else {
    await db.execute({ sql: 'UPDATE detalle_ventas SET cantidad = ? WHERE id = ?', args: [nueva_cantidad, det.id] });
  }

  const nuevosItems = (await db.execute({ sql: 'SELECT * FROM detalle_ventas WHERE venta_id = ?', args: [req.params.id] })).rows;
  if (nuevosItems.length === 0) {
    await db.execute({ sql: 'DELETE FROM ventas WHERE id = ?', args: [req.params.id] });
  } else {
    const nuevoSubtotal = nuevosItems.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
    const nuevoTotal = Math.max(0, nuevoSubtotal - v.descuento);
    await db.execute({ sql: 'UPDATE ventas SET subtotal = ?, total = ? WHERE id = ?', args: [nuevoSubtotal, nuevoTotal, req.params.id] });
  }

  res.json({ mensaje: 'Cantidad modificada en venta' });
});

app.post('/api/ventas/:id/agregar-item', async (req, res) => {
  const { producto_id, cantidad, precio } = req.body;
  const vRes = await db.execute({ sql: 'SELECT * FROM ventas WHERE id = ?', args: [req.params.id] });
  const v = vRes.rows[0];

  await db.execute({ sql: 'UPDATE productos SET stock = stock - ? WHERE id = ?', args: [cantidad, producto_id] });
  await revertirDevolucion(v.id, null, producto_id, cantidad);

  const existRes = await db.execute({ sql: 'SELECT * FROM detalle_ventas WHERE venta_id = ? AND producto_id = ?', args: [req.params.id, producto_id] });
  const existente = existRes.rows[0];

  if (existente) {
    await db.execute({ sql: 'UPDATE detalle_ventas SET cantidad = cantidad + ? WHERE id = ?', args: [existente.id] });
  } else {
    const costRes = await db.execute({ sql: 'SELECT costo FROM productos WHERE id = ?', args: [producto_id] });
    const cost = costRes.rows[0]?.costo || 0;
    await db.execute({
      sql: 'INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)',
      args: [req.params.id, producto_id, cantidad, precio, cost]
    });
  }

  const nuevosItems = (await db.execute({ sql: 'SELECT * FROM detalle_ventas WHERE venta_id = ?', args: [req.params.id] })).rows;
  const nuevoSubtotal = nuevosItems.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
  const nuevoTotal = Math.max(0, nuevoSubtotal - v.descuento);
  await db.execute({ sql: 'UPDATE ventas SET subtotal = ?, total = ? WHERE id = ?', args: [nuevoSubtotal, nuevoTotal, req.params.id] });

  res.json({ mensaje: 'Ítem agregado a venta' });
});

app.post('/api/ventas/:id/devolver-total', async (req, res) => {
  const { metodo_reembolso } = req.body;
  const vRes = await db.execute({ sql: 'SELECT * FROM ventas WHERE id = ?', args: [req.params.id] });
  const v = vRes.rows[0];
  if (!v) return res.json({ mensaje: 'Venta no encontrada' });

  const itemsRes = await db.execute({ sql: 'SELECT dv.*, p.nombre, p.imagen FROM detalle_ventas dv JOIN productos p ON p.id = dv.producto_id WHERE dv.venta_id = ?', args: [v.id] });
  const metReembolsoStr = formatMetodoReembolso(metodo_reembolso);
  
  for (const i of itemsRes.rows) {
    await db.execute({ sql: 'UPDATE productos SET stock = stock + ? WHERE id = ?', args: [i.cantidad, i.producto_id] });
    await db.execute({
      sql: 'INSERT INTO historial_devoluciones (venta_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [v.id, i.producto_id, i.nombre, i.imagen, i.cantidad, i.precio_unitario, i.cantidad * i.precio_unitario, `Venta - ${v.cliente_nombre}`, metReembolsoStr]
    });
  }
  
  await db.execute({ sql: 'DELETE FROM detalle_ventas WHERE venta_id = ?', args: [v.id] });
  await db.execute({ sql: 'DELETE FROM ventas WHERE id = ?', args: [v.id] });

  res.json({ mensaje: 'Venta cancelada totalmente' });
});

// HISTORIAL DE DEVOLUCIONES UNIFICADO
app.get('/api/devoluciones', async (req, res) => {
  const r = await db.execute(`
    SELECT
      MAX(fecha) as fecha,
      origen,
      GROUP_CONCAT(DISTINCT detalle_pago) as detalle_pago,
      SUM(monto_devuelto) as total_monto,
      GROUP_CONCAT(
        CASE
          WHEN producto_id IS NOT NULL AND precio_unitario > 0 THEN cantidad || 'x ' || producto_nombre || ' ($' || ROUND(precio_unitario, 2) || ' c/u)'
          ELSE producto_nombre || ' ($' || ROUND(monto_devuelto, 2) || ')'
        END,
        ' | '
      ) as detalles
    FROM historial_devoluciones
    GROUP BY
      CASE WHEN venta_id IS NOT NULL THEN 'V_' || venta_id
           WHEN pedido_id IS NOT NULL THEN 'P_' || pedido_id
           ELSE 'D_' || id END,
      CASE WHEN producto_nombre LIKE '%Seña%' OR producto_id IS NULL THEN 1 ELSE 0 END
    ORDER BY fecha DESC
  `);
  res.json(r.rows);
});

// --- EGRESOS ---
app.get('/api/egresos', async (req, res) => {
  const r = await db.execute("SELECT * FROM egresos WHERE tipo = 'gasto' ORDER BY fecha DESC");
  res.json(r.rows);
});

app.post('/api/egresos', async (req, res) => { 
  await db.execute({
    sql: 'INSERT INTO egresos (categoria, concepto, monto, metodo_pago, tipo) VALUES (?, ?, ?, ?, ?)',
    args: [req.body.categoria, req.body.concepto, req.body.monto, req.body.metodo_pago, 'gasto']
  });
  res.json({ mensaje: 'Egreso guardado' }); 
});

app.put('/api/egresos/:id', async (req, res) => {
  await db.execute({
    sql: 'UPDATE egresos SET concepto = ?, monto = ?, categoria = ?, metodo_pago = ? WHERE id = ?',
    args: [req.body.concepto, req.body.monto, req.body.categoria, req.body.metodo_pago, req.params.id]
  });
  res.json({ mensaje: 'Egreso actualizado' });
});

app.delete('/api/egresos/:id', async (req, res) => { 
  await db.execute({ sql: 'DELETE FROM egresos WHERE id = ?', args: [req.params.id] });
  res.json({ mensaje: 'Egreso eliminado' }); 
});

// --- PEDIDOS Y LOGÍSTICA ---
app.get('/api/pedidos', async (req, res) => {
  const r = await db.execute("SELECT * FROM pedidos ORDER BY fecha DESC");
  res.json(r.rows);
});

app.get('/api/pedidos/:id/detalles', async (req, res) => {
  const pRes = await db.execute({ sql: 'SELECT * FROM pedidos WHERE id = ?', args: [req.params.id] });
  const itemsRes = await db.execute({ sql: 'SELECT dp.*, p.nombre, p.imagen FROM detalle_pedidos dp JOIN productos p ON p.id = dp.producto_id WHERE dp.pedido_id = ?', args: [req.params.id] });
  res.json({ pedido: pRes.rows[0], items: itemsRes.rows });
});

app.post('/api/pedidos', async (req, res) => {
  const { codigo_pedido, cliente, tel, dni, subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia, localidad, codigo_postal, tipo_direccion, direccion_domicilio, transporte, tracking, uber_pago, uber_costo, uber_metodo, items, sobre_stock, comisionado_id } = req.body;
  const estadoInicial = saldo_pendiente > 0 ? 'falta_saldar' : 'a_preparar';
  const obs = sobre_stock ? 'Falta cubrir Stock' : '';
  
  const pRes = await db.execute({
    sql: `INSERT INTO pedidos (codigo_pedido, cliente_nombre, cliente_telefono, cliente_dni, subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia, localidad, codigo_postal, tipo_direccion, direccion_domicilio, transporte, tracking, estado, observacion, comisionado_id) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [codigo_pedido||'', cliente, tel||'', dni||'', subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia||'', localidad||'', codigo_postal||'', tipo_direccion||'sucursal', direccion_domicilio||'', transporte||'', tracking||'', estadoInicial, obs, comisionado_id || null]
  });
  
  const pedId = Number(pRes.lastInsertRowid);

  if (tipo_entrega === 'salta' && uber_pago === 'pagado') {
    await db.execute({
      sql: 'INSERT INTO egresos (categoria, concepto, monto, metodo_pago, tipo) VALUES (?, ?, ?, ?, ?)',
      args: ['Logística y Fletes', `Flete Uber (Pedido: ${cliente})`, uber_costo || 0, uber_metodo || 'efectivo', 'gasto']
    });
  }

  for (const i of items) {
    await db.execute({ sql: 'UPDATE productos SET stock = stock - ? WHERE id = ?', args: [i.cantidad, i.producto_id] });
    await db.execute({ sql: 'INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)', args: [pedId, i.producto_id, i.cantidad, i.precio] });
  }

  if (saldo_pendiente === 0) {
    await registrarVentaDesdePedido(pedId);
  }

  res.json({ mensaje: 'Pedido registrado' });
});

app.post('/api/pedidos/:id/saldar', async (req, res) => {
  const { pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr } = req.body;
  const pRes = await db.execute({ sql: 'SELECT * FROM pedidos WHERE id = ?', args: [req.params.id] });
  const p = pRes.rows[0];

  const ef = (p.sena_efectivo||0) + (pago_efectivo||0);
  const ta = (p.sena_tarjeta||0) + (pago_tarjeta||0);
  const tr = (p.sena_transferencia||0) + (pago_transferencia||0);
  const qr = (p.sena_qr||0) + (pago_qr||0);
  
  const nuevaBaseSena = Math.max(0, p.subtotal - p.descuento);

  await db.execute({
    sql: "UPDATE pedidos SET base_sena = ?, sena_efectivo = ?, sena_tarjeta = ?, sena_transferencia
