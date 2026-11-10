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
        const timeoutMs = functionName === "searchOPAByNumber" ? 18_000
          : (functionName === "actualizarDashboardDatos" || functionName === "obtenerDatosDashboard" ? 80_000 : 30_000);
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ functionName: String(property), args }),
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            if (response.status === 404) throw new Error(`Cloudflare no encontró ${endpoint} (HTTP 404). El proyecto debe desplegarse como Pages con la carpeta functions/; revisa que no esté usando "wrangler deploy" de Workers.`);
            throw new Error(body.error || `Error del servidor (${response.status})`);
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




