import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	formatLocalStamp,
	formatPercent,
	formatResetClock,
	formatResetCountdown,
	formatSubscriptionType,
	formatWindowLabel,
	formatWindowReset,
	isStale,
	LOCAL_TIME_ZONE,
	remainingPercent,
	severityColor,
} from "./format.ts";
import {
	isCodexGpt,
	isSupportedQuotaContext,
	isXai,
} from "./provider-matcher.ts";
import {
	parseRateLimitBodyEvent,
	parseRateLimitHeaders,
	type RateLimitSnapshot,
	type RateLimitUpdate,
	type RateLimitWindow,
} from "./rate-limits.ts";
import { fetchXaiBilling, readXaiOauthAccess } from "./xai-quota.ts";

const IDLE_REFRESH_MS = 60_000;
export const DEFAULT_STATUS_KEY = "plan-usage-limit";

export {
	formatLocalStamp,
	formatPercent,
	formatResetClock,
	formatResetCountdown,
	formatSubscriptionType,
	formatWindowLabel,
	formatWindowReset,
	isStale,
	LOCAL_TIME_ZONE,
	remainingPercent,
	severityColor,
};

function debugEnabled(): boolean {
	const value = process.env.DEBUG?.trim().toLowerCase();
	return value === "1" || value === "true";
}

function debugNotify(ctx: ExtensionContext | undefined, message: string): void {
	if (!debugEnabled()) return;
	const line = `[usage-limit-debug] ${formatLocalStamp(new Date(), LOCAL_TIME_ZONE, true)} ${message}`;
	if (ctx?.hasUI) ctx.ui.notify(line, "info");
	else console.error(line);
}

function debugWindowText(window: RateLimitWindow, fallback: string): string {
	const label = formatWindowLabel(window, fallback);
	const reset = formatWindowReset(window, label);
	return `${label}:${formatPercent(remainingPercent(window))}%${reset ? `↺${reset}` : ""}`;
}

function debugUpdateText(update: RateLimitUpdate): string {
	return (
		update.snapshots
			.map((snapshot) => {
				const parts = [snapshot.limitId];
				if (snapshot.primary)
					parts.push(debugWindowText(snapshot.primary, "primary"));
				if (snapshot.secondary)
					parts.push(debugWindowText(snapshot.secondary, "secondary"));
				if (snapshot.lowPriority)
					parts.push(debugWindowText(snapshot.lowPriority, "low"));
				if (snapshot.credits)
					parts.push(
						`credits:${snapshot.credits.balance ?? (snapshot.credits.hasCredits ? "yes" : "no")}`,
					);
				return parts.join(" ");
			})
			.join(" | ") || "no snapshots"
	);
}

export interface QuotaDisplaySupport {
	handleResponseHeaders(
		headers: Record<string, string>,
		ctx: ExtensionContext,
	): void;
	handleBodyEvent(event: Record<string, unknown>, ctx?: ExtensionContext): void;
	getStatusKey(): string;
}

function mergeSnapshot(
	previous: RateLimitSnapshot | undefined,
	next: RateLimitSnapshot,
): RateLimitSnapshot {
	return {
		limitId: next.limitId,
		limitName: next.limitName ?? previous?.limitName,
		primary: next.primary ?? previous?.primary,
		secondary: next.secondary ?? previous?.secondary,
		lowPriority: next.lowPriority ?? previous?.lowPriority,
		credits: next.credits ?? previous?.credits,
		planType: next.planType ?? previous?.planType,
	};
}

function sameSnapshot(
	left: RateLimitSnapshot | undefined,
	right: RateLimitSnapshot,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

const XAI_BILLING_TTL_MS = 5 * 60_000;
const XAI_BILLING_RETRY_MS = 60_000;

export interface XaiQuotaDeps {
	readToken?: () => string | undefined | Promise<string | undefined>;
	fetchBilling?: (
		token: string,
		signal?: AbortSignal,
	) => Promise<RateLimitUpdate | undefined>;
}

export interface QuotaDisplayOptions {
	statusKey?: string;
	onStatusChange?: (ctx: ExtensionContext) => void;
	xai?: XaiQuotaDeps;
}

export function registerQuotaDisplaySupport(
	pi: ExtensionAPI,
	options: QuotaDisplayOptions | ((ctx: ExtensionContext) => void) = {},
	legacyXai: XaiQuotaDeps = {},
): QuotaDisplaySupport {
	const normalizedOptions: QuotaDisplayOptions =
		typeof options === "function" ? { onStatusChange: options, xai: legacyXai } : options;
	const statusKey = normalizedOptions.statusKey ?? DEFAULT_STATUS_KEY;
	const onStatusChange = normalizedOptions.onStatusChange;
	const xai = normalizedOptions.xai ?? {};

	const readXaiToken = xai.readToken ?? readXaiOauthAccess;
	const loadXaiBilling = xai.fetchBilling ?? fetchXaiBilling;
	const snapshots = new Map<string, RateLimitSnapshot>();
	let activeContext: ExtensionContext | undefined;
	let activeLimitId: string | undefined;
	let planType: string | undefined;
	let billingGeneration = 0;
	let billingAttemptAt = 0;
	let billingOk = false;
	let billingInflight: Promise<void> | undefined;
	let lastStatusText: string | undefined | null = null; // null = nothing sent yet
	let idleTimer: ReturnType<typeof setInterval> | undefined;

	const clearState = (): void => {
		billingGeneration += 1;
		billingAttemptAt = 0;
		billingOk = false;
		snapshots.clear();
		activeLimitId = undefined;
		planType = undefined;
	};

	const refreshXaiBilling = (
		ctx: ExtensionContext,
	): Promise<void> | undefined => {
		if (!isXai(ctx)) return undefined;
		const now = Date.now();
		const ttl = billingOk ? XAI_BILLING_TTL_MS : XAI_BILLING_RETRY_MS;
		if (now - billingAttemptAt < ttl) return billingInflight;
		if (billingInflight) return billingInflight;
		const started = billingGeneration;
		billingAttemptAt = now;
		billingInflight = (async () => {
			try {
				const token = await readXaiToken();
				if (!token || started !== billingGeneration) return;
				const update = await loadXaiBilling(token);
				if (started !== billingGeneration) return;
				billingOk = update !== undefined;
				if (update) applyUpdate(update, ctx);
				debugNotify(
					ctx,
					update
						? `source=billing updated=true ${debugUpdateText(update)}`
						: "source=billing updated=false(empty)",
				);
			} catch {
				if (started === billingGeneration) billingOk = false;
				debugNotify(ctx, "source=billing updated=false(error)");
			} finally {
				billingInflight = undefined;
			}
		})();
		return billingInflight;
	};

	const selectSnapshot = (): RateLimitSnapshot | undefined => {
		const hasWindows = (snapshot: RateLimitSnapshot | undefined): boolean =>
			snapshot?.primary !== undefined ||
			snapshot?.secondary !== undefined ||
			snapshot?.lowPriority !== undefined;
		const active = activeLimitId ? snapshots.get(activeLimitId) : undefined;
		if (hasWindows(active)) return active;
		const defaultSnapshot = snapshots.get("codex") ?? snapshots.get("anthropic") ?? snapshots.get("xai");
		if (hasWindows(defaultSnapshot)) return defaultSnapshot;
		return [...snapshots.values()].find(hasWindows);
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
		if (!ctx.hasUI) return;
		if (text !== lastStatusText) {
			lastStatusText = text;
			ctx.ui.setStatus(statusKey, text);
		}
		onStatusChange?.(ctx);
	};

	const renderStatus = (ctx: ExtensionContext): void => {
		if (!isSupportedQuotaContext(ctx)) {
			setStatus(ctx, undefined);
			return;
		}
		const snapshot = selectSnapshot();
		const parts: string[] = [];
		const subscription = formatSubscriptionType(planType ?? snapshot?.planType);
		if (subscription) parts.push(ctx.ui.theme.fg("dim", subscription));
		for (const [fallback, window] of [
			["primary", snapshot?.primary],
			["secondary", snapshot?.secondary],
			["low", snapshot?.lowPriority],
		] as const) {
			if (!window) continue;
			const label = formatWindowLabel(window, fallback);
			const stale = isStale(window);
			const remaining = stale
				? "?"
				: `${formatPercent(remainingPercent(window))}%`;
			const reset = formatWindowReset(window, label);
			parts.push(
				ctx.ui.theme.fg("dim", `${label}:`) +
					ctx.ui.theme.fg(stale ? "dim" : severityColor(window), remaining) +
					(reset ? ctx.ui.theme.fg("dim", `↺${reset}`) : ""),
			);
		}
		if (parts.length === 0) {
			setStatus(ctx, undefined);
			return;
		}
		setStatus(ctx, parts.join(" "));
	};

	const applyUpdate = (
		update: RateLimitUpdate,
		ctx: ExtensionContext,
	): boolean => {
		let changed = false;
		for (const snapshot of update.snapshots) {
			const previous = snapshots.get(snapshot.limitId);
			const merged = mergeSnapshot(previous, snapshot);
			if (!sameSnapshot(previous, merged)) {
				snapshots.set(snapshot.limitId, merged);
				changed = true;
			}
		}
		if (
			update.activeLimitId !== undefined &&
			update.activeLimitId !== activeLimitId
		) {
			activeLimitId = update.activeLimitId;
			changed = true;
		}
		const nextPlanType = update.snapshots.find(
			(snapshot) => snapshot.planType,
		)?.planType;
		if (nextPlanType !== undefined && nextPlanType !== planType) {
			planType = nextPlanType;
			changed = true;
		}
		if (!changed) return false;
		renderStatus(ctx);
		return true;
	};

	const stopIdleTimer = (): void => {
		if (idleTimer) clearInterval(idleTimer);
		idleTimer = undefined;
	};
	// While idle, recompute countdowns from the cached snapshot (no network).
	const startIdleTimer = (): void => {
		stopIdleTimer();
		idleTimer = setInterval(() => {
			const ctx = activeContext;
			if (ctx?.isIdle()) renderStatus(ctx);
		}, IDLE_REFRESH_MS);
		idleTimer.unref?.();
	};

	pi.on("session_start", (_event, ctx) => {
		clearState();
		startIdleTimer();
		activeContext = isSupportedQuotaContext(ctx) ? ctx : undefined;
		setStatus(ctx, undefined);
		return refreshXaiBilling(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopIdleTimer();
		billingGeneration += 1;
		activeContext = undefined;
		setStatus(ctx, undefined);
	});
	pi.on("turn_start", (_event, ctx) => {
		activeContext = isSupportedQuotaContext(ctx) ? ctx : undefined;
		renderStatus(ctx);
		return refreshXaiBilling(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		clearState();
		activeContext = isSupportedQuotaContext(ctx) ? ctx : undefined;
		setStatus(ctx, undefined);
		return refreshXaiBilling(ctx);
	});

	const handleResponseHeaders = (
		headers: Record<string, string>,
		ctx: ExtensionContext,
	): void => {
		if (!isSupportedQuotaContext(ctx)) return;
		const update = parseRateLimitHeaders(headers);
		const refreshed = update ? applyUpdate(update, ctx) : false;
		debugNotify(
			ctx,
			update
				? `source=hdr updated=${refreshed ? "true" : "false(dup)"} ${debugUpdateText(update)}`
				: "source=hdr updated=false(no headers)",
		);
	};

	const handleBodyEvent = (
		event: Record<string, unknown>,
		ctx?: ExtensionContext,
	): void => {
		const typeText = String(event.type);
		if (!/limit|usage|rate|credit/i.test(typeText)) return;
		const active = ctx ?? activeContext;
		if (!active || !isCodexGpt(active)) {
			debugNotify(ctx, "source=sse updated=false(skip:no ctx)");
			return;
		}
		const update = parseRateLimitBodyEvent(event);
		const refreshed = update ? applyUpdate(update, active) : false;
		debugNotify(
			active,
			update
				? `source=sse updated=${refreshed ? "true" : "false(dup)"} ${debugUpdateText(update)}`
				: `source=sse updated=false(no fields) type=${typeText}`,
		);
	};

	pi.on("after_provider_response", (event, ctx) => {
		handleResponseHeaders(event.headers, ctx);
	});

	return {
		handleResponseHeaders,
		handleBodyEvent,
		getStatusKey: () => statusKey,
	};
}
