/* Compatibilidad temporal: conecta la interfaz con los endpoints de Cloudflare. */
(function () {
  "use strict";
  const makeRunner = (success, failure) => new Proxy({}, {
    get(_target, property) {
      if (property === "withSuccessHandler") return (handler) => makeRunner(handler, failure);
      if (property === "withFailureHandler") return (handler) => makeRunner(success, handler);
      if (property === "withUserObject") return () => makeRunner(success, failure);
      if (property === "then") return undefined;
      const authFunctions = new Set([
        "authSetupStatus", "registerUser", "loginUser", "getCurrentUser", "logoutUser", "adminRestablecerContrasena",
        "adminListarPermisos", "adminGuardarPermisos", "adminListarUsuarios",
        "adminListarHistorial", "adminObtenerHistorialYEstadisticas",
        "obtenerMisActividades", "adminGuardarActividadesUsuario",
      ]);
      const endpoint = authFunctions.has(String(property)) ? "/api/auth" : "/api/legacy";
      return (...args) => {
        const controller = new AbortController();
        const functionName = String(property);
        // OPA search is an exact lookup over data already delivered to this
        // browser. Use that copy immediately when it contains a match; this
        // avoids a slow round trip across every SeaTable table for common hits.
        if (functionName === "searchOPAByNumber" && typeof window.__dashboardSearchOPA === "function") {
          try {
            const localResult = window.__dashboardSearchOPA(args[0]);
            if (localResult && localResult.ok) {
              if (typeof success === "function") queueMicrotask(() => success(localResult));
              return Promise.resolve(localResult);
            }
          } catch (_) {}
        }
        // La búsqueda puede necesitar un token + metadatos + consulta SQL en
        // una región fría. No cortar al segundo 18 una consulta que el backend
        // limita a 10 s solo en su fase SQL.
        const timeoutMs = functionName === "searchOPAByNumber" ? 32_000
          : (functionName === "obtenerChecksumDashboard" ? 12_000
            : (functionName === "actualizarDashboardDatos" || functionName === "obtenerDatosDashboard" ? 80_000 : 30_000));
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ functionName: String(property), args }),
        signal: controller.signal,
        }).then(async (response) => {
        const responseText = await response.text().catch(() => "");
        let body = {};
        try { body = responseText ? JSON.parse(responseText) : {}; } catch (_) {}
          if (!response.ok) {
            if (response.status === 404) throw new Error(`Cloudflare no encontró ${endpoint} (HTTP 404). El proyecto debe desplegarse como Pages con la carpeta functions/; revisa que no esté usando "wrangler deploy" de Workers.`);
            const ray = response.headers.get("cf-ray");
            const detail = String(body.error || responseText || "").replace(/\s+/g, " ").trim().slice(0, 220);
            const trace = ray ? ` · Ray ID ${ray}` : "";
            throw new Error(`${body.error || `Error del servidor (${response.status})`}${trace}${detail && !body.error ? ` · ${detail}` : ""}`);
          }
        if (typeof success === "function") success(body);
        return body;
      }).catch((error) => {
        const rawMessage = String(error && error.message || error || "");
        const isNetworkFailure = error.name === "TypeError" || /failed to fetch|fetch failed|networkerror|load failed/i.test(rawMessage);
        const message = error.name === "AbortError"
          ? `La solicitud tardó demasiado (${Math.round(timeoutMs / 1000)} s). Se conserva la copia local; revisa la conexión o vuelve a intentar.`
          : (isNetworkFailure
            ? `No se pudo conectar con la API de Cloudflare (/api). Verifica internet y que el proyecto Pages publique la carpeta public junto con functions/api; no es un problema que se resuelva borrando la caché del navegador.`
            : (rawMessage || String(error)));
        if (typeof failure === "function") failure({ message });
        else console.error("Error de API:", error);
      }).finally(() => clearTimeout(timeout));
      };
    },
  });
  window.google = window.google || {};
  // Las escrituras permitidas se validan en el endpoint de Cloudflare por sesión y permisos.
  window.CLOUD_READ_ONLY = false;
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();




