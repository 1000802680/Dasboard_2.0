import { createDashboardRow, discoverTableNames, getDashboardColumnName, getDashboardFileDownloadLink, getDashboardRow, loadDashboardRecords, refreshForNewTables, searchDashboardRecordsByOPA, updateDashboardRow } from "../_lib/seatable.js";
import { getAuthenticatedUser, recordBusinessAudit } from "../_lib/auth.js";

const ESTADOS = [
  "Concepto Enviado", "Concepto Aprobado", "Pre-Producción Enviada",
  "Pre-Producción Aprobada", "Fotos de Producción Enviada",
  "Fotos de Producción Aprobada", "Muestras Finales Enviadas",
  "Aprobada / Cerrada", "Cancelado",
];
const EDITABLE_FIELDS = new Set(["O", "P", "T", "TR", "PJ", "SO", "E", "F", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "FM"]);

export async function onRequestPost({ request, env }) {
  try {
    const { functionName, args = [] } = await request.json();
    let value;
    switch (functionName) {
      case "obtenerDatosDashboard":
      case "actualizarDashboardDatos": {
        const registros = await loadDashboardRecords(env, { forceRefresh: functionName === "actualizarDashboardDatos" });
        value = {
          registros,
          totalRegistros: registros.length,
          etag: fastEtag(registros),
          fechaActualizacion: new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" }),
        };
        break;
      }
      case "obtenerChecksumDashboard": {
        // El polling revisa metadatos una vez por minuto para detectar pestañas nuevas
        // sin releer todas las filas. Si aparece una tabla, sí reconstruye el dataset.
        const registros = await refreshForNewTables(env);
        value = { etag: fastEtag(registros), totalRegistros: registros.length, totalFilas: registros.length, fechaActualizacion: new Date().toISOString() };
        break;
      }
      case "obtenerEstadosDashboard":
        value = ESTADOS;
        break;
      case "obtenerEstadoCacheDashboard":
        value = { disponible: false, edadSegundos: null, fecha: null };
        break;
      case "obtenerAnalisisDashboard": {
        const registros = await loadDashboardRecords(env);
        value = buildAnalysis(registros);
        break;
      }
      case "searchOPAByNumber": {
        const user = await getAuthenticatedUser(args[1], env);
        if (!user) return Response.json({ ok: false, error: "Inicia sesión para buscar OPAs." }, { status: 401, headers: { "Cache-Control": "no-store" } });
        const query = String(args[0] || "").trim().toLocaleLowerCase();
        if (query.length < 2) value = { ok: false, error: "Ingresa al menos 2 caracteres para buscar." };
        else {
          const resultados = await searchDashboardRecordsByOPA(env, query);
          value = {
            ok: true,
            resultados: await Promise.all(resultados.map(async (r) => ({
              hoja: r.H || "SeaTable", fila: "", rowId: r._id || "", numeroOPA: r.O || "", estadoPlataforma: r.E || "",
              proyecto: r.P || "", tipoProducto: r.T || "", territorio: r.TR || "",
              personaje: r.PJ || "", subOpa: r.SO || "", fechaUltima: latestDate(r),
              imagenes: await Promise.all(normalizeImageAttachments(r.LF).map((item) => makeImagePreview(env, item))),
              fechas: { F: r.F, F1: r.F1, F2: r.F2, F3: r.F3, F4: r.F4, F5: r.F5, F6: r.F6, F7: r.F7, F8: r.F8, FM: r.FM },
              headers: {
                F1: "Concepto Enviado", F2: "Concepto Aprobado", F3: "Pre-Producción Enviada",
                F4: "Pre-Producción Aprobada", F5: "Fotos de Producción Enviada",
                F6: "Fotos de Producción Aprobada", F7: "Muestras Finales Enviadas",
                F8: "Aprobada / Cerrada", FM: "Fecha Envío de Muestras",
              },
              todasLasFechas: r,
            }))),
          };
        }
        break;
      }
      case "getOPAImagesForRows": {
        const [sessionToken, targets] = args;
        const user = await getAuthenticatedUser(sessionToken, env);
        if (!user) return Response.json({ ok: false, error: "Inicia sesión para ver las fotos de producto." }, { status: 401, headers: { "Cache-Control": "no-store" } });
        const requested = Array.isArray(targets) ? targets.slice(0, 30) : [];
        const tableNames = await discoverTableNames(env);
        const allowedTables = new Set(tableNames);
        const imagenesPorFila = {};
        const work = [];
        for (const target of requested) {
          const table = String(target?.hoja || "").trim();
          const rowId = String(target?.rowId || "").trim();
          const key = String(target?.key || "");
          if (!key || !rowId || !allowedTables.has(table)) continue;
          // La lista de registros ya trae los adjuntos. Evita volver a descargar
          // todas las filas (miles) para mostrar fotos de una página visible.
          let attachments = target.attachments;
          if (attachments == null) {
            const row = await getDashboardRow(env, table, rowId);
            const column = getDashboardColumnName(env, "LF");
            attachments = row[column] ?? row.LF;
          }
          work.push({ key, attachments: normalizeImageAttachments(attachments) });
        }
        const previews = await mapWithConcurrency(work, 6, async (item) => ({
          key: item.key,
          images: await Promise.all(item.attachments.map((attachment) => makeImagePreview(env, attachment))),
        }));
        for (const item of previews) imagenesPorFila[item.key] = item.images;
        value = { ok: true, imagenesPorFila };
        break;
      }
      case "editarCampoOPA": {
        const [sessionToken, table, rowId, fieldKey, rawValue] = args;
        const user = await getAuthenticatedUser(sessionToken, env);
        if (!user) return Response.json({ ok: false, error: "Inicia sesión para editar la OPA." }, { status: 401, headers: { "Cache-Control": "no-store" } });
        if (user.permisos?.cambiar_estado === false) return Response.json({ ok: false, error: "No tienes permiso para editar OPAs." }, { status: 403, headers: { "Cache-Control": "no-store" } });
        const key = String(fieldKey || "");
        if (!EDITABLE_FIELDS.has(key)) return Response.json({ ok: false, error: "Este campo no se puede editar desde la búsqueda." }, { status: 400, headers: { "Cache-Control": "no-store" } });
        await assertEditableTable(env, table);
        const newValue = isDateField(key) ? normalizeInputDate(rawValue) : String(rawValue ?? "").trim();
        const columnName = getDashboardColumnName(env, key);
        const updates = { [columnName]: newValue };
        const stageIndex = /^F[1-8]$/.test(key) ? Number(key.slice(1)) - 1 : -1;
        let estadoActualizado = "";
        if (stageIndex >= 0 && newValue) {
          const statusColumn = getDashboardColumnName(env, "E");
          const currentRow = await getDashboardRow(env, String(table), String(rowId || ""));
          const currentState = String(getRowValueForField(currentRow, statusColumn) || currentRow.E || "").trim();
          const statusStage = ESTADOS.findIndex((estado) => estado.toLocaleLowerCase() === currentState.toLocaleLowerCase());
          let furthestStage = statusStage >= 0 && statusStage < 8 ? statusStage : -1;
          for (let index = 0; index < 8; index++) {
            const dateKey = `F${index + 1}`;
            const dateValue = key === dateKey ? newValue : (getRowValueForField(currentRow, getDashboardColumnName(env, dateKey)) || currentRow[dateKey]);
            if (dateValue) furthestStage = Math.max(furthestStage, index);
          }
          // Las fechas anteriores completan el historial sin hacer retroceder el estado.
          // También repara estados ya retrocedidos mirando la etapa más avanzada con fecha.
          if (currentState.toLocaleLowerCase() !== "cancelado" && furthestStage > statusStage) {
            updates[statusColumn] = ESTADOS[furthestStage];
            estadoActualizado = ESTADOS[furthestStage];
          }
        }
        await updateDashboardRow(env, String(table), String(rowId || ""), updates);
        await recordBusinessAudit(env, { username: user.username, role: user.rol, action: "EDITAR_CAMPO", detail: { campo: columnName, valor: newValue, ...(estadoActualizado ? { estado: estadoActualizado } : {}) }, opa: String(args[5] || ""), table: String(table), row: String(rowId || "") });
        value = { ok: true, campo: columnName, valorNuevo: newValue, ...(estadoActualizado ? { estado: estadoActualizado } : {}) };
        break;
      }
      case "cambiarEstadoOPA": {
        const p = args[0] || {};
        const user = await getAuthenticatedUser(p.token, env);
        if (!user) return Response.json({ ok: false, error: "Inicia sesión para actualizar la OPA." }, { status: 401, headers: { "Cache-Control": "no-store" } });
        if (user.permisos?.cambiar_estado === false) return Response.json({ ok: false, error: "No tienes permiso para cambiar el estado de las OPAs." }, { status: 403, headers: { "Cache-Control": "no-store" } });
        const table = String(p.hoja || "");
        const rowId = String(p.rowId || "");
        const state = String(p.nuevoEstado || "").trim();
        if (!state || !ESTADOS.some((item) => item.toLocaleLowerCase() === state.toLocaleLowerCase())) {
          return Response.json({ ok: false, error: "Selecciona un estado válido." }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
        await assertEditableTable(env, table);
        const updates = { [getDashboardColumnName(env, "E")]: state };
        const stageIndex = ESTADOS.findIndex((item) => item.toLocaleLowerCase() === state.toLocaleLowerCase());
        if (stageIndex >= 0 && stageIndex < 8 && p.fechaElegida) {
          updates[getDashboardColumnName(env, `F${stageIndex + 1}`)] = normalizeInputDate(p.fechaElegida);
        }
        await updateDashboardRow(env, table, rowId, updates);
        await recordBusinessAudit(env, { username: user.username, role: user.rol, action: "CAMBIO_ESTADO", detail: { estado: state, fecha: p.fechaElegida || "" }, opa: String(p.numeroOPA || ""), table, row: rowId });
        value = { ok: true, hoja: table, fila: rowId, estado: state, fechaCampo: stageIndex >= 0 && stageIndex < 8 && p.fechaElegida ? `F${stageIndex + 1}` : "", fechaEscrita: p.fechaElegida ? normalizeInputDate(p.fechaElegida) : "" };
        break;
      }
      case "crearRegistroOPA": {
        const p = args[0] || {};
        const user = await getAuthenticatedUser(p.token, env);
        if (!user) return Response.json({ ok: false, error: "Inicia sesión para agregar registros." }, { status: 401, headers: { "Cache-Control": "no-store" } });
        if (user.permisos?.cambiar_estado === false) return Response.json({ ok: false, error: "No tienes permiso para agregar registros. Contacta al administrador." }, { status: 403, headers: { "Cache-Control": "no-store" } });
        const table = String(p.hoja || "").trim();
        const tableNames = await discoverTableNames(env);
        if (!tableNames.includes(table)) return Response.json({ ok: false, error: "Selecciona una hoja válida de la base." }, { status: 400, headers: { "Cache-Control": "no-store" } });
        const allowed = ["O", "P", "T", "TE", "M", "TR", "PJ", "SO", "E", "F", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "FM", "PO", "B2B", "B2C", "D", "NP", "MR", "ME", "GE"];
        const row = {};
        for (const key of allowed) {
          const raw = p.campos?.[key];
          if (raw == null || String(raw).trim() === "") continue;
          let value = String(raw).trim();
          if (isDateField(key)) value = normalizeInputDate(value);
          if (key === "MR" || key === "ME") {
            value = Number(value);
            if (!Number.isFinite(value) || value < 0) return Response.json({ ok: false, error: "Las cantidades de muestras deben ser números iguales o mayores que cero." }, { status: 400, headers: { "Cache-Control": "no-store" } });
          }
          if (key === "E" && !ESTADOS.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) return Response.json({ ok: false, error: "Selecciona un estado válido." }, { status: 400, headers: { "Cache-Control": "no-store" } });
          row[getDashboardColumnName(env, key)] = value;
        }
        if (!String(p.campos?.O || "").trim()) return Response.json({ ok: false, error: "El número de OPA es obligatorio." }, { status: 400, headers: { "Cache-Control": "no-store" } });
        const statusColumn = getDashboardColumnName(env, "E");
        if (!row[statusColumn]) {
          const latestStage = ["F8", "F7", "F6", "F5", "F4", "F3", "F2", "F1"].find((key) => row[getDashboardColumnName(env, key)]);
          if (latestStage) row[statusColumn] = ESTADOS[Number(latestStage.slice(1)) - 1];
        }
        const result = await createDashboardRow(env, table, row);
        const rowId = String(result.row_id || result._id || result.id || "");
        try {
          await recordBusinessAudit(env, { username: user.username, role: user.rol, action: "CREAR_REGISTRO_OPA", detail: { campos: Object.keys(row) }, opa: String(p.campos.O), table, row: rowId });
        } catch (auditError) {
          console.warn("No se pudo guardar la auditoría del nuevo registro:", auditError);
        }
        value = { ok: true, hoja: table, rowId, numeroOPA: String(p.campos.O), mensaje: "Registro guardado en SeaTable." };
        break;
      }
      default:
        return Response.json({ ok: false, error: `La función ${functionName} todavía debe migrarse antes de habilitarse.` }, { status: 501 });
    }
    return Response.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message || "Error procesando la solicitud." }, { status: 502 });
  }
}

async function assertEditableTable(env, tableName) {
  const names = await discoverTableNames(env);
  if (!names.some((name) => name === tableName)) throw new Error("La hoja seleccionada no pertenece a las tablas de datos del dashboard.");
}

function isDateField(key) {
  return key === "F" || key === "FM" || /^F[1-8]$/.test(key);
}

function getRowValueForField(row, configuredName) {
  const target = normalizeHeader(configuredName);
  const actualKey = Object.keys(row || {}).find((key) => normalizeHeader(key) === target);
  return actualKey ? row[actualKey] : undefined;
}

function normalizeHeader(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeInputDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  let year, month, day;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, year, month, day] = match;
  else {
    match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match) throw new Error("Ingresa la fecha en formato AAAA-MM-DD.");
    [, day, month, year] = match;
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
    throw new Error("La fecha ingresada no es válida.");
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function latestDate(r) {
  return [r.F8, r.F7, r.F6, r.F5, r.F4, r.F3, r.F2, r.F1, r.F, r.FM].filter(Boolean).sort().at(-1) || "";
}

function normalizeImageAttachments(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return text.split(/[\r\n]+/).map((item) => item.trim()).filter(Boolean);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
}

async function makeImagePreview(env, attachment) {
  const original = typeof attachment === "string" ? attachment : String(attachment?.url || "");
  const name = String(attachment?.name || original.split("/").pop() || "Imagen");
  if (/^https?:\/\//i.test(original)) return { name, url: original };
  const match = original.match(/\/(images|files)\/([0-9]{4}-[0-9]{2})\/([^/?#]+)/i);
  if (!match) return { name, url: "" };
  const path = `/${match[1].toLowerCase()}/${match[2]}/${match[3]}`;
  try { return { name, url: await getDashboardFileDownloadLink(env, path) }; }
  catch (_) { return { name, url: "" }; }
}

function buildAnalysis(records) {
  const states = new Map();
  const projects = new Map();
  const days = new Map();
  for (const r of records) {
    const state = String(r.E || "Sin estado");
    const project = String(r.P || "Sin proyecto");
    states.set(state, (states.get(state) || 0) + 1);
    const projectInfo = projects.get(project) || { total: 0, completados: 0 };
    projectInfo.total++;
    if (/aprobado|cerrado|final/i.test(state)) projectInfo.completados++;
    projects.set(project, projectInfo);
    const date = latestDate(r);
    if (date) {
      const d = days.get(date) || { fecha: date, total: 0, estados: {} };
      d.total++;
      d.estados[state] = (d.estados[state] || 0) + 1;
      days.set(date, d);
    }
  }
  const porEstado = [...states].map(([estado, valor]) => ({ estado, valor, porcentaje: records.length ? Math.round(valor / records.length * 1000) / 10 : 0 }));
  const porDia = [...days.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const porProyecto = [...projects].map(([proyecto, x]) => ({ proyecto, total: x.total, completados: x.completados, avance: x.total ? Math.round(x.completados / x.total * 1000) / 10 : 0 })).sort((a, b) => b.total - a.total).slice(0, 20);
  return { ok: true, totalGeneral: records.length, resumenRapido: buildSummary(records), porEstado, porDia, ultimos14Dias: porDia.slice(-14), porProyecto };
}

function buildSummary(records) {
  const unique = (key) => new Set(records.map((r) => String(r[key] || "").trim()).filter(Boolean)).size;
  const estadosCount = {};
  let conFecha = 0, muestrasRecibidas = 0, muestrasEnviadas = 0;
  for (const r of records) {
    const state = String(r.E || "Sin estado");
    estadosCount[state] = (estadosCount[state] || 0) + 1;
    if (r.F) conFecha++;
    muestrasRecibidas += Number(r.MR) || 0;
    muestrasEnviadas += Number(r.ME) || 0;
  }
  return {
    totalRegistros: records.length,
    opasUnicas: unique("O"),
    proyectos: unique("P"),
    marcas: unique("M"),
    territorios: unique("TR"),
    conFecha,
    muestrasRecibidas,
    muestrasEnviadas,
    estadosCount,
  };
}

function fastEtag(records) {
  // Firma corta basada en la identidad y última modificación de cada fila.
  // Evita serializar todo el dataset y calcular SHA-256 en cada revisión automática.
  let hash = 2166136261;
  for (const row of records) {
    const value = `${row._id || ""}|${row._mtime || ""};`;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${records.length}-${(hash >>> 0).toString(16)}`;
}



