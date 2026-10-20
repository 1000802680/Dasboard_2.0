export async function onRequestGet({ env }) {
  const required = ["SEATABLE_SERVER_URL", "SEATABLE_API_TOKEN", "SEATABLE_BASE_UUID"];
  const missing = required.filter((key) => !env[key]);
  const authRequired = ["SEATABLE_AUTH_API_TOKEN", "AUTH_SESSION_SECRET", "AUTH_BOOTSTRAP_KEY"];
  const authMissing = authRequired.filter((key) => !env[key]);
  return Response.json({
    ok: missing.length === 0,
    service: "dashboard-col-ft-api",
    database: missing.length ? "not_configured" : "configured",
    missing,
    authentication: authMissing.length ? "not_configured" : "configured",
    authMissing,
  }, { status: missing.length ? 503 : 200 });
}

