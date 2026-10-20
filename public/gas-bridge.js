/* Compatibilidad temporal: traduce google.script.run a /api/legacy.
   Las funciones no migradas se rechazan explícitamente; no se simulan. */
(function () {
  "use strict";
  const makeRunner = (success, failure) => new Proxy({}, {
    get(_target, property) {
      if (property === "withSuccessHandler") return (handler) => makeRunner(handler, failure);
      if (property === "withFailureHandler") return (handler) => makeRunner(success, handler);
      if (property === "withUserObject") return () => makeRunner(success, failure);
      if (property === "then") return undefined;
      return (...args) => fetch("/api/legacy", {
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
  window.CLOUD_READ_ONLY = true;
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();

