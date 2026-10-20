export async function onRequestGet({ env }) {
  const required = ["SEATABLE_SERVER_URL", "SEATABLE_API_TOKEN", "SEATABLE_BASE_UUID"];
  const missing = required.filter((key) => !env[key]);
  const authMissing = [];
  if (!(env.SEATABLE_AUTH_API_TOKEN || env.SEATABLE_API_TOKEN)) authMissing.push("SEATABLE_API_TOKEN");
  for (const key of ["AUTH_SESSION_SECRET", "AUTH_BOOTSTRAP_KEY"]) if (!env[key]) authMissing.push(key);
  return Response.json({
    ok: missing.length === 0,
    service: "dashboard-col-ft-api",
    database: missing.length ? "not_configured" : "configured",
    missing,
    authentication: authMissing.length ? "not_configured" : "configured",
    authMissing,
  }, { status: missing.length ? 503 : 200 });
}

