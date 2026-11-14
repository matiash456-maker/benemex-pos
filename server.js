const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const db = require('./database.js');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ==========================================
// MÓDULO: CAJA Y TURNOS
// ==========================================
app.get('/api/caja/estado', async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM caja_turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
    if (rows.length > 0) res.json({ estado: 'abierta', personal: rows[0].personal_cargo, id: rows[0].id });
    else res.json({ estado: 'cerrada' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/caja/abrir', async (req, res) => {
  try {
    const { monto_inicial, personal } = req.body;
    await db.query("INSERT INTO caja_turnos (personal_cargo, monto_inicial, fecha_apertura) VALUES (?, ?, CURRENT_TIMESTAMP)", [personal, monto_inicial]);
    res.json({ message: 'Caja abierta' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/caja/pre-cierre', async (req, res) => {
  try {
    const turnos = await db.query("SELECT * FROM caja_turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
    if (turnos.length === 0) return res.status(400).json({ error: 'No hay caja abierta' });
    const turno = turnos[0];

    const ventas = await db.query("SELECT SUM(pago_efectivo) as total FROM ventas WHERE caja_turno_id = ? AND devuelta = 0", [turno.id]);
    const senas = await db.query("SELECT SUM(sena_efectivo) as total FROM pedidos WHERE caja_turno_id = ? AND estado != 'cancelado'", [turno.id]);
    const saldos = await db.query("SELECT SUM(monto_efectivo) as total FROM pagos_pedidos WHERE caja_turno_id = ?", [turno.id]);
    const egresos = await db.query("SELECT SUM(monto) as total FROM egresos WHERE caja_turno_id = ? AND metodo_pago = 'efectivo'", [turno.id]);

    const esperado = turno.monto_inicial + (ventas[0].total || 0) + (senas[0].total || 0) + (saldos[0].total || 0) - (egresos[0].total || 0);
    res.json({ esperado });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/caja/cerrar', async (req, res) => {
  try {
    const { monto_final, esperado } = req.body;
    const turnos = await db.query("SELECT id FROM caja_turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
    if (turnos.length === 0) return res.status(400).json({ error: 'No hay caja abierta' });
    
    const diferencia = monto_final - esperado;
    await db.query("UPDATE caja_turnos SET monto_final = ?, diferencia = ?, estado = 'cerrada', fecha_cierre = CURRENT_TIMESTAMP WHERE id = ?", [monto_final, diferencia, turnos[0].id]);
    res.json({ message: 'Caja cerrada' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/caja/historial', async (req, res) => {
  try {
    const { fecha } = req.query;
    let query = "SELECT * FROM caja_turnos WHERE estado = 'cerrada'";
    let params = [];

    if (fecha) {
      if (fecha.length === 10) { query += " AND date(fecha_cierre) = ?"; params.push(fecha); }
      else if (fecha.length === 7) { query += " AND strftime('%Y-%m', fecha_cierre) = ?"; params.push(fecha); }
      else if (fecha.length === 4) { query += " AND strftime('%Y', fecha_cierre) = ?"; params.push(fecha); }
    }
    query += " ORDER BY id DESC";
    
    const rows = await db.query(query, params);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// MÓDULO: PRODUCTOS (INVENTARIO)
// ==========================================
app.get('/api/productos', async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM productos ORDER BY nombre ASC");
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/productos/buscar', async (req, res) => {
  try {
    const { q, categoria } = req.query;
    let query = "SELECT * FROM productos WHERE (nombre LIKE ? OR codigo_barras LIKE ?)";
    let params = [`%${q}%`, `%${q}%`];
    
    if (categoria) {
      query += " AND categoria = ?";
      params.push(categoria);
    }
    
    query += " ORDER BY nombre ASC LIMIT 15";
    const rows = await db.query(query, params);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/productos', async (req, res) => {
  try {
    const { codigo_barras, nombre, categoria, costo, precio, stock, imagen } = req.body;
    const result = await db.query("INSERT INTO productos (codigo_barras, nombre, categoria, costo, precio, stock, imagen) VALUES (?, ?, ?, ?, ?, ?, ?)", [codigo_barras, nombre, categoria, costo, precio, stock, imagen]);
    await db.query("INSERT INTO historial_stock (producto_id, variacion, tipo, detalle) VALUES (?, ?, 'Alta / Creación', 'Producto nuevo creado en sistema')", [result.insertId, stock]);
    res.json({ id: result.insertId });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/productos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { codigo_barras, nombre, categoria, costo, precio, stock, imagen } = req.body;
    
    const prodOld = await db.query("SELECT stock FROM productos WHERE id = ?", [id]);
    const dif = stock - (prodOld[0].stock || 0);

    await db.query("UPDATE productos SET codigo_barras=?, nombre=?, categoria=?, costo=?, precio=?, stock=?, imagen=? WHERE id=?", [codigo_barras, nombre, categoria, costo, precio, stock, imagen, id]);
    
    if (dif !== 0) {
      await db.query("INSERT INTO historial_stock (producto_id, variacion, tipo, detalle) VALUES (?, ?, 'Edición Manual', 'Edición desde formulario')", [id, dif]);
    }
    res.json({ message: 'Actualizado' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/productos/:id', async (req, res) => {
  try {
    await db.query("DELETE FROM productos WHERE id=?", [req.params.id]);
    res.json({ message: 'Eliminado' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/productos/reingreso', async (req, res) => {
  try {
    const { producto_id, cantidad, detalle } = req.body;
    await db.query("UPDATE productos SET stock = stock + ? WHERE id = ?", [cantidad, producto_id]);
    await db.query("INSERT INTO historial_stock (producto_id, variacion, tipo, detalle) VALUES (?, ?, 'Reingreso de Stock', ?)", [producto_id, cantidad, detalle || 'Ingreso directo']);
    res.json({ message: 'Stock actualizado' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/productos/reingresos/historial', async (req, res) => {
  try {
    const { categoria, producto_id, fecha_desde, fecha_hasta } = req.query;
    let query = `
      SELECT h.*, p.nombre as producto_nombre, p.categoria 
      FROM historial_stock h 
      JOIN productos p ON h.producto_id = p.id 
      WHERE 1=1
    `;
    let params = [];

    if (categoria) { query += " AND p.categoria = ?"; params.push(categoria); }
    if (producto_id) { query += " AND p.producto_id = ?"; params.push(producto_id); }
    if (fecha_desde) { query += " AND date(h.fecha) >= ?"; params.push(fecha_desde); }
    if (fecha_hasta) { query += " AND date(h.fecha) <= ?"; params.push(fecha_hasta); }

    query += " ORDER BY h.id DESC LIMIT 200";
    const rows = await db.query(query, params);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// MÓDULO: EGRESOS
// ==========================================
app.get('/api/egresos', async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM egresos ORDER BY id DESC LIMIT 100");
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/egresos', async (req, res) => {
  try {
    const { categoria, concepto, monto, metodo_pago } = req.body;
    const turno = await db.query("SELECT id FROM caja_turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
    const turno_id = turno.length > 0 ? turno[0].id : null;
    
    await db.query("INSERT INTO egresos (caja_turno_id, categoria, concepto, monto, metodo_pago) VALUES (?, ?, ?, ?, ?)", [turno_id, categoria, concepto, monto, metodo_pago]);
    res.json({ message: 'Registrado' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/egresos/:id', async (req, res) => {
  try {
    const { categoria, concepto, monto, metodo_pago } = req.body;
    await db.query("UPDATE egresos SET categoria=?, concepto=?, monto=?, metodo_pago=? WHERE id=?", [categoria, concepto, monto, metodo_pago, req.params.id]);
    res.json({ message: 'Actualizado' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/egresos/:id', async (req, res) => {
  try {
    await db.query("DELETE FROM egresos WHERE id=?", [req.params.id]);
    res.json({ message: 'Eliminado' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// MÓDULO: COMISIONADOS
// ==========================================
app.get('/api/comisionados', async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM comisionados ORDER BY nombre ASC");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comisionados', async (req, res) => {
  try {
    const { nombre, porcentaje, datos } = req.body;
    await db.query("INSERT INTO comisionados (nombre, porcentaje, datos) VALUES (?, ?, ?)", [nombre, porcentaje, datos]);
    res.json({ message: 'Comisionado creado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/comisionados/:id', async (req, res) => {
  try {
    const { nombre, porcentaje, datos } = req.body;
    await db.query("UPDATE comisionados SET nombre = ?, porcentaje = ?, datos = ? WHERE id = ?", [nombre, porcentaje, datos, req.params.id]);
    res.json({ message: 'Comisionado actualizado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comisionados/:id', async (req, res) => {
  try {
    await db.query("DELETE FROM comisionados WHERE id = ?", [req.params.id]);
    res.json({ message: 'Comisionado eliminado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/comisiones/ventas', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT 
        v.id as venta_id, v.fecha, v.codigo_pedido, 
        c.id as comisionado_id, c.nombre as comisionado_nombre,
        p.nombre as producto_nombre,
        dv.precio_unitario as precio_venta, pr.costo as costo_unitario,
        dv.porcentaje_comision as porcentaje_aplicado,
        dv.monto_comision
      FROM detalle_ventas dv
      JOIN ventas v ON dv.venta_id = v.id
      JOIN comisionados c ON v.comisionado_id = c.id
      JOIN productos pr ON dv.producto_id = pr.id
      WHERE dv.monto_comision > 0 AND v.devuelta = 0
      ORDER BY v.fecha DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/comisiones/pagos', async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM comisiones_pagos ORDER BY fecha DESC");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comisiones/pagos', async (req, res) => {
  try {
    const { comisionado_id, monto, metodo_pago, tipo } = req.body;
    await db.query("INSERT INTO comisiones_pagos (comisionado_id, monto, metodo_pago, tipo) VALUES (?, ?, ?, ?)", [comisionado_id, monto, metodo_pago, tipo]);
    res.json({ message: 'Pago registrado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comisiones/pagos/:id', async (req, res) => {
  try {
    await db.query("DELETE FROM comisiones_pagos WHERE id = ?", [req.params.id]);
    res.json({ message: 'Pago anulado. El monto ha retornado a la deuda.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// MÓDULO: DEVOLUCIONES
// ==========================================
app.get('/api/devoluciones', async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM historial_devoluciones ORDER BY id DESC LIMIT 100");
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// MÓDULO: VENTAS Y DETALLES
// ==========================================
app.get('/api/ventas', async (req, res) => {
  try {
    const rows = await db.query("SELECT v.*, GROUP_CONCAT(p.nombre, ' | ') as items FROM ventas v LEFT JOIN detalle_ventas dv ON v.id = dv.venta_id LEFT JOIN productos p ON dv.producto_id = p.id GROUP BY v.id ORDER BY v.id DESC LIMIT 100");
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/ventas', async (req, res) => {
  try {
    const { cliente_nombre, comisionado_id, items, subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total } = req.body;
    const turno = await db.query("SELECT id FROM caja_turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
    const caja_id = turno.length > 0 ? turno[0].id : null;

    const resVenta = await db.query(
      "INSERT INTO ventas (caja_turno_id, cliente_nombre, comisionado_id, subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [caja_id, cliente_nombre, comisionado_id || null, subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total]
    );
    const vId = resVenta.insertId;

    let porcentajeComision = 0;
    if (comisionado_id) {
      const comData = await db.query("SELECT porcentaje FROM comisionados WHERE id = ?", [comisionado_id]);
      if(comData.length > 0) porcentajeComision = comData[0].porcentaje;
    }

    for (let item of items) {
      const prod = await db.query("SELECT costo FROM productos WHERE id = ?", [item.producto_id]);
      const costoU = prod.length > 0 ? prod[0].costo : 0;
      
      let montoCom = 0;
      if (porcentajeComision > 0) {
        const gananciaBruta = item.precio - costoU;
        if (gananciaBruta > 0) montoCom = gananciaBruta * (porcentajeComision / 100);
      }

      await db.query("INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario, porcentaje_comision, monto_comision) VALUES (?, ?, ?, ?, ?, ?, ?)", [vId, item.producto_id, item.cantidad, item.precio, costoU, porcentajeComision, (montoCom * item.cantidad)]);
      await db.query("UPDATE productos SET stock = stock - ? WHERE id = ?", [item.cantidad, item.producto_id]);
    }
    res.json({ message: 'Venta completada', venta_id: vId });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/ventas/:id/detalles', async (req, res) => {
  try {
    const { id } = req.params;
    const venta = await db.query("SELECT * FROM ventas WHERE id = ?", [id]);
    if (venta.length === 0) return res.status(404).json({ error: 'Venta no encontrada' });
    
    const items = await db.query(`
      SELECT dv.*, p.nombre, p.imagen, p.codigo_barras 
      FROM detalle_ventas dv 
      JOIN productos p ON dv.producto_id = p.id 
      WHERE dv.venta_id = ?
    `, [id]);
    
    res.json({ venta: venta[0], items, es_pedido: venta[0].codigo_pedido != null });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/ventas/:id/devolver-total', async (req, res) => {
  try {
    const { id } = req.params;
    const { metodo_reembolso } = req.body;
    
    const vCheck = await db.query("SELECT devuelta, total, cliente_nombre, codigo_pedido FROM ventas WHERE id = ?", [id]);
    if(vCheck.length === 0) return res.status(404).json({ error: 'Venta no encontrada' });
    if(vCheck[0].devuelta === 1) return res.status(400).json({ error: 'Venta ya devuelta' });
    if(vCheck[0].codigo_pedido != null) return res.status(400).json({ error: 'Proviene de pedido, anular desde logística' });

    const items = await db.query("SELECT producto_id, cantidad FROM detalle_ventas WHERE venta_id = ?", [id]);
    let detalleTxt = [];
    for(let i of items) {
      await db.query("UPDATE productos SET stock = stock + ? WHERE id = ?", [i.cantidad, i.producto_id]);
      const p = await db.query("SELECT nombre FROM productos WHERE id = ?", [i.producto_id]);
      if(p.length > 0) detalleTxt.push(`${i.cantidad}x ${p[0].nombre}`);
    }

    await db.query("UPDATE ventas SET devuelta = 1 WHERE id = ?", [id]);
    await db.query("INSERT INTO historial_devoluciones (origen, origen_id, detalles, total_monto, detalle_pago) VALUES (?, ?, ?, ?, ?)", ['Venta Directa', id, detalleTxt.join(', '), vCheck[0].total, `Reembolsado en ${metodo_reembolso || 'Efectivo'}`]);
    
    res.json({ message: 'Venta devuelta' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// MÓDULO: PEDIDOS LOGÍSTICA
// ==========================================
app.get('/api/pedidos', async (req, res) => {
  try {
    const rows = await db.query("SELECT p.*, GROUP_CONCAT(pr.nombre, ' | ') as items FROM pedidos p LEFT JOIN detalle_pedidos dp ON p.id = dp.pedido_id LEFT JOIN productos pr ON dp.producto_id = pr.id GROUP BY p.id ORDER BY CASE WHEN p.estado = 'falta_saldar' THEN 1 WHEN p.estado = 'a_preparar' THEN 2 WHEN p.estado = 'listo_para_enviar' THEN 3 ELSE 4 END, p.fecha DESC");
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pedidos', async (req, res) => {
  try {
    const d = req.body;
    const turno = await db.query("SELECT id FROM caja_turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
    const caja_id = turno.length > 0 ? turno[0].id : null;

    let obs = d.sobre_stock ? 'Falta cubrir Stock' : null;
    let estado = d.saldo_pendiente > 0.01 ? 'falta_saldar' : 'a_preparar';

    const resPed = await db.query(`
      INSERT INTO pedidos (
        caja_turno_id, codigo_pedido, cliente_nombre, cliente_telefono, cliente_dni, comisionado_id, 
        subtotal, descuento, sena_efectivo, sena_tarjeta, sena_transferencia, sena_qr, saldo_pendiente, 
        tipo_entrega, provincia, localidad, codigo_postal, tipo_direccion, direccion_domicilio, 
        transporte, estado, observacion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      caja_id, d.codigo_pedido, d.cliente, d.tel, d.dni, d.comisionado_id || null, 
      d.subtotal, d.descuento, d.sena_efectivo, d.sena_tarjeta, d.sena_transferencia, d.sena_qr, d.saldo_pendiente, 
      d.tipo_entrega, d.provincia, d.localidad, d.codigo_postal, d.tipo_direccion, d.direccion_domicilio, 
      d.transporte, estado, obs
    ]);
    
    const pId = resPed.insertId;

    for (let item of d.items) {
      await db.query("INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)", [pId, item.producto_id, item.cantidad, item.precio]);
      await db.query("UPDATE productos SET stock = stock - ? WHERE id = ?", [item.cantidad, item.producto_id]);
    }

    if (d.uber_pago === 'pagado' && d.uber_costo > 0) {
      await db.query("INSERT INTO egresos (caja_turno_id, categoria, concepto, monto, metodo_pago) VALUES (?, 'Logística y Fletes', ?, ?, ?)", [caja_id, `Pago Uber Envío - ${d.cliente}`, d.uber_costo, d.uber_metodo]);
    }

    if (estado === 'a_preparar') {
      const v = await db.query(`
        INSERT INTO ventas (caja_turno_id, cliente_nombre, comisionado_id, subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, codigo_pedido) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [caja_id, d.cliente, d.comisionado_id || null, d.subtotal, d.descuento, d.sena_efectivo, d.sena_tarjeta, d.sena_transferencia, d.sena_qr, (d.sena_efectivo + d.sena_tarjeta + d.sena_transferencia + d.sena_qr), d.codigo_pedido]);
      
      let porcentajeComision = 0;
      if (d.comisionado_id) {
        const comData = await db.query("SELECT porcentaje FROM comisionados WHERE id = ?", [d.comisionado_id]);
        if(comData.length > 0) porcentajeComision = comData[0].porcentaje;
      }

      for (let item of d.items) {
        const prod = await db.query("SELECT costo FROM productos WHERE id = ?", [item.producto_id]);
        const costoU = prod.length > 0 ? prod[0].costo : 0;
        let montoCom = 0;
        if (porcentajeComision > 0) {
          const gb = item.precio - costoU;
          if (gb > 0) montoCom = gb * (porcentajeComision / 100);
        }
        await db.query("INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario, porcentaje_comision, monto_comision) VALUES (?, ?, ?, ?, ?, ?, ?)", [v.insertId, item.producto_id, item.cantidad, item.precio, costoU, porcentajeComision, (montoCom * item.cantidad)]);
      }
    }
    res.json({ message: 'Pedido guardado' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/pedidos/:id/detalles', async (req, res) => {
  try {
    const pedido = await db.query("SELECT * FROM pedidos WHERE id = ?", [req.params.id]);
    if (pedido.length === 0) return res.status(404).json({ error: 'No encontrado' });
    const items = await db.query(`
      SELECT dp.*, p.nombre, p.imagen, p.codigo_barras 
      FROM detalle_pedidos dp 
      JOIN productos p ON dp.producto_id = p.id 
      WHERE dp.pedido_id = ?
    `, [req.params.id]);
    res.json({ pedido: pedido[0], items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/pedidos/:id/estado', async (req, res) => {
  try {
    const { estado, tracking } = req.body;
    
    if (estado === 'listo_para_enviar' || estado === 'enviado') {
      const pData = await db.query("SELECT observacion FROM pedidos WHERE id = ?", [req.params.id]);
      if (pData.length > 0 && pData[0].observacion && pData[0].observacion.includes('Falta cubrir Stock')) {
        
        const items = await db.query(`
          SELECT p.nombre, p.codigo_barras, p.stock 
          FROM detalle_pedidos dp 
          JOIN productos p ON dp.producto_id = p.id 
          WHERE dp.pedido_id = ? AND p.stock < 0
        `, [req.params.id]);

        if (items.length > 0) {
          const lista = items.map(i => `• [${i.codigo_barras}] ${i.nombre} (Faltan: ${Math.abs(i.stock)})`).join('\n');
          return res.status(400).json({ 
            error: `NO SE PUEDE AVANZAR EL ESTADO. Hay productos sin stock en este pedido:\n\n${lista}\n\nDebes reingresar stock o modificar el pedido primero.` 
          });
        } else {
          await db.query("UPDATE pedidos SET observacion = NULL WHERE id = ?", [req.params.id]);
        }
      }
    }

    await db.query("UPDATE pedidos SET estado = ?, tracking = ? WHERE id = ?", [estado, tracking, req.params.id]);
    res.json({ message: 'Estado modificado' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pedidos/:id/saldar', async (req, res) => {
  try {
    const { pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total_cobrado } = req.body;
    const { id } = req.params;
    
    const turno = await db.query("SELECT id FROM caja_turnos WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
    const caja_id = turno.length > 0 ? turno[0].id : null;

    const p = await db.query("SELECT * FROM pedidos WHERE id = ?", [id]);
    if(p.length === 0) return res.status(404).json({ error: 'Pedido no existe' });
    
    await db.query("INSERT INTO pagos_pedidos (pedido_id, caja_turno_id, monto_efectivo, monto_tarjeta, monto_transferencia, monto_qr) VALUES (?, ?, ?, ?, ?, ?)", [id, caja_id, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr]);
    await db.query("UPDATE pedidos SET saldo_pendiente = 0, estado = 'a_preparar' WHERE id = ?", [id]);

    const d = p[0];
    const items = await db.query("SELECT * FROM detalle_pedidos WHERE pedido_id = ?", [id]);
    
    const totalEf = d.sena_efectivo + pago_efectivo;
    const totalTa = d.sena_tarjeta + pago_tarjeta;
    const totalTr = d.sena_transferencia + pago_transferencia;
    const totalQr = d.sena_qr + pago_qr;
    const totFinal = totalEf + totalTa + totalTr + totalQr;

    const v = await db.query(`
      INSERT INTO ventas (caja_turno_id, cliente_nombre, comisionado_id, subtotal, descuento, pago_efectivo, pago_tarjeta, pago_transferencia, pago_qr, total, codigo_pedido) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [caja_id, d.cliente_nombre, d.comisionado_id, d.subtotal, d.descuento, totalEf, totalTa, totalTr, totalQr, totFinal, d.codigo_pedido]);
    
    let porcentajeComision = 0;
    if (d.comisionado_id) {
      const comData = await db.query("SELECT porcentaje FROM comisionados WHERE id = ?", [d.comisionado_id]);
      if(comData.length > 0) porcentajeComision = comData[0].porcentaje;
    }

    for (let i of items) {
      const prod = await db.query("SELECT costo FROM productos WHERE id = ?", [i.producto_id]);
      const costoU = prod.length > 0 ? prod[0].costo : 0;
      let montoCom = 0;
      if (porcentajeComision > 0) {
        const gb = i.precio_unitario - costoU;
        if (gb > 0) montoCom = gb * (porcentajeComision / 100);
      }
      await db.query("INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario, porcentaje_comision, monto_comision) VALUES (?, ?, ?, ?, ?, ?, ?)", [v.insertId, i.producto_id, i.cantidad, i.precio_unitario, costoU, porcentajeComision, (montoCom * i.cantidad)]);
    }

    res.json({ message: 'Pedido saldado y convertido a venta' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/pedidos/:id', async (req, res) => {
  try {
    const { metodo_reembolso } = req.body;
    const pCheck = await db.query("SELECT * FROM pedidos WHERE id = ?", [req.params.id]);
    if(pCheck.length === 0) return res.status(404).json({ error: 'Pedido no hallado' });
    
    const pd = pCheck[0];
    const items = await db.query("SELECT * FROM detalle_pedidos WHERE pedido_id = ?", [req.params.id]);
    let detalleTxt = [];
    
    for(let i of items) {
      await db.query("UPDATE productos SET stock = stock + ? WHERE id = ?", [i.cantidad, i.producto_id]);
      const p = await db.query("SELECT nombre FROM productos WHERE id = ?", [i.producto_id]);
      if(p.length > 0) detalleTxt.push(`${i.cantidad}x ${p[0].nombre}`);
    }

    const mTotal = (pd.sena_efectivo + pd.sena_tarjeta + pd.sena_transferencia + pd.sena_qr);
    const pPagos = await db.query("SELECT SUM(monto_efectivo + monto_tarjeta + monto_transferencia + monto_qr) as pg FROM pagos_pedidos WHERE pedido_id = ?", [req.params.id]);
    const mTotalPagos = pPagos.length > 0 ? (pPagos[0].pg || 0) : 0;
    const devolucionTotal = mTotal + mTotalPagos;

    if(devolucionTotal > 0) {
      await db.query("INSERT INTO historial_devoluciones (origen, origen_id, detalles, total_monto, detalle_pago) VALUES (?, ?, ?, ?, ?)", ['Pedido Cancelado', req.params.id, detalleTxt.join(', '), devolucionTotal, `Reembolso en ${metodo_reembolso || 'Efectivo'}`]);
    }

    if (pd.estado !== 'falta_saldar') {
      await db.query("UPDATE ventas SET devuelta = 1 WHERE codigo_pedido = ?", [pd.codigo_pedido]);
    }

    await db.query("UPDATE pedidos SET estado = 'cancelado' WHERE id = ?", [req.params.id]);
    res.json({ message: 'Pedido cancelado, unidades regresadas y venta asociada anulada.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// MÓDULO: REPORTES
// ==========================================
app.get('/api/reportes/dashboard', async (req, res) => {
  try {
    const { mes } = req.query; 
    let fV = "AND strftime('%Y-%m', fecha) = ?", fE = "AND strftime('%Y-%m', fecha) = ?";
    let p = [mes];

    const vTotal = await db.query(`SELECT SUM(total) as t FROM ventas WHERE devuelta = 0 ${fV}`, p);
    const vCosto = await db.query(`
      SELECT SUM(dv.cantidad * (CASE WHEN dv.costo_unitario > 0 THEN dv.costo_unitario ELSE (SELECT costo FROM productos WHERE id = dv.producto_id) END)) as t 
      FROM detalle_ventas dv JOIN ventas v ON dv.venta_id = v.id WHERE v.devuelta = 0 AND strftime('%Y-%m', v.fecha) = ?
    `, p);
    const gTotal = await db.query(`SELECT SUM(monto) as t FROM egresos WHERE 1=1 ${fE}`, p);

    const prods = await db.query(`
      SELECT p.nombre, SUM(dv.cantidad) as cant 
      FROM detalle_ventas dv JOIN ventas v ON dv.venta_id = v.id JOIN productos p ON dv.producto_id = p.id 
      WHERE v.devuelta = 0 AND strftime('%Y-%m', v.fecha) = ? 
      GROUP BY p.id ORDER BY cant DESC LIMIT 5
    `, p);

    const gas = await db.query(`SELECT categoria, SUM(monto) as m FROM egresos WHERE strftime('%Y-%m', fecha) = ? GROUP BY categoria`, p);

    const vDiarias = await db.query(`SELECT strftime('%Y-%m-%d', fecha) as d, SUM(total) as t FROM ventas WHERE devuelta = 0 AND strftime('%Y-%m', fecha) = ? GROUP BY d`, p);
    const gDiarios = await db.query(`SELECT strftime('%Y-%m-%d', fecha) as d, SUM(monto) as t FROM egresos WHERE strftime('%Y-%m', fecha) = ? GROUP BY d`, p);

    let ev = [];
    vDiarias.forEach(v => {
      const eg = gDiarios.find(x => x.d === v.d);
      ev.push({ d: v.d.slice(8,10), i: v.t, g: eg ? eg.t : 0 });
    });

    res.json({
      pl: { ventas: vTotal[0].t || 0, costos: vCosto[0].t || 0, gastos: gTotal[0].t || 0, neta: (vTotal[0].t || 0) - (gTotal[0].t || 0) },
      prods, gas, ev
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/reportes/detallado', async (req, res) => {
  try {
    const { mes, desde, hasta } = req.query;
    let whereVentas = "v.devuelta = 0";
    let whereEgresos = "1=1";
    let params = [];

    if (mes) {
      whereVentas += " AND strftime('%Y-%m', v.fecha) = ?";
      whereEgresos += " AND strftime('%Y-%m', e.fecha) = ?";
      params.push(mes);
    } else if (desde && hasta) {
      whereVentas += " AND date(v.fecha) >= ? AND date(v.fecha) <= ?";
      whereEgresos += " AND date(e.fecha) >= ? AND date(e.fecha) <= ?";
      params.push(desde, hasta);
    }

    const tVentas = await db.query(`SELECT SUM(total) as t FROM ventas v WHERE ${whereVentas}`, params);
    const totalVentas = tVentas[0].t || 0;

    const tEgresos = await db.query(`SELECT SUM(monto) as t FROM egresos e WHERE ${whereEgresos}`, params);
    const totalEgresos = tEgresos[0].t || 0;

    const resultadoOperativo = totalVentas - totalEgresos;

    const queryVentasCat = await db.query(`
      SELECT p.categoria, SUM(dv.cantidad * dv.precio_unitario) as total
      FROM detalle_ventas dv
      JOIN ventas v ON dv.venta_id = v.id
      JOIN productos p ON dv.producto_id = p.id
      WHERE ${whereVentas}
      GROUP BY p.categoria
    `, params);
    const desgloseVentasCat = {};
    queryVentasCat.forEach(row => desgloseVentasCat[row.categoria || 'Sin Categoría'] = row.total);

    const queryGastosCat = await db.query(`
      SELECT categoria, SUM(monto) as total
      FROM egresos e
      WHERE ${whereEgresos}
      GROUP BY categoria
    `, params);
    const desgloseGastosCat = {};
    queryGastosCat.forEach(row => desgloseGastosCat[row.categoria] = row.total);

    const queryProds = await db.query(`
      SELECT p.codigo_barras, p.nombre, p.categoria, SUM(dv.cantidad) as unidades, SUM(dv.cantidad * dv.precio_unitario) as facturado
      FROM detalle_ventas dv
      JOIN ventas v ON dv.venta_id = v.id
      JOIN productos p ON dv.producto_id = p.id
      WHERE ${whereVentas}
      GROUP BY p.id
      ORDER BY facturado DESC
    `, params);
    const desgloseProdsCat = {};
    queryProds.forEach(row => {
      desgloseProdsCat[row.codigo_barras || 'N/A'] = { nombre: row.nombre, categoria: row.categoria, unidades: row.unidades, facturado: row.facturado };
    });

    const topGastos = await db.query(`
      SELECT fecha, categoria, concepto, monto 
      FROM egresos e 
      WHERE ${whereEgresos} 
      ORDER BY monto DESC LIMIT 10
    `, params);

    res.json({
      resumen: {
        totalVentas, totalEgresos, resultadoOperativo,
        desgloseVentasCat, desgloseGastosCat, desgloseProdsCat, topGastos
      }
    });

  } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend POS Benemex corriendo en puerto ${PORT}`);
});
