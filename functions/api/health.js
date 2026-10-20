export async function onRequestGet({ env }) {
  const required = ["SEATABLE_SERVER_URL", "SEATABLE_API_TOKEN", "SEATABLE_BASE_UUID"];
  const missing = required.filter((key) => !env[key]);
  return Response.json({
    ok: missing.length === 0,
    service: "dashboard-col-ft-api",
    database: missing.length ? "not_configured" : "configured",
    missing,
  }, { status: missing.length ? 503 : 200 });
}

