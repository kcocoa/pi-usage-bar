import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SupportedProviderCategory = "anthropic" | "xai" | "codex" | "openai" | "generic";

export function isAnthropic(ctx: Pick<ExtensionContext, "model"> | undefined): boolean {
	return ctx?.model?.provider === "anthropic";
}

export function isXai(ctx: Pick<ExtensionContext, "model"> | undefined): boolean {
	return ctx?.model?.provider === "xai";
}

export function isCodexGpt(ctx: Pick<ExtensionContext, "model"> | undefined): boolean {
	const provider = ctx?.model?.provider;
	const modelId = ctx?.model?.id ?? "";
	if (provider === "codex-gateway" || provider === "openai-codex") {
		return /^gpt-/i.test(modelId);
	}
	return false;
}

export function isSupportedQuotaContext(
	ctx: Pick<ExtensionContext, "model"> | undefined,
): boolean {
	if (!ctx) return false;
	return isAnthropic(ctx) || isXai(ctx) || isCodexGpt(ctx);
}

export function getProviderCategory(
	ctx: Pick<ExtensionContext, "model"> | undefined,
): SupportedProviderCategory | undefined {
	if (!ctx?.model) return undefined;
	if (isAnthropic(ctx)) return "anthropic";
	if (isXai(ctx)) return "xai";
	if (isCodexGpt(ctx)) return "codex";
	return "generic";
}

export function providerDisplayName(category: SupportedProviderCategory | string): string {
	switch (category) {
		case "anthropic":
			return "Anthropic";
		case "xai":
			return "xAI";
		case "codex":
			return "Codex";
		case "openai":
			return "OpenAI";
		default:
			return category;
	}
}
