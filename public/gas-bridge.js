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
        "registerUser", "loginUser", "getCurrentUser", "logoutUser",
        "adminListarPermisos", "adminGuardarPermisos", "adminListarUsuarios",
        "adminListarHistorial", "adminObtenerHistorialYEstadisticas",
      ]);
      const endpoint = authFunctions.has(String(property)) ? "/api/auth" : "/api/legacy";
      return (...args) => fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ functionName: String(property), args }),
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Error del servidor (${response.status})`);
        if (typeof success === "function") success(body);
        return body;
      }).catch((error) => {
        if (typeof failure === "function") failure({ message: error.message || String(error) });
        else console.error("Error de API:", error);
      });
    },
  });
  window.google = window.google || {};
  // Las escrituras permitidas se validan en el endpoint de Cloudflare por sesión y permisos.
  window.CLOUD_READ_ONLY = false;
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();

