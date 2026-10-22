import type {
	CreditsSnapshot,
	RateLimitUpdate,
	RateLimitWindow,
} from "./rate-limits.ts";

/** Grok CLI billing proxy. Weekly SuperGrok usage limit is not on inference headers. */
export const XAI_BILLING_URL =
	"https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const BILLING_TIMEOUT_MS = 10_000;

export async function readXaiOauthAccess(): Promise<string | undefined> {
	// Imported on use so test mocks of the Pi package cannot fail module load.
	try {
		const { readStoredCredential } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const credential = readStoredCredential("xai");
		if (!credential || credential.type !== "oauth") return undefined;
		const access = credential.access.trim();
		return access.length > 0 ? access : undefined;
	} catch {
		return undefined;
	}
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function trimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
	const text = trimmedString(value);
	if (!text) return undefined;
	const ms = Date.parse(text.replace(/(\.\d{3})\d+/, "$1"));
	return Number.isFinite(ms) ? ms : undefined;
}

/** Proto Cent: `{ val: cents }`. An empty object is the zero value. */
function centValue(value: unknown): number | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (!("val" in record) || record.val === undefined || record.val === null)
		return 0;
	const parsed = finiteNumber(record.val);
	return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0
		? parsed
		: undefined;
}

function usagePercent(
	config: Record<string, unknown>,
): number | undefined {
	const raw = config.creditUsagePercent ?? config.credit_usage_percent;
	if (typeof raw === "number" && Number.isFinite(raw)) {
		if (raw < 0 || raw > 100.5) return undefined;
		return Math.min(100, raw);
	}
	if (raw !== undefined && raw !== null) return undefined;
	const used = centValue(config.used);
	const limit = centValue(config.monthlyLimit ?? config.monthly_limit);
	if (used === undefined || limit === undefined || limit <= 0) return undefined;
	return Math.min(100, (used / limit) * 100);
}

function billingWindow(
	config: Record<string, unknown>,
): RateLimitWindow | undefined {
	const usedPercent = usagePercent(config);
	if (usedPercent === undefined) return undefined;
	const period = asRecord(config.currentPeriod ?? config.current_period);
	const periodType = trimmedString(period?.type) ?? "";
	const startMs = parseTimestampMs(period?.start ?? config.billingPeriodStart);
	const endMs = parseTimestampMs(
		period?.end ?? config.billingPeriodEnd ?? config.billing_period_end,
	);
	let windowMinutes: number | undefined;
	if (startMs !== undefined && endMs !== undefined && endMs > startMs) {
		windowMinutes = Math.round((endMs - startMs) / 60_000);
	} else if (periodType.endsWith("WEEKLY")) {
		windowMinutes = 7 * 1_440;
	} else if (periodType.endsWith("MONTHLY")) {
		windowMinutes = 30 * 1_440;
	}
	return {
		usedPercent,
		windowMinutes,
		resetsAt: endMs === undefined ? undefined : Math.round(endMs / 1000),
	};
}

function billingCredits(
	config: Record<string, unknown>,
): CreditsSnapshot | undefined {
	const cents = centValue(config.prepaidBalance ?? config.prepaid_balance);
	if (cents === undefined) return undefined;
	return {
		hasCredits: cents > 0,
		unlimited: false,
		balance: (cents / 100).toFixed(2),
	};
}

/** Map a Grok billing payload. Missing usage is omitted, never treated as 0%. */
export function parseXaiBillingBody(body: unknown): RateLimitUpdate | undefined {
	const record = asRecord(body);
	const config = asRecord(record?.config);
	if (!record || !config) return undefined;
	const primary = billingWindow(config);
	const credits = billingCredits(config);
	const planType =
		trimmedString(record.subscription_tier) ??
		trimmedString(record.subscriptionTier);
	if (!primary && !credits && !planType) return undefined;
	return {
		source: "billing",
		snapshots: [
			{
				limitId: "xai",
				limitName: "xAI",
				primary,
				credits,
				planType,
			},
		],
		activeLimitId: primary ? "xai" : undefined,
	};
}

export async function fetchXaiBilling(
	token: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<RateLimitUpdate | undefined> {
	const timeout = AbortSignal.timeout(BILLING_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetchImpl(XAI_BILLING_URL, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			"x-xai-token-auth": "xai-grok-cli",
			"x-grok-client-mode": "cli",
			"x-grok-client-version": "1.0.4",
		},
		redirect: "error",
		signal: combined,
	});
	if (!response.ok) return undefined;
	return parseXaiBillingBody(await response.json());
}
