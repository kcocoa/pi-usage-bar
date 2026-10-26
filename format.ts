import type { RateLimitWindow } from "./rate-limits.ts";

/** Resolved once: the timezone the user's wall clock is in. */
export const LOCAL_TIME_ZONE =
	Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function formatPercent(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function remainingPercent(window: RateLimitWindow): number {
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function severityColor(window: RateLimitWindow): "dim" | "warning" | "error" {
	if (window.usedPercent >= 90) return "error";
	if (window.usedPercent >= 75) return "warning";
	return "dim";
}

/** The window has reset since it was observed, so its usage is unknown. */
export function isStale(window: RateLimitWindow, nowMs = Date.now()): boolean {
	return window.resetsAt !== undefined && window.resetsAt * 1000 <= nowMs;
}

export function formatWindowLabel(
	window: RateLimitWindow,
	fallback: string,
): string {
	if (window.label) return window.label;
	const minutes = window.windowMinutes;
	if (!minutes || minutes <= 0) return fallback;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

export function formatSubscriptionType(
	planType: string | undefined,
): string | undefined {
	const raw = planType?.trim();
	if (!raw) return undefined;
	const normalized = raw
		.toLowerCase()
		.replaceAll(/[-\s]+/g, "_")
		.replace(/^subscription_tier_/, "");
	switch (normalized) {
		case "plus":
			return "plus";
		case "prolite":
		case "pro_lite":
		case "pro5x":
		case "pro_5x":
			return "pro5x";
		case "pro":
		case "pro20x":
		case "pro_20x":
			return "pro20x";
		case "team":
		case "business":
			return "business";
		case "self_serve_business_prolite":
		case "self_serve_business_usage_based":
		case "business_pro":
		case "businesspro":
			return "business pro";
		case "supergrok":
			return "supergrok";
		case "supergrok_heavy":
		case "supergrokheavy":
			return "supergrok heavy";
		default:
			return undefined;
	}
}

/**
 * Format relative countdown with at most two units, e.g. "3h44m", "5d17h", "now".
 */
export function formatResetCountdown(
	resetsAt: number | undefined,
	nowMs = Date.now(),
): string | undefined {
	if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0)
		return undefined;
	let remaining = Math.ceil(resetsAt - nowMs / 1000);
	if (remaining <= 0) return "now";
	// Two adjacent units, e.g. 2h0m1s -> "2h" (never skip a zero unit to reach
	// a smaller one, and show seconds only when under a minute).
	const units = [
		["d", 86_400],
		["h", 3_600],
		["m", 60],
		["s", 1],
	] as const;
	const values = units.map(([, seconds]) => {
		const value = Math.floor(remaining / seconds);
		remaining %= seconds;
		return value;
	});
	const first = values.findIndex((value) => value > 0);
	let text = `${values[first]}${units[first][0]}`;
	const next = first + 1;
	if (next < units.length - 1 && values[next] > 0) {
		text += `${values[next]}${units[next][0]}`;
	}
	return text;
}

/**
 * 24-hour clock time in `timeZone`, e.g. `14:30`.
 */
export function formatResetClock(
	resetsAt: number | undefined,
	timeZone = LOCAL_TIME_ZONE,
): string | undefined {
	if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0)
		return undefined;
	const date = new Date(resetsAt * 1000);
	if (!Number.isFinite(date.getTime())) return undefined;
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const part = (type: string): string =>
		parts.find((candidate) => candidate.type === type)?.value ?? "";
	return `${part("hour")}:${part("minute")}`;
}

/**
 * Universal reset time formatter shared by all providers:
 *
 * For low remaining usage limit (<10%) or upcoming reset (<1h), display absolute clock HH:MM.
 * If expired, display "now". Otherwise display relative countdown (e.g. "3h44m").
 */
export function formatWindowReset(
	window: RateLimitWindow,
	label: string,
	nowMs = Date.now(),
	timeZone = LOCAL_TIME_ZONE,
): string | undefined {
	if (
		window.resetsAt === undefined ||
		!Number.isFinite(window.resetsAt) ||
		window.resetsAt <= 0
	) {
		return undefined;
	}
	if (isStale(window, nowMs)) return "now";

	const remainingSec = window.resetsAt - nowMs / 1000;
	const isShortWindow = label === "5h" || window.windowMinutes === 300 || (window.windowMinutes !== undefined && window.windowMinutes <= 360);
	const showClock =
		(isShortWindow && remainingPercent(window) < 10) ||
		(remainingSec > 0 && remainingSec < 3_600);

	if (showClock) {
		return formatResetClock(window.resetsAt, timeZone);
	}
	return formatResetCountdown(window.resetsAt, nowMs);
}

/**
 * ISO-like stamp in `timeZone`, e.g. `2026-10-08 00:00`.
 */
export function formatLocalStamp(
	date: Date,
	timeZone = LOCAL_TIME_ZONE,
	withSeconds = false,
): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		...(withSeconds ? { second: "2-digit" as const } : {}),
	}).formatToParts(date);
	const part = (type: string): string =>
		parts.find((candidate) => candidate.type === type)?.value ?? "";
	const time = withSeconds
		? `${part("hour")}:${part("minute")}:${part("second")}`
		: `${part("hour")}:${part("minute")}`;
	return `${part("year")}-${part("month")}-${part("day")} ${time}`;
}
