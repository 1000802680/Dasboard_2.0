import { handleAuthRequest } from "../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  try {
    const { functionName, args = [] } = await request.json();
    const result = await handleAuthRequest(String(functionName || ""), Array.isArray(args) ? args : [], env);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message || "Error de autenticación." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
