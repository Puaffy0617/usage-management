import upstreamBaseline from "../../customization/upstream.json";

/** This checkout contains local features absent from stock CC Switch releases. */
export const CUSTOM_UPDATE_POLICY = Object.freeze({
  edition: "cc-switch-unified-usage" as const,
  stockInstallAllowed: false as const,
  upstreamVersion: upstreamBaseline.upstreamVersion,
});
