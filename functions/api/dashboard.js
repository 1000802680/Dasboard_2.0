import { loadDashboardRecords } from "../_lib/seatable.js";

export async function onRequestGet({ request, env }) {
  try {
    const records = await loadDashboardRecords(env);
    const etag = `"${await digest(JSON.stringify(records))}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
    }
    return Response.json({
      ok: true,
      registros: records,
      totalRegistros: records.length,
      etag: etag.replaceAll('"', ""),
      fechaActualizacion: new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" }),
    }, { headers: { ETag: etag, "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message || "No se pudo consultar SeaTable." }, { status: 502 });
  }
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}





