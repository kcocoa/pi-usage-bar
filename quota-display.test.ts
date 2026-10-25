import { describe, expect, it, mock } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/tmp/pi-usage-bar-test",
	readStoredCredential: () => undefined,
}));

const {
	formatLocalDateTime,
	formatReset,
	formatResetClock,
	formatResetCountdown,
	formatSubscriptionType,
	formatWindowReset,
	registerQuotaDisplaySupport,
	DEFAULT_STATUS_KEY,
} = await import("./quota-display.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
	} as unknown as Parameters<typeof registerQuotaDisplaySupport>[0];
	return {
		pi,
		commands,
		async emit(name: string, event: unknown, ctx: unknown) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function createContext(provider = "codex-gateway") {
	const setStatus = mock((_key: string, _value?: string) => undefined);
	const notify = mock((_message: string, _level?: string) => undefined);
	return {
		ctx: {
			model: {
				provider,
				id: provider === "anthropic" ? "claude-opus" : "gpt-5.4",
			},
			hasUI: true,
			ui: {
				setStatus,
				notify,
				theme: { fg: (_color: string, text: string) => text },
			},
		} as unknown as NonNullable<
			Parameters<
				ReturnType<typeof registerQuotaDisplaySupport>["handleBodyEvent"]
			>[1]
		>,
		setStatus,
		notify,
	};
}

describe("Universal quota and usage display", () => {
	it("normalizes supported subscription types", () => {
		expect(formatSubscriptionType("plus")).toBe("plus");
		expect(formatSubscriptionType("prolite")).toBe("pro5x");
		expect(formatSubscriptionType("pro")).toBe("pro20x");
		expect(formatSubscriptionType("team")).toBe("business");
		expect(formatSubscriptionType("business")).toBe("business");
		expect(formatSubscriptionType("self_serve_business_prolite")).toBe(
			"business pro",
		);
	});

	it("formats reset countdowns with at most two units", () => {
		const now = Date.UTC(2026, 7, 29, 12, 0, 0);
		expect(
			formatResetCountdown(
				(now + (5 * 86_400 + 17 * 3_600 + 42 * 60) * 1000) / 1000,
				now,
			),
		).toBe("5d17h");
		expect(
			formatResetCountdown(
				(now + (3 * 3_600 + 44 * 60 + 20) * 1000) / 1000,
				now,
			),
		).toBe("3h44m");
		// A zero unit must not be skipped to show seconds ("2h1s").
		expect(
			formatResetCountdown((now + (2 * 3_600 + 1) * 1000) / 1000, now),
		).toBe("2h");
		expect(formatResetCountdown((now + 90 * 1000) / 1000, now)).toBe("1m");
		expect(formatResetCountdown((now + 30 * 1000) / 1000, now)).toBe("30s");
	});

	it("formats reset times in the requested timezone with its offset", () => {
		const epoch = 1791388800; // 2026-10-07T16:00:00Z
		expect(formatReset(epoch, "UTC")).toBe("2026-10-07 16:00 (UTC+00:00)");
		expect(formatReset(epoch, "Asia/Shanghai")).toBe(
			"2026-10-08 00:00 (UTC+08:00)",
		);
	});

	it("defaults reset times to the local timezone", () => {
		const epoch = 1791388800;
		const formatted = formatReset(epoch);
		expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
	});

	it("formats reset clock times as 24-hour HH:MM in requested timezone", () => {
		const epoch = 1791388800; // 16:00 UTC
		expect(formatResetClock(epoch, "UTC")).toBe("16:00");
		expect(formatResetClock(epoch, "Asia/Shanghai")).toBe("00:00");
	});

	it("switches 5h window to clock HH:MM when remaining quota < 10% or refresh time < 1h", () => {
		const nowSec = 1788000000;
		const nowMs = nowSec * 1000;

		// 1. 5h window, remaining quota 5% (< 10%), reset in 3 hours (> 1h) -> clock
		const resetFar = nowSec + 3 * 3600;
		const clockFar = formatResetClock(resetFar, "UTC");
		expect(
			formatWindowReset(
				{ usedPercent: 95, windowMinutes: 300, resetsAt: resetFar },
				"5h",
				nowMs,
				"UTC",
			),
		).toBe(clockFar);

		// 2. 5h window, remaining quota 80% (>= 10%), reset in 45 minutes (< 1h) -> clock
		const resetSoon = nowSec + 45 * 60;
		const clockSoon = formatResetClock(resetSoon, "UTC");
		expect(
			formatWindowReset(
				{ usedPercent: 20, windowMinutes: 300, resetsAt: resetSoon },
				"5h",
				nowMs,
				"UTC",
			),
		).toBe(clockSoon);

		// 3. 5h window, remaining quota 80% (>= 10%), reset in 3h44m (>= 1h) -> countdown
		const resetNormal = nowSec + 3 * 3600 + 44 * 60;
		expect(
			formatWindowReset(
				{ usedPercent: 20, windowMinutes: 300, resetsAt: resetNormal },
				"5h",
				nowMs,
				"UTC",
			),
		).toBe("3h44m");

		// 4. Boundary: remaining quota exactly 10% (usedPercent = 90) -> countdown
		expect(
			formatWindowReset(
				{ usedPercent: 90, windowMinutes: 300, resetsAt: resetFar },
				"5h",
				nowMs,
				"UTC",
			),
		).toBe("3h");

		// 5. Boundary: remaining quota 9.9% (usedPercent = 90.1) -> clock
		expect(
			formatWindowReset(
				{ usedPercent: 90.1, windowMinutes: 300, resetsAt: resetFar },
				"5h",
				nowMs,
				"UTC",
			),
		).toBe(clockFar);

		// 6. Reset time already passed -> "now"
		expect(
			formatWindowReset(
				{ usedPercent: 95, windowMinutes: 300, resetsAt: nowSec - 10 },
				"5h",
				nowMs,
				"UTC",
			),
		).toBe("now");

		// 7. 7d window, remaining quota 5% (< 10%), but reset in 5 days -> stays countdown
		const reset7d = nowSec + 5 * 86400;
		expect(
			formatWindowReset(
				{ usedPercent: 95, windowMinutes: 10080, resetsAt: reset7d },
				"7d",
				nowMs,
				"UTC",
			),
		).toBe("5d");

		// 8. 7d window, reset in 45 minutes (< 1h) -> clock
		expect(
			formatWindowReset(
				{ usedPercent: 50, windowMinutes: 10080, resetsAt: resetSoon },
				"7d",
				nowMs,
				"UTC",
			),
		).toBe(clockSoon);
	});

	it("renders remaining quota from response headers in the footer", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		await harness.emit("session_start", { type: "session_start" }, ctx);
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "20",
					"x-codex-primary-window-minutes": "300",
					"x-codex-secondary-used-percent": "50",
					"x-codex-secondary-window-minutes": "10080",
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			DEFAULT_STATUS_KEY,
			"5h:80% 7d:50%",
		]);
	});

	it("renders quota headers for the official OpenAI Codex provider", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext("openai-codex");
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "25",
					"x-codex-primary-window-minutes": "300",
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([DEFAULT_STATUS_KEY, "5h:75%"]);
	});

	it("shows the subscription and compact reset countdowns", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext("openai-codex");
		const now = Math.ceil(Date.now() / 1000);
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-plan-type": "prolite",
					"x-codex-primary-used-percent": "25",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": String(now + 3 * 3_600 + 44 * 60 + 20),
					"x-codex-secondary-used-percent": "50",
					"x-codex-secondary-window-minutes": "10080",
					"x-codex-secondary-reset-at": String(
						now + 5 * 86_400 + 17 * 3_600 + 42 * 60,
					),
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			DEFAULT_STATUS_KEY,
			"pro5x 5h:75%↺3h44m 7d:50%↺5d17h",
		]);
	});

	it("shows HH:MM in the footer when 5h quota is low or reset time is under 1h", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext("openai-codex");
		const nowSec = Math.floor(Date.now() / 1000);
		const resetSec = nowSec + 3 * 3600;
		const expectedClock = formatResetClock(resetSec);

		// Case 1: 5h remaining quota is 5% (< 10%)
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-plan-type": "prolite",
					"x-codex-primary-used-percent": "95",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": String(resetSec),
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			DEFAULT_STATUS_KEY,
			`pro5x 5h:5%↺${expectedClock}`,
		]);

		// Case 2: 5h remaining quota is 80%, but reset is in 45m (< 1h)
		const soonResetSec = nowSec + 45 * 60;
		const expectedSoonClock = formatResetClock(soonResetSec);
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-plan-type": "prolite",
					"x-codex-primary-used-percent": "20",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": String(soonResetSec),
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			DEFAULT_STATUS_KEY,
			`pro5x 5h:80%↺${expectedSoonClock}`,
		]);
	});

	it("ignores credit-only active buckets in the compact footer", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-credits-has-credits": "true",
					"x-codex-credits-unlimited": "false",
					"x-codex-credits-balance": "10.00",
					"x-codex-active-limit": "credit_grant",
					"x-codex-primary-used-percent": "20",
					"x-codex-primary-window-minutes": "300",
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([DEFAULT_STATUS_KEY, "5h:80%"]);
	});

	it("hides credit balances when no rate-limit windows are available", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-credits-has-credits": "true",
					"x-codex-credits-unlimited": "false",
					"x-codex-credits-balance": "10.00",
				},
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([DEFAULT_STATUS_KEY, undefined]);
	});

	it("accepts optional codex.rate_limits body events", async () => {
		const harness = createHarness();
		const support = registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		await harness.emit("turn_start", { type: "turn_start" }, ctx);
		support.handleBodyEvent(
			{
				type: "codex.rate_limits",
				rate_limits: { primary: { used_percent: 30, window_minutes: 60 } },
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([DEFAULT_STATUS_KEY, "1h:70%"]);
	});

	it("merges header and body snapshots without losing window data", async () => {
		const harness = createHarness();
		const support = registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		support.handleBodyEvent(
			{
				type: "codex.rate_limits",
				rate_limits: { primary: { used_percent: 20, window_minutes: 300 } },
			},
			ctx,
		);
		support.handleResponseHeaders(
			{
				"x-codex-secondary-used-percent": "50",
				"x-codex-secondary-window-minutes": "10080",
			},
			ctx,
		);

		expect(setStatus.mock.calls.at(-1)).toEqual([
			DEFAULT_STATUS_KEY,
			"5h:80% 7d:50%",
		]);
	});

	it("treats identical header/body snapshots as idempotent", () => {
		const harness = createHarness();
		const support = registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		const headers = {
			"x-codex-primary-used-percent": "20",
			"x-codex-primary-window-minutes": "300",
		};
		support.handleResponseHeaders(headers, ctx);
		const callsAfterHeader = setStatus.mock.calls.length;
		support.handleBodyEvent(
			{
				type: "codex.rate_limits",
				rate_limits: { primary: { used_percent: 20, window_minutes: 300 } },
			},
			ctx,
		);
		expect(setStatus.mock.calls.length).toBe(callsAfterHeader);
	});

	it("applies sequential retry snapshots in observation order", () => {
		const harness = createHarness();
		const support = registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext();
		support.handleResponseHeaders(
			{
				"x-codex-primary-used-percent": "80",
				"x-codex-primary-window-minutes": "300",
			},
			ctx,
		);
		support.handleResponseHeaders(
			{
				"x-codex-primary-used-percent": "30",
				"x-codex-primary-window-minutes": "300",
			},
			ctx,
		);
		expect(setStatus.mock.calls.at(-1)).toEqual([DEFAULT_STATUS_KEY, "5h:70%"]);
	});

	it("clears its footer status when another provider is selected", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const active = createContext();
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "10",
					"x-codex-primary-window-minutes": "300",
				},
			},
			active.ctx,
		);
		const other = createContext("other-provider");
		await harness.emit("model_select", { type: "model_select" }, other.ctx);

		expect(other.setStatus.mock.calls.at(-1)).toEqual([
			DEFAULT_STATUS_KEY,
			undefined,
		]);
	});

	it("clears stale quota when switching between Codex providers", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const gateway = createContext();
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "10",
					"x-codex-primary-window-minutes": "300",
				},
			},
			gateway.ctx,
		);
		const official = createContext("openai-codex");
		await harness.emit("model_select", { type: "model_select" }, official.ctx);
		await harness.commands.get("codex:usage")?.handler("", official.ctx);

		expect(official.notify.mock.calls.at(-1)?.[0]).toContain(
			"No Codex usage limit data",
		);
	});

	it("registers a detailed usage command and unified /usage-limit command", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, notify } = createContext();
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "20",
					"x-codex-primary-window-minutes": "300",
					"x-codex-credits-has-credits": "true",
					"x-codex-credits-unlimited": "false",
					"x-codex-credits-balance": "7.50",
				},
			},
			ctx,
		);

		// Test unified /quota
		await harness.commands.get("usage-limit")?.handler("", ctx);
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Primary (5h): 20% used, 80% left",
		);

		// Test legacy /codex:usage
		await harness.commands.get("codex:usage")?.handler("", ctx);
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Primary (5h): 20% used, 80% left",
		);
		expect(notify.mock.calls.at(-1)?.[0]).toContain("balance=7.50");
	});

	it("renders 5h and 7d remaining quota for Anthropic provider responses", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus } = createContext("anthropic");
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-utilization": "0.03",
					"anthropic-ratelimit-unified-5h-reset": String(
						Math.floor(Date.now() / 1000) + 17220,
					),
					"anthropic-ratelimit-unified-7d-utilization": "0.23",
					"anthropic-ratelimit-unified-7d-reset": String(
						Math.floor(Date.now() / 1000) + 330000,
					),
				},
			},
			ctx,
		);

		const footer = setStatus.mock.calls.at(-1)?.[1];
		expect(footer).toContain("5h:97%");
		expect(footer).toContain("7d:77%");
	});

	it("shows a window as unknown once its reset time has passed", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus, notify } = createContext("anthropic");
		const nowSec = Math.floor(Date.now() / 1000);
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-utilization": "0.95",
					"anthropic-ratelimit-unified-5h-reset": String(nowSec - 60),
					"anthropic-ratelimit-unified-7d-utilization": "0.23",
					"anthropic-ratelimit-unified-7d-reset": String(nowSec + 330000),
				},
			},
			ctx,
		);

		const footer = setStatus.mock.calls.at(-1)?.[1];
		expect(footer).toContain("5h:?↺now");
		expect(footer).toContain("7d:77%");
		await harness.commands.get("anthropic:usage")?.handler("", ctx);
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Primary (5h): unknown, reset at",
		);
	});

	it("clears an Anthropic rejection once the status is allowed again", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, notify } = createContext("anthropic");
		const respond = (status: string) =>
			harness.emit(
				"after_provider_response",
				{
					type: "after_provider_response",
					status: 200,
					headers: {
						"anthropic-ratelimit-unified-5h-utilization": "1",
						"anthropic-ratelimit-unified-status": status,
						"anthropic-ratelimit-unified-representative-claim": "five_hour",
					},
				},
				ctx,
			);
		const usage = async () => {
			await harness.commands.get("anthropic:usage")?.handler("", ctx);
			return notify.mock.calls.at(-1)?.[0];
		};

		await respond("rejected");
		expect(await usage()).toContain("Reached type: rejected (five_hour)");
		await respond("allowed");
		expect(await usage()).not.toContain("Reached type");
	});

	it("registers an anthropic:usage command", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, notify } = createContext("anthropic");
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-utilization": "0.20",
					"anthropic-ratelimit-unified-5h-reset": String(
						Math.floor(Date.now() / 1000) + 18000,
					),
				},
			},
			ctx,
		);
		await harness.commands.get("anthropic:usage")?.handler("", ctx);

		expect(notify.mock.calls.at(-1)?.[0]).toContain("Anthropic usage limit");
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Primary (5h): 20% used, 80% left",
		);
	});

	it("shows weekly SuperGrok quota from the billing endpoint", async () => {
		const harness = createHarness();
		const fetchBilling = mock(async () => ({
			source: "billing" as const,
			activeLimitId: "xai",
			snapshots: [
				{
					limitId: "xai",
					planType: "supergrok",
					primary: { usedPercent: 1, windowMinutes: 10_080 },
					credits: {
						hasCredits: true,
						unlimited: false,
						balance: "14.46",
					},
				},
			],
		}));
		registerQuotaDisplaySupport(harness.pi, {
			xai: {
				readToken: () => "oauth-token",
				fetchBilling,
			},
		});
		const { ctx, setStatus, notify } = createContext("xai");
		await harness.emit("session_start", { type: "session_start" }, ctx);

		expect(fetchBilling).toHaveBeenCalledTimes(1);
		expect(setStatus.mock.calls.at(-1)).toEqual([
			DEFAULT_STATUS_KEY,
			"supergrok 7d:99%",
		]);

		await harness.commands.get("xai:usage")?.handler("", ctx);
		expect(notify.mock.calls.at(-1)?.[0]).toContain("xAI usage limit");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Plan: supergrok");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Primary (7d): 1% used, 99% left");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("balance=14.46");
	});

	it("renders low-priority allowance in footer and details when Anthropic headers are observed", async () => {
		const harness = createHarness();
		registerQuotaDisplaySupport(harness.pi);
		const { ctx, setStatus, notify } = createContext("anthropic");
		const nowSec = Math.floor(Date.now() / 1000);
		await harness.emit(
			"after_provider_response",
			{
				type: "after_provider_response",
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-utilization": "0.20",
					"anthropic-ratelimit-unified-5h-reset": String(nowSec + 18000),
					"anthropic-ratelimit-unified-7d-utilization": "0.40",
					"anthropic-ratelimit-unified-7d-reset": String(nowSec + 400000),
					"anthropic-ratelimit-unified-slow-budget-utilization": "0.15",
					"anthropic-ratelimit-unified-slow-budget-reset": String(nowSec + 400000),
					"anthropic-ratelimit-unified-slow-status": "active",
					"anthropic-ratelimit-unified-slow-offer": "treatment",
					"anthropic-ratelimit-unified-status": "allowed",
				},
			},
			ctx,
		);

		const footer = setStatus.mock.calls.at(-1)?.[1];
		expect(footer).toContain("5h:80%");
		expect(footer).toContain("7d:60%");
		expect(footer).toContain("low:85%");

		await harness.commands.get("anthropic:usage")?.handler("", ctx);
		const details = notify.mock.calls.at(-1)?.[0];
		expect(details).toContain("Anthropic usage limit");
		expect(details).toContain("Primary (5h): 20% used, 80% left");
		expect(details).toContain("Secondary (7d): 40% used, 60% left");
		expect(details).toContain(
			"Low priority (low): 15% used, 85% left",
		);
		expect(details).toContain("[status: active, offer: treatment]");
	});
});
