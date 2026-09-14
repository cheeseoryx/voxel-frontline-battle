window.__ModuleLoader__.load({ id: "@forgeax/engine-dsh", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/protocol.ts
var FEDERATION_PROTOCOL_VERSION = 1;
var FEDERATION_ROUTE_PREFIX = "/forgeax-federation/v1";
function isEnginePreviewStatus(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return record.protocol === FEDERATION_PROTOCOL_VERSION && record.kind === "forgeax-engine-status" && record.binding === "external" && record.ready === true && typeof record.frameId === "number" && typeof record.tick === "number" && typeof record.state === "number";
}
function isFederationStatus(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return record.protocol === FEDERATION_PROTOCOL_VERSION && record.realm === "dsh" && record.ready === true && typeof record.identity === "string" && Array.isArray(record.capabilities) && record.capabilities.every((capability) => typeof capability === "string") && Number.isInteger(record.leases) && record.leases >= 0 && isEngineProjection(record.engine);
}
function isEngineProjection(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  if (record.ready !== true) return false;
  if (record.binding === "external") return typeof record.endpoint === "string";
  return record.binding === "embedded" && typeof record.frameId === "number" && typeof record.tick === "number" && typeof record.state === "number";
}

// src/client.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject(
    "shell.overlay",
    () => ctx.slots.register(
      {
        name: "shell.overlay",
        id: "forgeax-engine",
        order: 80,
        label: "ForgeaX Engine"
      },
      ForgeaXPanel
    )
  );
}
function ForgeaXPanel() {
  const [open, setOpen] = (0, import_react.useState)(true);
  const [realm, setRealm] = (0, import_react.useState)();
  const [engine, setEngine] = (0, import_react.useState)();
  const iframe = (0, import_react.useRef)(null);
  const readRealm = (0, import_react.useCallback)(async () => {
    const response = await fetch(`${FEDERATION_ROUTE_PREFIX}/status`, { cache: "no-store" });
    if (!response.ok) return;
    const value = await response.json();
    if (isFederationStatus(value)) setRealm(value);
  }, []);
  const engineEndpoint = realm?.engine.binding === "external" ? realm.engine.endpoint : void 0;
  (0, import_react.useEffect)(() => {
    if (!open) return;
    void readRealm();
    const realmTimer = window.setInterval(() => void readRealm(), 1e3);
    return () => window.clearInterval(realmTimer);
  }, [open, readRealm]);
  (0, import_react.useEffect)(() => {
    if (!open || engineEndpoint === void 0) return;
    const pollTimer = window.setInterval(() => {
      const target = iframe.current?.contentWindow;
      if (target == null) return;
      target.postMessage(
        { protocol: FEDERATION_PROTOCOL_VERSION, kind: "forgeax-engine-poll" },
        new URL(engineEndpoint).origin
      );
    }, 250);
    const onMessage = (event) => {
      if (event.source !== iframe.current?.contentWindow || !isEnginePreviewStatus(event.data))
        return;
      setEngine(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.clearInterval(pollTimer);
      window.removeEventListener("message", onMessage);
    };
  }, [engineEndpoint, open]);
  const control = () => {
    if (realm?.engine.binding === "external") {
      iframe.current?.contentWindow?.postMessage(
        {
          protocol: FEDERATION_PROTOCOL_VERSION,
          kind: "forgeax-engine-control",
          action: "toggle"
        },
        new URL(realm.engine.endpoint).origin
      );
      return;
    }
    void fetch(`${FEDERATION_ROUTE_PREFIX}/engine/control`, { method: "POST" }).then(
      () => readRealm()
    );
  };
  const projection = realm?.engine.binding === "external" ? engine : realm?.engine.binding === "embedded" ? realm.engine : void 0;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "section",
    {
      "data-forgeax-panel": "mounted",
      style: {
        position: "fixed",
        right: 18,
        bottom: 18,
        zIndex: 100,
        width: open ? 680 : 210,
        border: "1px solid rgba(94, 234, 212, 0.42)",
        borderRadius: 16,
        overflow: "hidden",
        color: "#e6fffb",
        background: "rgba(5, 14, 25, 0.96)",
        boxShadow: "0 24px 70px rgba(0, 0, 0, 0.55)",
        pointerEvents: "auto",
        fontFamily: "ui-sans-serif, system-ui, sans-serif"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "header",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "11px 14px",
              background: "linear-gradient(90deg, rgba(13,148,136,.28), rgba(37,99,235,.18))"
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 14 }, children: "ForgeaX Engine" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "span",
                  {
                    "data-forgeax-ready": realm?.ready === true ? "true" : "false",
                    style: {
                      marginLeft: 9,
                      color: realm?.ready === true ? "#5eead4" : "#fbbf24",
                      fontSize: 12
                    },
                    children: realm?.ready === true ? "\u25CF bridge ready" : "\u25CB connecting"
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => setOpen((value) => !value), style: buttonStyle, children: open ? "Hide preview" : "Show preview" })
            ]
          }
        ),
        open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: 12 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              "data-forgeax-status": "live",
              style: {
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 8,
                marginBottom: 10
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fact, { label: "binding", value: realm?.engine.binding ?? "pending" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fact, { label: "frameId", value: String(projection?.frameId ?? 0) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fact, { label: "tick", value: String(projection?.tick ?? 0) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Fact, { label: "state", value: String(projection?.state ?? 0) })
              ]
            }
          ),
          engineEndpoint !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "iframe",
            {
              ref: iframe,
              "data-forgeax-engine-frame": "real",
              src: engineEndpoint,
              title: "Running ForgeaX Engine",
              onLoad: () => {
                iframe.current?.contentWindow?.postMessage(
                  { protocol: FEDERATION_PROTOCOL_VERSION, kind: "forgeax-engine-poll" },
                  new URL(engineEndpoint).origin
                );
              },
              style: {
                display: "block",
                width: "100%",
                height: 390,
                border: "1px solid rgba(148,163,184,.25)",
                borderRadius: 10,
                background: "#020617"
              }
            }
          ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "div",
            {
              "data-forgeax-headless": "true",
              style: {
                display: "grid",
                placeItems: "center",
                height: 180,
                borderRadius: 10,
                color: "#94a3b8",
                background: "radial-gradient(circle at center, #123047, #020617 70%)"
              },
              children: "Embedded headless Engine \xB7 no placeholder pixels"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "footer",
            {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 10
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { color: "#94a3b8", fontSize: 12 }, children: [
                  "DSH native Loader \xB7 lease ",
                  realm?.leases ?? 0,
                  " \xB7 protocol ",
                  realm?.protocol ?? "\u2013"
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "button",
                  {
                    "data-forgeax-control": "toggle",
                    type: "button",
                    onClick: control,
                    style: buttonStyle,
                    children: "Toggle Engine state"
                  }
                )
              ]
            }
          )
        ] }) : null
      ]
    }
  );
}
function Fact({
  label,
  value
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "7px 9px", borderRadius: 8, background: "rgba(15, 23, 42, .9)" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "div",
      {
        style: {
          color: "#64748b",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: ".08em"
        },
        children: label
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: "#f8fafc", fontSize: 13, fontVariantNumeric: "tabular-nums" }, children: value })
  ] });
}
var buttonStyle = {
  padding: "6px 10px",
  border: "1px solid rgba(94,234,212,.35)",
  borderRadius: 8,
  color: "#ccfbf1",
  background: "rgba(15,118,110,.25)",
  cursor: "pointer",
  fontSize: 12
};
return module.exports; } });
//# sourceMappingURL=client.js.map