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
        const timeoutMs = String(property) === "searchOPAByNumber" ? 18_000 : 30_000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ functionName: String(property), args }),
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Error del servidor (${response.status})`);
        if (typeof success === "function") success(body);
        return body;
      }).catch((error) => {
        const message = error.name === "AbortError"
          ? `La solicitud tardó demasiado (${Math.round(timeoutMs / 1000)} s). Intenta de nuevo; si se repite, pulsa Actualizar datos.`
          : (error.message || String(error));
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




