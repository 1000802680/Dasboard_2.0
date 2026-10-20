import { discoverTableNames, getDashboardColumnName, loadDashboardRecords, refreshForNewTables, updateDashboardRow } from "../_lib/seatable.js";
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
          const registros = await loadDashboardRecords(env);
          const resultados = registros.filter((r) => String(r.O || "").toLocaleLowerCase().includes(query));
          value = {
            ok: true,
            resultados: resultados.map((r) => ({
              hoja: r.H || "SeaTable", fila: "", rowId: r._id || "", numeroOPA: r.O || "", estadoPlataforma: r.E || "",
              proyecto: r.P || "", tipoProducto: r.T || "", territorio: r.TR || "",
              personaje: r.PJ || "", subOpa: r.SO || "", fechaUltima: latestDate(r),
              fechas: { F: r.F, F1: r.F1, F2: r.F2, F3: r.F3, F4: r.F4, F5: r.F5, F6: r.F6, F7: r.F7, F8: r.F8, FM: r.FM },
              headers: {
                F1: "Concepto Enviado", F2: "Concepto Aprobado", F3: "Pre-Producción Enviada",
                F4: "Pre-Producción Aprobada", F5: "Fotos de Producción Enviada",
                F6: "Fotos de Producción Aprobada", F7: "Muestras Finales Enviadas",
                F8: "Aprobada / Cerrada", FM: "Fecha Envío de Muestras",
              },
              todasLasFechas: r,
            })),
          };
        }
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
        // Al registrar la fecha de una etapa, el estado de plataforma avanza a esa etapa.
        const stageIndex = /^F[1-8]$/.test(key) ? Number(key.slice(1)) - 1 : -1;
        if (stageIndex >= 0 && newValue) updates[getDashboardColumnName(env, "E")] = ESTADOS[stageIndex];
        await updateDashboardRow(env, String(table), String(rowId || ""), updates);
        await recordBusinessAudit(env, { username: user.username, role: user.rol, action: "EDITAR_CAMPO", detail: { campo: columnName, valor: newValue, ...(stageIndex >= 0 && newValue ? { estado: ESTADOS[stageIndex] } : {}) }, opa: String(args[5] || ""), table: String(table), row: String(rowId || "") });
        value = { ok: true, campo: columnName, valorNuevo: newValue, ...(stageIndex >= 0 && newValue ? { estado: ESTADOS[stageIndex] } : {}) };
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


