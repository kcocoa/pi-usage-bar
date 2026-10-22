import { describe, expect, it, mock } from "bun:test";
import {
	fetchXaiBilling,
	parseXaiBillingBody,
	XAI_BILLING_URL,
} from "./xai-quota.ts";

describe("xAI billing payload", () => {
	it("maps weekly credit usage without treating 1.0 as 100%", () => {
		const end = "2026-08-24T17:33:48.278812+00:00";
		const update = parseXaiBillingBody({
			subscription_tier: "SuperGrok",
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-08-17T17:33:48.278812+00:00",
					end,
				},
				creditUsagePercent: 1,
				prepaidBalance: { val: 1446 },
			},
		});

		expect(update).toMatchObject({
			source: "billing",
			activeLimitId: "xai",
			snapshots: [
				{
					limitId: "xai",
					planType: "SuperGrok",
					primary: {
						usedPercent: 1,
						windowMinutes: 10_080,
						resetsAt: Math.round(Date.parse("2026-08-24T17:33:48.278+00:00") / 1000),
					},
					credits: { hasCredits: true, unlimited: false, balance: "14.46" },
				},
			],
		});
	});

	it("does not invent 0% when the usage percentage is omitted", () => {
		expect(
			parseXaiBillingBody({
				config: {
					currentPeriod: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						end: "2026-08-24T17:33:48Z",
					},
				},
			}),
		).toBeUndefined();
	});

	it("fetches the billing proxy and ignores non-OK responses", async () => {
		const fetchImpl = mock(async (url: string, init?: RequestInit) => {
			expect(url).toBe(XAI_BILLING_URL);
			expect(init?.redirect).toBe("error");
			const headers = init?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer token");
			expect(headers["x-xai-token-auth"]).toBe("xai-grok-cli");
			return new Response(JSON.stringify({ config: {} }), { status: 401 });
		});
		expect(await fetchXaiBilling("token", fetchImpl)).toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
