const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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
function registrarVentaDesdePedido(pedidoId) {
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
  if (!p) return null;

  if (p.venta_id) {
    const totalPagado = (p.sena_efectivo||0) + (p.sena_tarjeta||0) + (p.sena_transferencia||0) + (p.sena_qr||0);
    db.prepare('UPDATE ventas SET subtotal = ?, descuento = ?, pago_efectivo = ?, pago_tarjeta = ?, pago_transferencia = ?, pago_qr = ?, total = ? WHERE id = ?')
      .run(p.subtotal, p.descuento, p.sena_efectivo, p.sena_tarjeta, p.sena_transferencia, p.sena_qr, totalPagado, p.venta_id);
    return p.venta_id;
  }

  const totalFinal = (p.sena_efectivo||0) + (p.sena_tarjeta||0) + (p.sena_transferencia||0) + (p.sena_qr||0);
  const v = db.prepare('INSERT INTO ventas (subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.subtotal, p.descuento, p.sena_efectivo, p.sena_tarjeta, p.sena_transferencia, p.sena_qr, totalFinal, p.cliente_nombre);
  
  const det = db.prepare('SELECT * FROM detalle_pedidos WHERE pedido_id = ?').all(p.id);
  const ins = db.prepare('INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)');
  const cost = db.prepare('SELECT costo FROM productos WHERE id = ?');
  for (const d of det) ins.run(v.lastInsertRowid, d.producto_id, d.cantidad, d.precio_unitario, cost.get(d.producto_id)?.costo || 0);

  db.prepare('UPDATE pedidos SET venta_id = ? WHERE id = ?').run(v.lastInsertRowid, p.id);
  return v.lastInsertRowid;
}

// HELPER DE REVERSIÓN DE DEVOLUCIONES DE PRODUCTOS
function revertirDevolucion(venta_id, pedido_id, producto_id, cantidad_a_revertir) {
  let campoWhere = venta_id ? 'venta_id = ?' : 'pedido_id = ?';
  let targetId = venta_id || pedido_id;
  let devs = db.prepare(`SELECT * FROM historial_devoluciones WHERE ${campoWhere} AND producto_id = ? ORDER BY id DESC`).all(targetId, producto_id);
  
  let restante = cantidad_a_revertir;
  for (let d of devs) {
    if (restante <= 0) break;
    if (d.cantidad <= restante) {
      restante -= d.cantidad;
      db.prepare('DELETE FROM historial_devoluciones WHERE id = ?').run(d.id);
    } else {
      let nuevaCant = d.cantidad - restante;
      let nuevoMonto = nuevaCant * d.precio_unitario;
      db.prepare('UPDATE historial_devoluciones SET cantidad = ?, monto_devuelto = ? WHERE id = ?').run(nuevaCant, nuevoMonto, d.id);
      restante = 0;
    }
  }
}

// --- CAJA ---
app.get('/api/caja/estado', (req, res) => res.json(db.prepare("SELECT * FROM caja WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1").get() || { estado: 'cerrada' }));
app.post('/api/caja/abrir', (req, res) => {
  db.prepare("INSERT INTO caja (monto_inicial, personal, estado) VALUES (?, ?, 'abierta')").run(req.body.monto_inicial, req.body.personal);
  res.json({ mensaje: 'Caja abierta' });
});
app.get('/api/caja/pre-cierre', (req, res) => {
  const caja = db.prepare("SELECT * FROM caja WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1").get();
  if(!caja) return res.json({ esperado: 0 });
  const ventasEf = db.prepare("SELECT SUM(pago_efectivo) as t FROM ventas WHERE fecha >= ?").get(caja.fecha_apertura).t || 0;
  const senasEf = db.prepare("SELECT SUM(sena_efectivo) as s FROM pedidos WHERE fecha >= ? AND estado = 'falta_saldar'").get(caja.fecha_apertura).s || 0;
  const egresosEf = db.prepare("SELECT SUM(monto) as m FROM egresos WHERE fecha >= ? AND metodo_pago = 'efectivo'").get(caja.fecha_apertura).m || 0;
  res.json({ esperado: caja.monto_inicial + ventasEf + senasEf - egresosEf });
});
app.post('/api/caja/cerrar', (req, res) => {
  const { monto_final, esperado } = req.body;
  const diff = esperado < 0 ? (monto_final + esperado) : (monto_final - esperado);
  const caja = db.prepare("SELECT * FROM caja WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1").get();
  if(!caja) return res.status(400).json({error: 'Sin caja abierta'});
  db.prepare("UPDATE caja SET fecha_cierre = (DATETIME('now', 'localtime')), monto_final = ?, diferencia = ?, estado = 'cerrada' WHERE id = ?").run(monto_final, diff, caja.id);
  res.json({ mensaje: 'Caja cerrada' });
});

// HISTORIAL DE CAJA CON FILTRO POR DÍA, MES O AÑO
app.get('/api/caja/historial', (req, res) => {
  let query = "SELECT * FROM caja WHERE estado = 'cerrada'";
  let params = [];
  
  if (req.query.fecha) {
    query += " AND (fecha_apertura LIKE ? OR fecha_cierre LIKE ?)";
    params.push(`${req.query.fecha}%`, `${req.query.fecha}%`);
  }
  
  query += " ORDER BY fecha_cierre DESC";
  res.json(db.prepare(query).all(...params));
});

// --- PRODUCTOS E HISTORIAL DE REINGRESOS ---
app.get('/api/productos', (req, res) => res.json(db.prepare('SELECT * FROM productos').all()));
app.get('/api/productos/buscar', (req, res) => {
  const q = `%${req.query.q}%`;
  const cat = req.query.categoria;
  if (cat) {
    res.json(db.prepare('SELECT * FROM productos WHERE categoria = ? AND (nombre LIKE ? OR codigo_barras LIKE ?) LIMIT 15').all(cat, q, q));
  } else {
    res.json(db.prepare('SELECT * FROM productos WHERE nombre LIKE ? OR codigo_barras LIKE ? LIMIT 10').all(q, q));
  }
});

app.post('/api/productos', (req, res) => {
  const { codigo_barras, nombre, categoria, costo, precio, stock, stock_minimo, imagen } = req.body;
  db.transaction(() => {
    const resIns = db.prepare(`INSERT INTO productos (codigo_barras, nombre, categoria, costo, precio, stock, stock_minimo, imagen) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(codigo_barras) DO UPDATE SET nombre = excluded.nombre, categoria = excluded.categoria, costo = excluded.costo, precio = excluded.precio, stock = stock + excluded.stock, stock_minimo = excluded.stock_minimo, imagen = excluded.imagen`).run(codigo_barras, nombre, categoria||'Hogar', costo||0, precio, stock, stock_minimo||5, imagen||'');
    const prodId = resIns.lastInsertRowid || db.prepare('SELECT id FROM productos WHERE codigo_barras = ?').get(codigo_barras).id;
    db.prepare('INSERT INTO historial_stock (producto_id, producto_nombre, categoria, cantidad, tipo, detalle) VALUES (?, ?, ?, ?, ?, ?)').run(prodId, nombre, categoria||'Hogar', stock, 'Alta / Creación', 'Registro inicial de producto');
  })();
  res.json({ mensaje: 'Guardado e ingresado al historial' });
});

app.post('/api/productos/reingreso', (req, res) => {
  const { producto_id, cantidad, detalle } = req.body;
  db.transaction(() => {
    const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(producto_id);
    if (!p) throw new Error('Producto no encontrado');
    db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(cantidad, producto_id);
    db.prepare('INSERT INTO historial_stock (producto_id, producto_nombre, categoria, cantidad, tipo, detalle) VALUES (?, ?, ?, ?, ?, ?)').run(producto_id, p.nombre, p.categoria, cantidad, 'Reingreso Stock', detalle || 'Reingreso manual de mercadería');
  })();
  res.json({ mensaje: 'Stock sumado correctamente' });
});

app.get('/api/productos/reingresos/historial', (req, res) => {
  let query = 'SELECT * FROM historial_stock WHERE 1=1';
  let params = [];
  if (req.query.categoria) { query += ' AND categoria = ?'; params.push(req.query.categoria); }
  if (req.query.producto_id) { query += ' AND producto_id = ?'; params.push(req.query.producto_id); }
  if (req.query.fecha_desde) { query += ' AND DATE(fecha) >= ?'; params.push(req.query.fecha_desde); }
  if (req.query.fecha_hasta) { query += ' AND DATE(fecha) <= ?'; params.push(req.query.fecha_hasta); }
  query += ' ORDER BY fecha DESC LIMIT 150';
  res.json(db.prepare(query).all(...params));
});

app.put('/api/productos/:id', (req, res) => {
  const { codigo_barras, nombre, categoria, costo, precio, stock, imagen } = req.body;
  db.transaction(() => {
    const pActual = db.prepare('SELECT stock FROM productos WHERE id = ?').get(req.params.id);
    const diff = stock - (pActual ? pActual.stock : 0);
    db.prepare(`UPDATE productos SET codigo_barras = ?, nombre = ?, categoria = ?, costo = ?, precio = ?, stock = ?, imagen = ? WHERE id = ?`).run(codigo_barras, nombre, categoria, costo, precio, stock, imagen, req.params.id);
    if (diff !== 0) {
      db.prepare('INSERT INTO historial_stock (producto_id, producto_nombre, categoria, cantidad, tipo, detalle) VALUES (?, ?, ?, ?, ?, ?)').run(req.params.id, nombre, categoria, diff, 'Edición Manual', diff > 0 ? `Aumento manual (+${diff})` : `Disminución manual (${diff})`);
    }
  })();
  res.json({ mensaje: 'Actualizado' });
});

app.delete('/api/productos/:id', (req, res) => { db.prepare('DELETE FROM productos WHERE id = ?').run(req.params.id); res.json({ mensaje: 'Borrado' }); });

// --- VENTAS ---
app.get('/api/ventas', (req, res) => {
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
  res.json(db.prepare(query).all(...params));
});

app.post('/api/ventas', (req, res) => {
  const { subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre, items } = req.body;
  const id = db.transaction(() => {
    const v = db.prepare('INSERT INTO ventas (subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, cliente_nombre || 'Venta de Mostrador');
    const ins = db.prepare('INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)');
    const upd = db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?');
    const cost = db.prepare('SELECT costo FROM productos WHERE id = ?');
    for (const i of items) {
      upd.run(i.cantidad, i.producto_id);
      ins.run(v.lastInsertRowid, i.producto_id, i.cantidad, i.precio, cost.get(i.producto_id)?.costo || 0);
    }
    return v.lastInsertRowid;
  })();
  res.json({ mensaje: 'Venta registrada', venta_id: id });
});

app.get('/api/ventas/:id/detalles', (req, res) => {
  const v = db.prepare('SELECT * FROM ventas WHERE id = ?').get(req.params.id);
  const items = db.prepare(`SELECT dv.*, p.nombre, p.imagen FROM detalle_ventas dv JOIN productos p ON p.id = dv.producto_id WHERE dv.venta_id = ?`).all(req.params.id);
  const es_pedido = db.prepare('SELECT id FROM pedidos WHERE venta_id = ?').get(req.params.id);
  res.json({ venta: v, items, es_pedido: !!es_pedido });
});

app.post('/api/ventas/:id/modificar-cantidad', (req, res) => {
  db.transaction(() => {
    const { detalle_id, nueva_cantidad, metodo_reembolso } = req.body;
    const v = db.prepare('SELECT * FROM ventas WHERE id = ?').get(req.params.id);
    const esPedido = db.prepare('SELECT id FROM pedidos WHERE venta_id = ?').get(req.params.id);
    if (esPedido) throw new Error('Esta venta pertenece a un Pedido. Debe modificarse desde la sección Pedidos Logística.');

    const det = db.prepare('SELECT dv.*, p.nombre, p.imagen FROM detalle_ventas dv JOIN productos p ON p.id = dv.producto_id WHERE dv.id = ?').get(detalle_id);
    if (!det || nueva_cantidad < 0) return;

    const diff = nueva_cantidad - det.cantidad;
    if (diff > 0) {
      db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(diff, det.producto_id);
      revertirDevolucion(v.id, null, det.producto_id, diff);
    } else if (diff < 0) {
      const cantDev = Math.abs(diff);
      const devMonto = cantDev * det.precio_unitario;
      db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(cantDev, det.producto_id);
      
      const metReembolsoStr = formatMetodoReembolso(metodo_reembolso);
      db.prepare('INSERT INTO historial_devoluciones (venta_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(v.id, det.producto_id, det.nombre, det.imagen, cantDev, det.precio_unitario, devMonto, `Venta - ${v.cliente_nombre}`, metReembolsoStr);
    }

    if (nueva_cantidad === 0) {
      db.prepare('DELETE FROM detalle_ventas WHERE id = ?').run(det.id);
    } else {
      db.prepare('UPDATE detalle_ventas SET cantidad = ? WHERE id = ?').run(nueva_cantidad, det.id);
    }

    const nuevosItems = db.prepare('SELECT * FROM detalle_ventas WHERE venta_id = ?').all(req.params.id);
    if (nuevosItems.length === 0) {
      db.prepare('DELETE FROM ventas WHERE id = ?').run(req.params.id);
    } else {
      const nuevoSubtotal = nuevosItems.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
      const nuevoTotal = Math.max(0, nuevoSubtotal - v.descuento);
      db.prepare('UPDATE ventas SET subtotal = ?, total = ? WHERE id = ?').run(nuevoSubtotal, nuevoTotal, req.params.id);
    }
  })();
  res.json({ mensaje: 'Cantidad modificada en venta' });
});

app.post('/api/ventas/:id/agregar-item', (req, res) => {
  db.transaction(() => {
    const { producto_id, cantidad, precio } = req.body;
    const v = db.prepare('SELECT * FROM ventas WHERE id = ?').get(req.params.id);
    const esPedido = db.prepare('SELECT id FROM pedidos WHERE venta_id = ?').get(req.params.id);
    if (esPedido) throw new Error('Esta venta pertenece a un Pedido. Debe modificarse desde la sección Pedidos Logística.');

    db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(cantidad, producto_id);
    revertirDevolucion(v.id, null, producto_id, cantidad);

    const existente = db.prepare('SELECT * FROM detalle_ventas WHERE venta_id = ? AND producto_id = ?').get(req.params.id, producto_id);
    if (existente) {
      db.prepare('UPDATE detalle_ventas SET cantidad = cantidad + ? WHERE id = ?').run(cantidad, existente.id);
    } else {
      const cost = db.prepare('SELECT costo FROM productos WHERE id = ?').get(producto_id)?.costo || 0;
      db.prepare('INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)').run(req.params.id, producto_id, cantidad, precio, cost);
    }

    const nuevosItems = db.prepare('SELECT * FROM detalle_ventas WHERE venta_id = ?').all(req.params.id);
    const nuevoSubtotal = nuevosItems.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
    const nuevoTotal = Math.max(0, nuevoSubtotal - v.descuento);
    db.prepare('UPDATE ventas SET subtotal = ?, total = ? WHERE id = ?').run(nuevoSubtotal, nuevoTotal, req.params.id);
  })();
  res.json({ mensaje: 'Ítem agregado a venta' });
});

app.post('/api/ventas/:id/devolver-total', (req, res) => {
  db.transaction(() => {
    const { metodo_reembolso } = req.body;
    const v = db.prepare('SELECT * FROM ventas WHERE id = ?').get(req.params.id);
    if (!v) return;
    const esPedido = db.prepare('SELECT id FROM pedidos WHERE venta_id = ?').get(req.params.id);
    if (esPedido) throw new Error('Esta venta pertenece a un Pedido. Debe modificarse desde la sección Pedidos Logística.');

    const items = db.prepare('SELECT dv.*, p.nombre, p.imagen FROM detalle_ventas dv JOIN productos p ON p.id = dv.producto_id WHERE dv.venta_id = ?').all(v.id);
    const updStock = db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?');
    const insDev = db.prepare('INSERT INTO historial_devoluciones (venta_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const metReembolsoStr = formatMetodoReembolso(metodo_reembolso);
    
    for (const i of items) {
      updStock.run(i.cantidad, i.producto_id);
      insDev.run(v.id, i.producto_id, i.nombre, i.imagen, i.cantidad, i.precio_unitario, i.cantidad * i.precio_unitario, `Venta - ${v.cliente_nombre}`, metReembolsoStr);
    }
    
    db.prepare('DELETE FROM detalle_ventas WHERE venta_id = ?').run(v.id);
    db.prepare('DELETE FROM ventas WHERE id = ?').run(v.id);
  })();
  res.json({ mensaje: 'Venta cancelada totalmente' });
});

// HISTORIAL DE DEVOLUCIONES UNIFICADO POR TRANSACCION
app.get('/api/devoluciones', (req, res) => {
  res.json(db.prepare(`
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
  `).all());
});

// --- EGRESOS ---
app.get('/api/egresos', (req, res) => res.json(db.prepare("SELECT * FROM egresos WHERE tipo = 'gasto' ORDER BY fecha DESC").all()));
app.post('/api/egresos', (req, res) => { 
  db.prepare('INSERT INTO egresos (categoria, concepto, monto, metodo_pago, tipo) VALUES (?, ?, ?, ?, ?)').run(req.body.categoria, req.body.concepto, req.body.monto, req.body.metodo_pago, 'gasto'); 
  res.json({ mensaje: 'Egreso guardado' }); 
});
app.put('/api/egresos/:id', (req, res) => {
  db.prepare('UPDATE egresos SET concepto = ?, monto = ?, categoria = ?, metodo_pago = ? WHERE id = ?').run(req.body.concepto, req.body.monto, req.body.categoria, req.body.metodo_pago, req.params.id);
  res.json({ mensaje: 'Egreso actualizado' });
});
app.delete('/api/egresos/:id', (req, res) => { db.prepare('DELETE FROM egresos WHERE id = ?').run(req.params.id); res.json({ mensaje: 'Egreso eliminado' }); });

// --- PEDIDOS Y LOGÍSTICA ---
app.get('/api/pedidos', (req, res) => res.json(db.prepare("SELECT * FROM pedidos ORDER BY fecha DESC").all()));
app.get('/api/pedidos/:id/detalles', (req, res) => {
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  const items = db.prepare(`SELECT dp.*, p.nombre, p.imagen FROM detalle_pedidos dp JOIN productos p ON p.id = dp.producto_id WHERE dp.pedido_id = ?`).all(req.params.id);
  res.json({ pedido: p, items });
});

app.post('/api/pedidos', (req, res) => {
  const { codigo_pedido, cliente, tel, dni, subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia, localidad, codigo_postal, tipo_direccion, direccion_domicilio, transporte, tracking, uber_pago, uber_costo, uber_metodo, items, sobre_stock } = req.body;
  const estadoInicial = saldo_pendiente > 0 ? 'falta_saldar' : 'a_preparar';
  const obs = sobre_stock ? 'Falta cubrir Stock' : '';
  
  db.transaction(() => {
    const p = db.prepare(`
      INSERT INTO pedidos (codigo_pedido, cliente_nombre, cliente_telefono, cliente_dni, subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia, localidad, codigo_postal, tipo_direccion, direccion_domicilio, transporte, tracking, estado, observacion) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(codigo_pedido||'', cliente, tel||'', dni||'', subtotal, descuento, base_sena, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, tipo_entrega, provincia||'', localidad||'', codigo_postal||'', tipo_direccion||'sucursal', direccion_domicilio||'', transporte||'', tracking||'', estadoInicial, obs);
    
    const pedId = p.lastInsertRowid;

    if (tipo_entrega === 'salta' && uber_pago === 'pagado') {
      db.prepare('INSERT INTO egresos (categoria, concepto, monto, metodo_pago, tipo) VALUES (?, ?, ?, ?, ?)').run('Logística y Fletes', `Flete Uber (Pedido: ${cliente})`, uber_costo || 0, uber_metodo || 'efectivo', 'gasto');
    }
    const ins = db.prepare('INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)');
    const upd = db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?');
    for (const i of items) {
      upd.run(i.cantidad, i.producto_id);
      ins.run(pedId, i.producto_id, i.cantidad, i.precio);
    }

    if (saldo_pendiente === 0) {
      registrarVentaDesdePedido(pedId);
    }
  })();
  res.json({ mensaje: 'Pedido registrado' });
});

app.post('/api/pedidos/:id/saldar', (req, res) => {
  const { pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total_cobrado } = req.body;
  db.transaction(() => {
    const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
    const ef = (p.sena_efectivo||0) + (pago_efectivo||0);
    const ta = (p.sena_tarjeta||0) + (pago_tarjeta||0);
    const tr = (p.sena_transferencia||0) + (pago_transferencia||0);
    const qr = (p.sena_qr||0) + (pago_qr||0);
    
    const nuevaBaseSena = Math.max(0, p.subtotal - p.descuento);

    db.prepare("UPDATE pedidos SET base_sena = ?, sena_efectivo = ?, sena_tarjeta = ?, sena_transferencia = ?, sena_qr = ?, saldo_pendiente = 0 WHERE id = ?").run(nuevaBaseSena, ef, ta, tr, qr, p.id);
    
    registrarVentaDesdePedido(p.id);

    const nuevoEstado = p.estado === 'enviado' ? 'enviado' : 'a_preparar';
    db.prepare("UPDATE pedidos SET estado = ? WHERE id = ?").run(nuevoEstado, p.id);
  })();
  res.json({ mensaje: 'Saldado' });
});

app.put('/api/pedidos/:id/estado', (req, res) => {
  const { estado, tracking } = req.body;
  db.transaction(() => {
    if(tracking !== undefined) db.prepare('UPDATE pedidos SET estado = ?, tracking = ? WHERE id = ?').run(estado, tracking, req.params.id);
    else db.prepare('UPDATE pedidos SET estado = ? WHERE id = ?').run(estado, req.params.id);

    if (estado === 'enviado' || estado === 'a_preparar' || estado === 'listo_para_enviar') {
      registrarVentaDesdePedido(req.params.id);
    }
  })();
  res.json({ mensaje: 'Estado Actualizado' });
});

// GENERACIÓN AUTOMÁTICA DE GUÍA VÍA CARGO EN WORD (.doc/.docx)
app.get('/api/pedidos/:id/guia-viacargo', (req, res) => {
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Pedido no encontrado');
  const items = db.prepare(`SELECT dp.*, prod.nombre FROM detalle_pedidos dp JOIN productos prod ON prod.id = dp.producto_id WHERE dp.pedido_id = ?`).all(p.id);

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
            ${items.map(i => `<tr><td>${i.nombre}</td><td>${i.cantidad} u.</td></tr>`).join('')}
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

app.delete('/api/pedidos/:id', (req, res) => {
  db.transaction(() => {
    const { metodo_reembolso } = req.body || {};
    const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
    if (!p) return;
    
    if (p.venta_id) {
       db.prepare('DELETE FROM detalle_ventas WHERE venta_id = ?').run(p.venta_id);
       db.prepare('DELETE FROM ventas WHERE id = ?').run(p.venta_id);
    }

    const detalles = db.prepare('SELECT dp.*, prod.nombre, prod.imagen FROM detalle_pedidos dp JOIN productos prod ON prod.id = dp.producto_id WHERE dp.pedido_id = ?').all(p.id);
    const updStock = db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?');
    for (const d of detalles) {
      updStock.run(d.cantidad, d.producto_id);
    }

    const totalSenaPagada = (p.sena_efectivo||0) + (p.sena_tarjeta||0) + (p.sena_transferencia||0) + (p.sena_qr||0);

    if (p.estado === 'enviado') {
      const origenD = `Pedido - ${p.cliente_nombre}`;
      const metStr = formatMetodoReembolso(metodo_reembolso);
      const insDev = db.prepare('INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const d of detalles) {
        insDev.run(p.id, d.producto_id, d.nombre, d.imagen, d.cantidad, d.precio_unitario, d.cantidad * d.precio_unitario, origenD, metStr);
      }
    } else if (totalSenaPagada > 0) {
      const origenD = `Pedido Cancelado - ${p.cliente_nombre}`;
      const metStr = formatMetodoReembolso(metodo_reembolso);
      db.prepare('INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(p.id, null, 'Pedido: Cancelado Totalmente', '', 1, totalSenaPagada, totalSenaPagada, origenD, metStr);
    }

    db.prepare('DELETE FROM pedidos WHERE id = ?').run(p.id);
  })();
  res.json({ mensaje: 'Pedido cancelado' });
});

app.post('/api/pedidos/:id/modificar-cantidad', (req, res) => {
  db.transaction(() => {
    const { detalle_id, nueva_cantidad, metodo_reembolso } = req.body;
    const det = db.prepare('SELECT dp.*, p.nombre, p.imagen, ped.cliente_nombre, ped.venta_id, ped.estado, ped.sena_efectivo, ped.sena_tarjeta, ped.sena_transferencia, ped.sena_qr, ped.base_sena, ped.subtotal, ped.descuento FROM detalle_pedidos dp JOIN productos p ON p.id = dp.producto_id JOIN pedidos ped ON ped.id = dp.pedido_id WHERE dp.id = ?').get(detalle_id);
    if (!det || nueva_cantidad < 0) return;

    const diff = nueva_cantidad - det.cantidad;
    if (diff > 0) {
      db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(diff, det.producto_id);
      revertirDevolucion(null, req.params.id, det.producto_id, diff);
    } else if (diff < 0) {
      const cantDev = Math.abs(diff);
      db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(cantDev, det.producto_id);
      
      if (det.estado === 'enviado') {
        const devMonto = cantDev * det.precio_unitario;
        const metStr = formatMetodoReembolso(metodo_reembolso);
        db.prepare('INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.params.id, det.producto_id, det.nombre, det.imagen, cantDev, det.precio_unitario, devMonto, `Pedido - ${det.cliente_nombre}`, metStr);
      }
    }

    if (nueva_cantidad === 0) {
      db.prepare('DELETE FROM detalle_pedidos WHERE id = ?').run(det.id);
    } else {
      db.prepare('UPDATE detalle_pedidos SET cantidad = ? WHERE id = ?').run(nueva_cantidad, det.id);
    }

    if (det.venta_id) {
      const detV = db.prepare('SELECT id FROM detalle_ventas WHERE venta_id = ? AND producto_id = ?').get(det.venta_id, det.producto_id);
      if (detV) {
        if (nueva_cantidad === 0) db.prepare('DELETE FROM detalle_ventas WHERE id = ?').run(detV.id);
        else db.prepare('UPDATE detalle_ventas SET cantidad = ? WHERE id = ?').run(nueva_cantidad, detV.id);
      }
      const nuevosDetV = db.prepare('SELECT * FROM detalle_ventas WHERE venta_id = ?').all(det.venta_id);
      if (nuevosDetV.length === 0) {
        db.prepare('DELETE FROM ventas WHERE id = ?').run(det.venta_id);
      } else {
        const nuevoSubV = nuevosDetV.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
        const vOriginal = db.prepare('SELECT descuento FROM ventas WHERE id = ?').get(det.venta_id);
        db.prepare('UPDATE ventas SET subtotal = ?, total = ? WHERE id = ?').run(nuevoSubV, Math.max(0, nuevoSubV - vOriginal.descuento), det.venta_id);
      }
    }

    const nuevosDet = db.prepare('SELECT * FROM detalle_pedidos WHERE pedido_id = ?').all(req.params.id);
    if (nuevosDet.length === 0) {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      const totalSenaPagada = (ped.sena_efectivo||0) + (ped.sena_tarjeta||0) + (ped.sena_transferencia||0) + (ped.sena_qr||0);
      if (totalSenaPagada > 0) {
        const metStr = formatMetodoReembolso(metodo_reembolso);
        db.prepare('INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.params.id, null, 'Pedido Cancelado Totalmente', '', 1, totalSenaPagada, totalSenaPagada, `Pedido Cancelado - ${ped.cliente_nombre}`, metStr);
      }
      if (ped.venta_id) db.prepare('DELETE FROM ventas WHERE id = ?').run(ped.venta_id);
      db.prepare('DELETE FROM pedidos WHERE id = ?').run(req.params.id);
    } else {
      const nuevoSub = nuevosDet.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      const totalPedidoNuevo = Math.max(0, nuevoSub - ped.descuento);

      let baseSenaActual = ped.base_sena || 0;
      let nuevoSaldo = totalPedidoNuevo - baseSenaActual;

      if (ped.estado !== 'enviado' && nuevoSaldo < 0) {
        const excedenteBase = Math.abs(nuevoSaldo);
        const metStr = formatMetodoReembolso(metodo_reembolso);
        db.prepare('INSERT INTO historial_devoluciones (pedido_id, producto_id, producto_nombre, producto_imagen, cantidad, precio_unitario, monto_devuelto, origen, detalle_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.params.id, null, 'Excedente de Seña Reintegrado', '', 1, excedenteBase, excedenteBase, `Pedido - ${ped.cliente_nombre}`, metStr);

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
        db.prepare('UPDATE pedidos SET base_sena = ?, sena_efectivo = ?, sena_transferencia = ?, sena_tarjeta = ?, sena_qr = ? WHERE id = ?').run(baseSenaActual, ef, tr, ta, qr, req.params.id);
        nuevoSaldo = 0;
      }

      let estadoConservado = ped.estado;
      if (ped.estado !== 'enviado' && ped.estado !== 'listo_para_enviar') {
        estadoConservado = nuevoSaldo > 0 ? 'falta_saldar' : 'a_preparar';
      }
      db.prepare('UPDATE pedidos SET subtotal = ?, base_sena = ?, saldo_pendiente = ?, estado = ? WHERE id = ?').run(nuevoSub, baseSenaActual, Math.max(0, nuevoSaldo), estadoConservado, req.params.id);
    }
  })();
  res.json({ mensaje: 'Cantidad de pedido modificada' });
});

app.post('/api/pedidos/:id/agregar-item', (req, res) => {
  db.transaction(() => {
    const { producto_id, cantidad, precio } = req.body;
    const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
    if (!ped) return;

    db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(cantidad, producto_id);
    revertirDevolucion(null, req.params.id, producto_id, cantidad);

    const existente = db.prepare('SELECT * FROM detalle_pedidos WHERE pedido_id = ? AND producto_id = ?').get(req.params.id, producto_id);
    if (existente) {
      db.prepare('UPDATE detalle_pedidos SET cantidad = cantidad + ? WHERE id = ?').run(cantidad, existente.id);
    } else {
      db.prepare('INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)').run(req.params.id, producto_id, cantidad, precio);
    }

    if (ped.venta_id) {
      const existV = db.prepare('SELECT * FROM detalle_ventas WHERE venta_id = ? AND producto_id = ?').get(ped.venta_id, producto_id);
      if (existV) {
        db.prepare('UPDATE detalle_ventas SET cantidad = cantidad + ? WHERE id = ?').run(cantidad, existV.id);
      } else {
        const cost = db.prepare('SELECT costo FROM productos WHERE id = ?').get(producto_id)?.costo || 0;
        db.prepare('INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)').run(ped.venta_id, producto_id, cantidad, precio, cost);
      }
      const nuevosDetV = db.prepare('SELECT * FROM detalle_ventas WHERE venta_id = ?').all(ped.venta_id);
      const nuevoSubV = nuevosDetV.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
      db.prepare('UPDATE ventas SET subtotal = ?, total = ? WHERE id = ?').run(nuevoSubV, Math.max(0, nuevoSubV - ped.descuento), ped.venta_id);
    }

    const nuevosDet = db.prepare('SELECT * FROM detalle_pedidos WHERE pedido_id = ?').all(req.params.id);
    const nuevoSub = nuevosDet.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
    const baseSenaActual = ped.base_sena || 0;
    const nuevoSaldo = nuevoSub - ped.descuento - baseSenaActual;
    
    let estadoConservado = ped.estado;
    if (ped.estado !== 'enviado' && ped.estado !== 'listo_para_enviar') {
      estadoConservado = nuevoSaldo > 0 ? 'falta_saldar' : 'a_preparar';
    }
    db.prepare('UPDATE pedidos SET subtotal = ?, saldo_pendiente = ?, estado = ? WHERE id = ?').run(nuevoSub, Math.max(0, nuevoSaldo), estadoConservado, req.params.id);
  })();
  res.json({ mensaje: 'Item agregado a pedido' });
});

// --- REPORTES ---
app.get('/api/reportes/dashboard', (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0,7);
  const v = db.prepare("SELECT SUM(total) as t FROM ventas WHERE strftime('%Y-%m', fecha) = ?").get(mes).t || 0;
  const c = db.prepare("SELECT SUM(dv.cantidad * dv.costo_unitario) as c FROM detalle_ventas dv JOIN ventas v ON v.id = dv.venta_id WHERE strftime('%Y-%m', v.fecha) = ?").get(mes).c || 0;
  const g = db.prepare("SELECT SUM(monto) as m FROM egresos WHERE strftime('%Y-%m', fecha) = ? AND tipo = 'gasto'").get(mes).m || 0;
  const prods = db.prepare("SELECT p.nombre, SUM(dv.cantidad) as cant FROM detalle_ventas dv JOIN ventas v ON v.id=dv.venta_id JOIN productos p ON p.id=dv.producto_id WHERE strftime('%Y-%m', v.fecha) = ? GROUP BY p.id ORDER BY cant DESC LIMIT 10").all(mes);
  const gas = db.prepare("SELECT categoria, SUM(monto) as m FROM egresos WHERE strftime('%Y-%m', fecha) = ? AND tipo = 'gasto' GROUP BY categoria ORDER BY m DESC LIMIT 10").all(mes);
  const ev = db.prepare(`SELECT strftime('%d', fecha) as d, SUM(total) as i, 0 as g FROM ventas WHERE strftime('%Y-%m', fecha) = ? GROUP BY d UNION ALL SELECT strftime('%d', fecha) as d, 0 as i, SUM(monto) as g FROM egresos WHERE strftime('%Y-%m', fecha) = ? AND tipo = 'gasto' GROUP BY d`).all(mes, mes);
  res.json({ pl: { ventas: v, cogs: c, gastos: g, neta: v - c - g }, prods, gas, ev });
});

app.get('/api/backup', (req, res) => res.download(path.join(__dirname, 'pos.db'), `backup-${Date.now()}.db`));
app.listen(process.env.PORT || 3000, () => console.log('Servidor listo'));