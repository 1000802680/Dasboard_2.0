import { loadDashboardRecords } from "../_lib/seatable.js";

const ESTADOS = [
  "Concepto Enviado", "Concepto Aprobado", "Pre-Producción Enviada",
  "Pre-Producción Aprobada", "Fotos de Producción Enviada",
  "Fotos de Producción Aprobada", "Muestras Finales Enviadas",
  "Aprobada / Cerrada", "Cancelado",
];

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
          columnas: [...new Set(registros.flatMap((row) => Object.keys(row)))],
          totalRegistros: registros.length,
          resumenRapido: buildSummary(registros),
          analisis: buildAnalysis(registros),
          etag: await digest(JSON.stringify(registros)),
          fechaActualizacion: new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" }),
        };
        break;
      }
      case "obtenerChecksumDashboard": {
        const registros = await loadDashboardRecords(env);
        value = { etag: await digest(JSON.stringify(registros)), totalRegistros: registros.length, totalFilas: registros.length, fechaActualizacion: new Date().toISOString() };
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
        const query = String(args[0] || "").trim().toLocaleLowerCase();
        if (query.length < 2) value = { ok: false, error: "Ingresa al menos 2 caracteres para buscar." };
        else {
          const registros = await loadDashboardRecords(env);
          const resultados = registros.filter((r) => String(r.O || "").toLocaleLowerCase().includes(query));
          value = {
            ok: true,
            resultados: resultados.map((r) => ({
              hoja: r.H || "SeaTable", fila: "", numeroOPA: r.O || "", estadoPlataforma: r.E || "",
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
      default:
        return Response.json({ ok: false, error: `La función ${functionName} todavía debe migrarse antes de habilitarse.` }, { status: 501 });
    }
    return Response.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message || "Error procesando la solicitud." }, { status: 502 });
  }
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

async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

