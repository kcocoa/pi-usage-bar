import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerQuotaDisplaySupport } from "./quota-display.ts";

export default async function usageBarExtension(pi: ExtensionAPI) {
	registerQuotaDisplaySupport(pi);
}
