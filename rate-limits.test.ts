import { describe, expect, it } from "bun:test";
import {
	formatWindowLabel,
	parseRateLimitBodyEvent,
	parseRateLimitHeaders,
	remainingPercent,
} from "./rate-limits.ts";

describe("Codex rate limits", () => {
	it("parses default and additional response-header families", () => {
		const update = parseRateLimitHeaders({
			"X-Codex-Primary-Used-Percent": "18.5",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1788030000",
			"x-codex-secondary-used-percent": "42",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": "1788548400",
			"x-codex-credits-has-credits": "true",
			"x-codex-credits-unlimited": "0",
			"x-codex-credits-balance": "12.50",
			"x-codex-plan-type": "prolite",
			"x-codex-other-primary-used-percent": "75",
			"x-codex-other-primary-window-minutes": "60",
			"x-codex-other-limit-name": "Code review",
			"x-codex-active-limit": "codex_other",
			"x-codex-promo-message": "Upgrade for more usage",
			"x-codex-rate-limit-reached-type": "weekly_limit",
		});

		expect(update?.activeLimitId).toBe("codex_other");
		expect(update?.promoMessage).toBe("Upgrade for more usage");
		expect(update?.rateLimitReachedType).toBe("weekly_limit");
		expect(update?.snapshots).toHaveLength(2);
		expect(update?.snapshots[0]).toMatchObject({
			limitId: "codex",
			primary: { usedPercent: 18.5, windowMinutes: 300, resetsAt: 1788030000 },
			secondary: {
				usedPercent: 42,
				windowMinutes: 10080,
				resetsAt: 1788548400,
			},
			credits: { hasCredits: true, unlimited: false, balance: "12.50" },
			planType: "prolite",
		});
		expect(update?.snapshots[1]).toMatchObject({
			limitId: "codex_other",
			limitName: "Code review",
			primary: { usedPercent: 75, windowMinutes: 60 },
		});
	});

	it("ignores responses with no Codex quota headers", () => {
		expect(
			parseRateLimitHeaders({ "retry-after": "10", "x-request-id": "req_1" }),
		).toBeUndefined();
	});

	it("ignores bare zero-percent placeholder windows", () => {
		// Gateways emit this when the secondary limit does not exist; it must
		// not surface as "secondary:100%" in the footer.
		const update = parseRateLimitHeaders({
			"x-codex-primary-used-percent": "20",
			"x-codex-primary-window-minutes": "300",
			"x-codex-secondary-used-percent": "0",
		});
		expect(update?.snapshots[0].primary).toMatchObject({
			usedPercent: 20,
			windowMinutes: 300,
		});
		expect(update?.snapshots[0].secondary).toBeUndefined();
	});

	it("requires finite used percentages and complete credit booleans", () => {
		const update = parseRateLimitHeaders({
			"x-codex-primary-used-percent": "not-a-number",
			"x-codex-secondary-used-percent": "NaN",
			"x-codex-credits-has-credits": "yes",
			"x-codex-credits-unlimited": "true",
			"x-codex-credits-balance": "10.00",
			"x-codex-plan-type": "plus",
		});

		expect(update?.snapshots[0]).toMatchObject({
			limitId: "codex",
			planType: "plus",
		});
		expect(update?.snapshots[0].primary).toBeUndefined();
		expect(update?.snapshots[0].secondary).toBeUndefined();
		expect(update?.snapshots[0].credits).toBeUndefined();
	});

	it("parses quota headers from any provider response status", () => {
		const update = parseRateLimitHeaders({
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-window-minutes": "300",
			"x-codex-rate-limit-reached-type": "primary_window_limit",
		});
		expect(update).toMatchObject({
			rateLimitReachedType: "primary_window_limit",
			snapshots: [
				{
					limitId: "codex",
					primary: { usedPercent: 100, windowMinutes: 300 },
				},
			],
		});
	});

	it("parses optional codex.rate_limits body events", () => {
		const update = parseRateLimitBodyEvent({
			type: "codex.rate_limits",
			metered_limit_name: "codex_standard",
			plan_type: "subscription_tier_pro5x",
			rate_limits: {
				primary: {
					used_percent: 25.5,
					window_minutes: 300,
					reset_at: 1788031000,
				},
				secondary: {
					used_percent: 60,
					window_minutes: 10080,
					reset_at: 1788549000,
				},
			},
			credits: {
				has_credits: true,
				unlimited: false,
				balance: "25.00",
			},
		});

		expect(update?.source).toBe("sse_body_event");
		expect(update?.snapshots).toEqual([
			{
				limitId: "codex_standard",
				primary: {
					usedPercent: 25.5,
					windowMinutes: 300,
					resetsAt: 1788031000,
				},
				secondary: {
					usedPercent: 60,
					windowMinutes: 10080,
					resetsAt: 1788549000,
				},
				credits: {
					hasCredits: true,
					unlimited: false,
					balance: "25.00",
				},
				planType: "subscription_tier_pro5x",
			},
		]);
	});

	it("formats common windows and clamps remaining percentages", () => {
		expect(
			formatWindowLabel(
				{ usedPercent: 10, windowMinutes: 300 },
				"primary",
			),
		).toBe("5h");
		expect(
			formatWindowLabel(
				{ usedPercent: 10, windowMinutes: 10080 },
				"secondary",
			),
		).toBe("7d");
		expect(
			formatWindowLabel({ usedPercent: 10, windowMinutes: 45 }, "fallback"),
		).toBe("45m");
		expect(formatWindowLabel({ usedPercent: 10 }, "fallback")).toBe("fallback");

		expect(remainingPercent({ usedPercent: -10 })).toBe(100);
		expect(remainingPercent({ usedPercent: 25.4 })).toBe(74.6);
		expect(remainingPercent({ usedPercent: 120 })).toBe(0);
	});

	it("parses Anthropic unified 5h and 7d quota headers", () => {
		const update = parseRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-utilization": "0.185",
			"anthropic-ratelimit-unified-5h-reset": "1788030000",
			"anthropic-ratelimit-unified-7d-utilization": "0.42",
			"anthropic-ratelimit-unified-7d-reset": "1788548400",
			"anthropic-ratelimit-unified-status": "allowed",
		});

		expect(update).toMatchObject({
			source: "response_headers",
			activeLimitId: "anthropic",
			rateLimitReachedType: null,
			snapshots: [
				{
					limitId: "anthropic",
					limitName: "Anthropic",
					primary: {
						usedPercent: 18.5,
						windowMinutes: 300,
						resetsAt: 1788030000,
					},
					secondary: {
						usedPercent: 42,
						windowMinutes: 10080,
						resetsAt: 1788548400,
					},
				},
			],
		});
	});

	it("treats Anthropic utilization as a fraction and clamps over-limit values", () => {
		const update = parseRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-utilization": "1.25",
			"anthropic-ratelimit-unified-status": "rejected",
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
		});

		expect(update?.snapshots[0].primary).toMatchObject({
			usedPercent: 100,
			windowMinutes: 300,
		});
		expect(update?.rateLimitReachedType).toBe("rejected (five_hour)");
	});

	it("does not treat Anthropic allowed_warning as reached", () => {
		const update = parseRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-utilization": "0.85",
			"anthropic-ratelimit-unified-status": "allowed_warning",
		});
		expect(update?.rateLimitReachedType).toBeNull();
	});

	it("skips Anthropic windows without utilization", () => {
		const update = parseRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-reset": "1788030000",
			"anthropic-ratelimit-unified-status": "allowed",
		});
		expect(update?.snapshots[0].primary).toBeUndefined();
	});

	it("parses Anthropic unified low-priority dedicated budget headers", () => {
		const update = parseRateLimitHeaders({
			"anthropic-ratelimit-unified-5h-utilization": "0.1",
			"anthropic-ratelimit-unified-5h-reset": "1788030000",
			"anthropic-ratelimit-unified-7d-utilization": "0.4",
			"anthropic-ratelimit-unified-7d-reset": "1788548400",
			"anthropic-ratelimit-unified-slow-budget-utilization": "0.25",
			"anthropic-ratelimit-unified-slow-budget-reset": "1788548400",
			"anthropic-ratelimit-unified-slow-status": "active",
			"anthropic-ratelimit-unified-slow-offer": "treatment",
			"anthropic-ratelimit-unified-slow-retry-after": "20",
			"anthropic-ratelimit-unified-slow-max-wait": "1200",
			"anthropic-ratelimit-unified-status": "allowed",
		});

		expect(update?.snapshots[0].lowPriority).toMatchObject({
			usedPercent: 25,
			resetsAt: 1788548400,
			windowMinutes: 10_080,
			label: "low",
			status: "active",
			offer: "treatment",
			retryAfter: 20,
			maxWait: 1200,
		});
	});

	it("falls back to 7d-reset for low-priority budget when slow-budget-reset is missing", () => {
		const update = parseRateLimitHeaders({
			"anthropic-ratelimit-unified-slow-budget-utilization": "0.5",
			"anthropic-ratelimit-unified-7d-reset": "1788548400",
			"anthropic-ratelimit-unified-status": "allowed",
		});

		expect(update?.snapshots[0].lowPriority).toMatchObject({
			usedPercent: 50,
			resetsAt: 1788548400,
			label: "low",
		});
	});

	it("treats budget_exhausted status as 100% used when utilization header is missing", () => {
		const update = parseRateLimitHeaders({
			"anthropic-ratelimit-unified-slow-status": "budget_exhausted",
			"anthropic-ratelimit-unified-7d-reset": "1788548400",
			"anthropic-ratelimit-unified-status": "rejected",
		});

		expect(update?.snapshots[0].lowPriority).toMatchObject({
			usedPercent: 100,
			resetsAt: 1788548400,
			status: "budget_exhausted",
			label: "low",
		});
	});
});
