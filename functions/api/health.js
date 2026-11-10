export async function onRequestGet({ env }) {
  const required = ["SEATABLE_SERVER_URL", "SEATABLE_API_TOKEN", "SEATABLE_BASE_UUID"];
  const missing = required.filter((key) => !env[key]);
  const authMissing = [];
  if (!(env.SEATABLE_AUTH_API_TOKEN || env.SEATABLE_API_TOKEN)) authMissing.push("SEATABLE_API_TOKEN");
  for (const key of ["AUTH_SESSION_SECRET", "AUTH_BOOTSTRAP_KEY"]) if (!env[key]) authMissing.push(key);
  if (missing.length) return Response.json({
    ok: false,
    service: "dashboard-col-ft-api",
    functions: "available",
    database: "not_configured",
    missing,
    authentication: authMissing.length ? "not_configured" : "configured",
    authMissing,
  }, { status: 503, headers: { "Cache-Control": "no-store" } });

  // A configured variable is not proof that Pages can reach SeaTable. Perform
  // a small credential + metadata check and return no secrets or raw API body.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const root = String(env.SEATABLE_SERVER_URL).replace(/\/$/, "");
    const tokenResponse = await fetch(`${root}/api/v2.1/dtable/app-access-token/`, {
      headers: { Authorization: `Bearer ${env.SEATABLE_API_TOKEN}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const tokenBody = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenBody.access_token) return Response.json({
      ok: false, service: "dashboard-col-ft-api", functions: "available",
      database: "authentication_failed", seaTableHttpStatus: tokenResponse.status,
      message: "SeaTable rechazó el API token o la URL del servidor.",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });

    const base = encodeURIComponent(env.SEATABLE_BASE_UUID);
    const metadataResponse = await fetch(`${root}/api-gateway/api/v2/dtables/${base}/metadata/`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!metadataResponse.ok) return Response.json({
      ok: false, service: "dashboard-col-ft-api", functions: "available",
      database: "base_access_failed", seaTableHttpStatus: metadataResponse.status,
      message: "El token respondió, pero no pudo abrir la base configurada.",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });

    return Response.json({
      ok: true,
      service: "dashboard-col-ft-api",
      functions: "available",
      database: "reachable",
      authentication: authMissing.length ? "not_configured" : "configured",
      authMissing,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      ok: false, service: "dashboard-col-ft-api", functions: "available",
      database: controller.signal.aborted ? "timeout" : "network_error",
      message: controller.signal.aborted
        ? "SeaTable no respondió en 8 segundos."
        : "Cloudflare Functions respondió, pero no pudo conectar con SeaTable.",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(timeout);
  }
}


