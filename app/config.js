globalThis.FOLIO_CONFIG = {
  apiBaseUrl: ["localhost", "127.0.0.1"].includes(globalThis.location?.hostname)
    ? ""
    : "https://folio-sync.emh.workers.dev"
};
