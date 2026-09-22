const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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
      sql: 'UPDATE ventas SET subtotal = ?, descuento = ?, pago_efectivo = ?, pago_tarjeta = ?, pago_transferencia = ?, pago_qr = ?, total = ? WHERE id = ?',
      args: [p.subtotal, p.descuento, p.sena_efectivo, p.sena_tarjeta, p.sena_transferencia, p.sena_qr, totalPagado, p.venta_id]
    });
    return p.venta_id;
  }

  const totalFinal = (p.sena_efectivo||0) + (p.sena_tarjeta||0) + (p.sena_transferencia||0) + (p.sena_qr||0);
  const vRes = await db.execute({
    sql: 'INSERT INTO ventas (subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [p.subtotal, p.descuento, p.sena_efectivo, p.sena_tarjeta, p.sena_transferencia, p.sena_qr, totalFinal, p.cliente_nombre]
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
  const { subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre, items } = req.body;
  const vRes = await db.execute({
    sql: 'INSERT INTO ventas (subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre || 'Venta de Mostrador']
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
    await db.execute({ sql: 'UPDATE detalle_ventas SET cantidad = cantidad + ? WHERE id = ?', args: [cantidad, existente.id] });
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
  const { codigo_pedido, cliente, tel, dni, subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia, localidad, codigo_postal, tipo_direccion, direccion_domicilio, transporte, tracking, uber_pago, uber_costo, uber_metodo, items, sobre_stock } = req.body;
  const estadoInicial = saldo_pendiente > 0 ? 'falta_saldar' : 'a_preparar';
  const obs = sobre_stock ? 'Falta cubrir Stock' : '';
  
  const pRes = await db.execute({
    sql: `INSERT INTO pedidos (codigo_pedido, cliente_nombre, cliente_telefono, cliente_dni, subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia, localidad, codigo_postal, tipo_direccion, direccion_domicilio, transporte, tracking, estado, observacion) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [codigo_pedido||'', cliente, tel||'', dni||'', subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia||'', localidad||'', codigo_postal||'', tipo_direccion||'sucursal', direccion_domicilio||'', transporte||'', tracking||'', estadoInicial, obs]
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
    sql: "UPDATE pedidos SET base_sena = ?, sena_efectivo = ?, sena_tarjeta = ?, sena_transferencia = ?, sena_qr = ?, saldo_pendiente = 0 WHERE id = ?",
    args: [nuevaBaseSena, ef, ta, tr, qr, p.id]
  });
  
  await registrarVentaDesdePedido(p.id);

  const nuevoEstado = p.estado === 'enviado' ? 'enviado' : 'a_preparar';
  await db.execute({ sql: "UPDATE pedidos SET estado = ? WHERE id = ?", args: [nuevoEstado, p.id] });

  res.json({ mensaje: 'Saldado' });
});

app.put('/api/pedidos/:id/estado', async (req, res) => {
  const { estado, tracking } = req.body;
  if(tracking !== undefined) {
    await db.execute({ sql: 'UPDATE pedidos SET estado = ?, tracking = ? WHERE id = ?', args: [estado, tracking, req.params.id] });
  } else {
    await db.execute({ sql: 'UPDATE pedidos SET estado = ? WHERE id = ?', args: [estado, req.params.id] });
  }

  if (estado === 'enviado' || estado === 'a_preparar' || estado === 'listo_para_enviar') {
    await registrarVentaDesdePedido(req.params.id);
  }

  res.json({ mensaje: 'Estado Actualizado' });
});

app.get('/api/pedidos/:id/guia-viacargo', async (req, res) => {
  const pRes = await db.execute({ sql: 'SELECT * FROM pedidos WHERE id = ?', args: [req.params.id] });
  const p = pRes.rows[0];
  if (!p) return res.status(404).send('Pedido no encontrado');

  const itemsRes = await db.execute({ sql: 'SELECT dp.*, prod.nombre FROM detalle_pedidos dp JOIN productos prod ON prod.id = dp.producto_id WHERE dp.pedido_id = ?', args: [p.id] });
  const direTxt = p.tipo_direccion === 'sucursal' ? 'Retiro en Sucursal Vía Cargo' : `Domicilio: ${p.direccion_domicilio || 'No especificada'}`;

  const docHtml = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset='utf-8'><title>Guía de Envío Vía Cargo</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
      .title { text-align: center; color: #1a365d; border-bottom: 2px solid #1a365d; padding-bottom: 5px; }
      .box { border: 1px solid #cbd5e1; padding: 12px; margin-bottom: 15px; border-radius: 5px; background-color: #f8fafc; }
      .box-header { background-color: #2563eb; color: white; padding: 6px 10px; font-weight: bold; font-size: 14px; margin-bottom: 10px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; font-size: 12px; }
      th { background-color: #e2e8f0; }
    </style>
    </head>
    <body>
      <h2 class='title'>ETIQUETA DE ENVÍO - VÍA CARGO</h2>
      <p style='text-align:right;'><b>Código de Pedido:</b> ${p.codigo_pedido || ('PED-' + p.id)} | <b>Fecha:</b> ${new Date(p.fecha).toLocaleDateString()}</p>
      
      <div class='box'>
        <div class='box-header'>DATOS DEL REMITENTE (QUIEN ENVÍA)</div>
        <p><b>Nombre:</b> RICARDO BENEGAS</p>
        <p><b>DNI:</b> 256338166</p>
        <p><b>Celular:</b> 1124889545</p>
        <p><b>Origen:</b> Salta Capital, Salta, Argentina</p>
      </div>

      <div class='box'>
        <div class='box-header'>DATOS DEL DESTINATARIO (QUIEN RECIBE)</div>
        <p><b>Nombre y Apellido:</b> ${p.cliente_nombre}</p>
        <p><b>DNI:</b> ${p.cliente_dni || 'No informado'}</p>
        <p><b>Teléfono:</b> ${p.cliente_telefono || 'No informado'}</p>
        <p><b>Provincia Destino:</b> ${p.provincia || 'No informada'}</p>
        <p><b>Localidad / Ciudad:</b> ${p.localidad || 'No informada'}</p>
        <p><b>Código Postal:</b> ${p.codigo_postal || 'No informado'}</p>
        <p><b>Tipo de Entrega:</b> ${direTxt}</p>
        <p><b>Empresa de Transporte:</b> ${p.transporte || 'Vía Cargo'}</p>
      </div>

      <div class='box'>
        <div class='box-header'>CONTENIDO DEL PAQUETE</div>
        <table>
          <thead><tr><th>Producto</th><th>Cantidad</th></tr></thead>
          <tbody>
            ${itemsRes.rows.map(i => `<tr><td>${i.nombre}</td><td>${i.cantidad} u.</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `;

  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="Guia-ViaCargo-${p.codigo_pedido || p.id}.doc"`);
  res.send(docHtml);
});

app.delete('/api/pedidos/:id', async (req, res) => {
  const { metodo_reembolso } = req.body || {};
  const pRes = await db.execute({ sql: 'SELECT * FROM pedidos WHERE id = ?', args: [req.params.id] });
  const p = pRes.rows[0];
  if (!p) return res.json({ mensaje: 'Pedido no encontrado' });
  
  if (p.venta_id) {
     await db.execute({ sql: 'DELETE FROM detalle_ventas WHERE venta_id = ?', args: [p.venta_id] });
     await db.execute({ sql: 'DELETE FROM ventas WHERE id = ?', args: [p.venta_id] });
  }

  const detallesRes = await db.execute({ sql: 'SELECT dp.*, prod.nombre, prod.imagen FROM detalle_pedidos dp JOIN productos prod ON prod.id = dp.producto_id WHERE dp.pedido_id = ?', args: [p.id] });
  for (const d of detallesRes.rows) {
    await db.execute({ sql: 'UPDATE productos SET stock = stock + ? WHERE id = ?', args: [d.cantidad, d.producto_id] });
  }

  const totalSenaPagada = (p.sena_efectivo||0) + (p.sena_tarjeta||0) + (p.sena_transferencia||0) + (p.sena_qr||0);

  if (p.estado === 'enviado') {
    const origenD = `Pedido - ${p.cliente_nombre}`;
    const metStr = formatMetodoReembolso(metodo_reembolso);
    for (const d of detallesRes.rows) {
      await db.execute({
        sql: 'INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [p.id, d.producto_id, d.nombre, d.imagen, d.cantidad, d.precio_unitario, d.cantidad * d.precio_unitario, origenD, metStr]
      });
    }
  } else if (totalSenaPagada > 0) {
    const origenD = `Pedido Cancelado - ${p.cliente_nombre}`;
    const metStr = formatMetodoReembolso(metodo_reembolso);
    await db.execute({
      sql: 'INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [p.id, null, 'Pedido: Cancelado Totalmente', '', 1, totalSenaPagada, totalSenaPagada, origenD, metStr]
    });
  }

  await db.execute({ sql: 'DELETE FROM pedidos WHERE id = ?', args: [p.id] });
  res.json({ mensaje: 'Pedido cancelado' });
});

app.post('/api/pedidos/:id/modificar-cantidad', async (req, res) => {
  const { detalle_id, nueva_cantidad, metodo_reembolso } = req.body;
  const detRes = await db.execute({
    sql: 'SELECT dp.*, p.nombre, p.imagen, ped.cliente_nombre, ped.venta_id, ped.estado, ped.sena_efectivo, ped.sena_tarjeta, ped.sena_transferencia, ped.sena_qr, ped.base_sena, ped.subtotal, ped.descuento FROM detalle_pedidos dp JOIN productos p ON p.id = dp.producto_id JOIN pedidos ped ON ped.id = dp.pedido_id WHERE dp.id = ?',
    args: [detalle_id]
  });
  const det = detRes.rows[0];
  if (!det || nueva_cantidad < 0) return res.json({ mensaje: 'Sin cambios' });

  const diff = nueva_cantidad - det.cantidad;
  if (diff > 0) {
    await db.execute({ sql: 'UPDATE productos SET stock = stock - ? WHERE id = ?', args: [diff, det.producto_id] });
    await revertirDevolucion(null, req.params.id, det.producto_id, diff);
  } else if (diff < 0) {
    const cantDev = Math.abs(diff);
    await db.execute({ sql: 'UPDATE productos SET stock = stock + ? WHERE id = ?', args: [cantDev, det.producto_id] });
    
    if (det.estado === 'enviado') {
      const devMonto = cantDev * det.precio_unitario;
      const metStr = formatMetodoReembolso(metodo_reembolso);
      await db.execute({
        sql: 'INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [req.params.id, det.producto_id, det.nombre, det.imagen, cantDev, det.precio_unitario, devMonto, `Pedido - ${det.cliente_nombre}`, metStr]
      });
    }
  }

  if (nueva_cantidad === 0) {
    await db.execute({ sql: 'DELETE FROM detalle_pedidos WHERE id = ?', args: [det.id] });
  } else {
    await db.execute({ sql: 'UPDATE detalle_pedidos SET cantidad = ? WHERE id = ?', args: [nueva_cantidad, det.id] });
  }

  if (det.venta_id) {
    const detVRes = await db.execute({ sql: 'SELECT id FROM detalle_ventas WHERE venta_id = ? AND producto_id = ?', args: [det.venta_id, det.producto_id] });
    const detV = detVRes.rows[0];
    if (detV) {
      if (nueva_cantidad === 0) await db.execute({ sql: 'DELETE FROM detalle_ventas WHERE id = ?', args: [detV.id] });
      else await db.execute({ sql: 'UPDATE detalle_ventas SET cantidad = ? WHERE id = ?', args: [nueva_cantidad, detV.id] });
    }
    const nuevosDetV = (await db.execute({ sql: 'SELECT * FROM detalle_ventas WHERE venta_id = ?', args: [det.venta_id] })).rows;
    if (nuevosDetV.length === 0) {
      await db.execute({ sql: 'DELETE FROM ventas WHERE id = ?', args: [det.venta_id] });
    } else {
      const nuevoSubV = nuevosDetV.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
      const vOriginal = (await db.execute({ sql: 'SELECT descuento FROM ventas WHERE id = ?', args: [det.venta_id] })).rows[0];
      await db.execute({ sql: 'UPDATE ventas SET subtotal = ?, total = ? WHERE id = ?', args: [nuevoSubV, Math.max(0, nuevoSubV - vOriginal.descuento), det.venta_id] });
    }
  }

  const nuevosDet = (await db.execute({ sql: 'SELECT * FROM detalle_pedidos WHERE pedido_id = ?', args: [req.params.id] })).rows;
  if (nuevosDet.length === 0) {
    const ped = (await db.execute({ sql: 'SELECT * FROM pedidos WHERE id = ?', args: [req.params.id] })).rows[0];
    const totalSenaPagada = (ped.sena_efectivo||0) + (ped.sena_tarjeta||0) + (ped.sena_transferencia||0) + (ped.sena_qr||0);
    if (totalSenaPagada > 0) {
      const metStr = formatMetodoReembolso(metodo_reembolso);
      await db.execute({
        sql: 'INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [req.params.id, null, 'Pedido Cancelado Totalmente', '', 1, totalSenaPagada, totalSenaPagada, `Pedido Cancelado - ${ped.cliente_nombre}`, metStr]
      });
    }
    if (ped.venta_id) await db.execute({ sql: 'DELETE FROM ventas WHERE id = ?', args: [ped.venta_id] });
    await db.execute({ sql: 'DELETE FROM pedidos WHERE id = ?', args: [req.params.id] });
  } else {
    const nuevoSub = nuevosDet.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
    const ped = (await db.execute({ sql: 'SELECT * FROM pedidos WHERE id = ?', args: [req.params.id] })).rows[0];
    const totalPedidoNuevo = Math.max(0, nuevoSub - ped.descuento);

    let baseSenaActual = ped.base_sena || 0;
    let nuevoSaldo = totalPedidoNuevo - baseSenaActual;

    if (ped.estado !== 'enviado' && nuevoSaldo < 0) {
      const excedenteBase = Math.abs(nuevoSaldo);
      const metStr = formatMetodoReembolso(metodo_reembolso);
      await db.execute({
        sql: 'INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [req.params.id, null, 'Excedente de Seña Reintegrado', '', 1, excedenteBase, excedenteBase, `Pedido - ${ped.cliente_nombre}`, metStr]
      });

      let rRest = excedenteBase;
      let ef = ped.sena_efectivo||0, tr = ped.sena_transferencia||0, ta = ped.sena_tarjeta||0, qr = ped.sena_qr||0;
      if (metodo_reembolso === 'transferencia' || metodo_reembolso === '2') {
        if (tr >= rRest) { tr -= rRest; rRest = 0; }
        else { rRest -= tr; tr = 0; }
      }
      if (rRest > 0) {
        if (ef >= rRest) { ef -= rRest; rRest = 0; }
        else { rRest -= ef; ef = 0; }
      }
      if (rRest > 0 && tr > 0) {
        if (tr >= rRest) { tr -= rRest; rRest = 0; }
        else { rRest -= tr; tr = 0; }
      }
      if (rRest > 0 && ta > 0) {
        if (ta >= rRest) { ta -= rRest; rRest = 0; }
        else { rRest -= ta; ta = 0; }
      }
      if (rRest > 0 && qr > 0) {
        if (qr >= rRest) { qr -= rRest; rRest = 0; }
        else { rRest -= qr; qr = 0; }
      }

      baseSenaActual = totalPedidoNuevo;
      await db.execute({
        sql: 'UPDATE pedidos SET base_sena = ?, sena_efectivo = ?, sena_transferencia = ?, sena_tarjeta = ?, sena_qr = ? WHERE id = ?',
        args: [baseSenaActual, ef, tr, ta, qr, req.params.id]
      });
      nuevoSaldo = 0;
    }

    let estadoConservado = ped.estado;
    if (ped.estado !== 'enviado' && ped.estado !== 'listo_para_enviar') {
      estadoConservado = nuevoSaldo > 0 ? 'falta_saldar' : 'a_preparar';
    }
    await db.execute({
      sql: 'UPDATE pedidos SET subtotal = ?, base_sena = ?, saldo_pendiente = ?, estado = ? WHERE id = ?',
      args: [nuevoSub, baseSenaActual, Math.max(0, nuevoSaldo), estadoConservado, req.params.id]
    });
  }

  res.json({ mensaje: 'Cantidad de pedido modificada' });
});

app.post('/api/pedidos/:id/agregar-item', async (req, res) => {
  const { producto_id, cantidad, precio } = req.body;
  const pedRes = await db.execute({ sql: 'SELECT * FROM pedidos WHERE id = ?', args: [req.params.id] });
  const ped = pedRes.rows[0];
  if (!ped) return res.json({ mensaje: 'Pedido no encontrado' });

  await db.execute({ sql: 'UPDATE productos SET stock = stock - ? WHERE id = ?', args: [cantidad, producto_id] });
  await revertirDevolucion(null, req.params.id, producto_id, cantidad);

  const existRes = await db.execute({ sql: 'SELECT * FROM detalle_pedidos WHERE pedido_id = ? AND producto_id = ?', args: [req.params.id, producto_id] });
  const existente = existRes.rows[0];

  if (existente) {
    await db.execute({ sql: 'UPDATE detalle_pedidos SET cantidad = cantidad + ? WHERE id = ?', args: [cantidad, existente.id] });
  } else {
    await db.execute({ sql: 'INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)', args: [req.params.id, producto_id, cantidad, precio] });
  }

  if (ped.venta_id) {
    const existVRes = await db.execute({ sql: 'SELECT * FROM detalle_ventas WHERE venta_id = ? AND producto_id = ?', args: [ped.venta_id, producto_id] });
    const existV = existVRes.rows[0];
    if (existV) {
      await db.execute({ sql: 'UPDATE detalle_ventas SET cantidad = cantidad + ? WHERE id = ?', args: [existV.id] });
    } else {
      const costRes = await db.execute({ sql: 'SELECT costo FROM productos WHERE id = ?', args: [producto_id] });
      const cost = costRes.rows[0]?.costo || 0;
      await db.execute({ sql: 'INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)', args: [ped.venta_id, producto_id, cantidad, precio, cost] });
    }
    const nuevosDetV = (await db.execute({ sql: 'SELECT * FROM detalle_ventas WHERE venta_id = ?', args: [ped.venta_id] })).rows;
    const nuevoSubV = nuevosDetV.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
    await db.execute({ sql: 'UPDATE ventas SET subtotal = ?, total = ? WHERE id = ?', args: [nuevoSubV, Math.max(0, nuevoSubV - ped.descuento), ped.venta_id] });
  }

  const nuevosDet = (await db.execute({ sql: 'SELECT * FROM detalle_pedidos WHERE pedido_id = ?', args: [req.params.id] })).rows;
  const nuevoSub = nuevosDet.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
  const baseSenaActual = ped.base_sena || 0;
  const nuevoSaldo = nuevoSub - ped.descuento - baseSenaActual;
  
  let estadoConservado = ped.estado;
  if (ped.estado !== 'enviado' && ped.estado !== 'listo_para_enviar') {
    estadoConservado = nuevoSaldo > 0 ? 'falta_saldar' : 'a_preparar';
  }
  await db.execute({ sql: 'UPDATE pedidos SET subtotal = ?, saldo_pendiente = ?, estado = ? WHERE id = ?', args: [nuevoSub, Math.max(0, nuevoSaldo), estadoConservado, req.params.id] });

  res.json({ mensaje: 'Item agregado a pedido' });
});

// --- REPORTES ---
app.get('/api/reportes/dashboard', async (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0,7);
  
  const v = (await db.execute({ sql: "SELECT SUM(total) as t FROM ventas WHERE strftime('%Y-%m', fecha) = ?", args: [mes] })).rows[0]?.t || 0;
  const c = (await db.execute({ sql: "SELECT SUM(dv.cantidad * dv.costo_unitario) as c FROM detalle_ventas dv JOIN ventas v ON v.id = dv.venta_id WHERE strftime('%Y-%m', v.fecha) = ?", args: [mes] })).rows[0]?.c || 0;
  const g = (await db.execute({ sql: "SELECT SUM(monto) as m FROM egresos WHERE strftime('%Y-%m', fecha) = ? AND tipo = 'gasto'", args: [mes] })).rows[0]?.m || 0;
  
  const prods = (await db.execute({ sql: "SELECT p.nombre, SUM(dv.cantidad) as cant FROM detalle_ventas dv JOIN ventas v ON v.id=dv.venta_id JOIN productos p ON p.id=dv.producto_id WHERE strftime('%Y-%m', v.fecha) = ? GROUP BY p.id ORDER BY cant DESC LIMIT 10", args: [mes] })).rows;
  const gas = (await db.execute({ sql: "SELECT categoria, SUM(monto) as m FROM egresos WHERE strftime('%Y-%m', fecha) = ? AND tipo = 'gasto' GROUP BY categoria ORDER BY m DESC LIMIT 10", args: [mes] })).rows;
  const ev = (await db.execute({ sql: `SELECT strftime('%d', fecha) as d, SUM(total) as i, 0 as g FROM ventas WHERE strftime('%Y-%m', fecha) = ? GROUP BY d UNION ALL SELECT strftime('%d', fecha) as d, 0 as i, SUM(monto) as g FROM egresos WHERE strftime('%Y-%m', fecha) = ? AND tipo = 'gasto' GROUP BY d`, args: [mes, mes] })).rows;

  res.json({ pl: { ventas: v, cogs: c, gastos: g, neta: v - c - g }, prods, gas, ev });
});

app.listen(process.env.PORT || 3000, () => console.log('Servidor listo'));
