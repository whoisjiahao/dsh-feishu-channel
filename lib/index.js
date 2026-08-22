import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createLarkChannel, registerApp } from "@larksuite/channel";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import qrcode from "qrcode-terminal";
//#region src/config.ts
/**
* Serializable configuration, schema, and direct-call defaults.
* @module dsh-feishu-channel/config
*/
/**
* Human-interaction tools whose answer cannot reach a chat: both ask through
* ctx.userQuestions, whose single provider belongs to whichever UI registered
* it first. Denied per chat agent so the model asks in the chat instead.
*/
const DEFAULT_DENY_TOOLS = ["ask_user_question", "exit_plan_mode"];
/**
* The default chat workspace directory: the user's home directory, portable
* across operating systems (~/.dsh-feishu on unix-like hosts, the same
* relative name under the user profile on Windows).
*/
function defaultChatWorkspaceDir() {
	return join(homedir(), ".dsh-feishu");
}
/**
* Built-in rates for the DeepSeek catalog — api-docs.deepseek.com pricing as
* of the 2026-08-17 schedule: peak is Beijing 9:00–12:00 & 14:00–18:00,
* off-peak (空闲) half price otherwise. Input rates are the cache-miss ones;
* cache-hit inputs bill at `cacheHitInput`. Deployments override per model id;
* an entry replaces the built-in one whole.
*/
const DEFAULT_PRICING = {
	"deepseek-v4-flash": {
		input: 3,
		output: 9,
		cacheHitInput: .1,
		offPeak: {
			input: 1.5,
			output: 4.5,
			cacheHitInput: .05
		}
	},
	"deepseek-v4-flash-vision-exp": {
		input: 3,
		output: 9,
		cacheHitInput: .1,
		offPeak: {
			input: 1.5,
			output: 4.5,
			cacheHitInput: .05
		}
	},
	"deepseek-v4-pro": {
		input: 9,
		output: 27,
		cacheHitInput: .3,
		offPeak: {
			input: 4.5,
			output: 13.5,
			cacheHitInput: .15
		}
	}
};
/**
* DeepSeek's published peak schedule (api-docs.deepseek.com pricing): peak is
* Beijing 9:00–12:00 and 14:00–18:00, so off-peak is the complement — the
* midday and overnight windows below, billed at half price.
*/
const DEFAULT_OFF_PEAK_WINDOWS = [{
	start: "12:00",
	end: "14:00"
}, {
	start: "18:00",
	end: "09:00"
}];
/** Loader-visible configuration schema and defaults. */
const Config = z.object({
	appId: z.string(),
	appSecret: z.string().role("secret"),
	domain: z.string(),
	cwd: z.string(),
	provider: z.string(),
	model: z.string(),
	preset: z.string(),
	sessionScope: z.union([
		"chat",
		"chat-thread",
		"chat-sender"
	]).default("chat"),
	showProcess: z.boolean().default(true),
	attachImages: z.boolean().default(false),
	syncSlashCommands: z.boolean().default(true),
	denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),
	requireMention: z.boolean().default(true),
	senderAllowlist: z.array(String),
	groupAllowlist: z.array(String),
	approvers: z.array(String),
	footerFields: z.array(String),
	pricing: z.dict(z.object({
		currency: z.string(),
		input: z.number(),
		output: z.number(),
		offPeak: z.object({
			input: z.number(),
			output: z.number()
		})
	})),
	offPeakWindows: z.array(z.object({
		start: z.string(),
		end: z.string()
	})),
	maxTimelineItems: z.number(),
	tableOverflowMode: z.union(["compact", "truncate"])
});
/** Defaults for direct callers that bypass the Cordis Loader. */
function resolveConfig(config) {
	return {
		appId: config.appId,
		appSecret: config.appSecret,
		domain: config.domain,
		cwd: config.cwd ?? defaultChatWorkspaceDir(),
		provider: config.provider,
		model: config.model,
		preset: config.preset,
		sessionScope: config.sessionScope ?? "chat",
		showProcess: config.showProcess ?? true,
		attachImages: config.attachImages ?? false,
		syncSlashCommands: config.syncSlashCommands ?? true,
		denyTools: config.denyTools ?? [...DEFAULT_DENY_TOOLS],
		requireMention: config.requireMention ?? true,
		senderAllowlist: config.senderAllowlist ?? [],
		groupAllowlist: config.groupAllowlist ?? [],
		approvers: config.approvers ?? [],
		footerFields: config.footerFields ?? [
			"duration",
			"model",
			"input_tokens",
			"output_tokens",
			"cost",
			"context"
		],
		pricing: seededPricing(config.pricing),
		offPeakWindows: resolveOffPeakWindows(config.offPeakWindows),
		maxTimelineItems: config.maxTimelineItems ?? 12,
		tableOverflowMode: config.tableOverflowMode ?? "compact"
	};
}
/**
* Fresh built-in entries merged under the deployment's explicit ones: a
* configured model id replaces the built-in entry whole; everything else
* keeps billing out of the box. Copies defensively so callers cannot mutate
* {@link DEFAULT_PRICING} through the resolved config.
*/
function seededPricing(explicit) {
	const seeded = {};
	for (const [id, price] of Object.entries(DEFAULT_PRICING)) seeded[id] = {
		...price,
		...price.offPeak !== void 0 ? { offPeak: { ...price.offPeak } } : {}
	};
	return {
		...seeded,
		...explicit
	};
}
/**
* Fail fast on malformed windows instead of silently never matching: each
* bound must be a 24-hour `HH:MM`. An explicit `[]` disables off-peak billing.
*/
function resolveOffPeakWindows(windows) {
	const resolved = windows ?? [...DEFAULT_OFF_PEAK_WINDOWS.map((window) => ({ ...window }))];
	for (const window of resolved) for (const bound of [window.start, window.end]) if (parseClock$1(bound) === void 0) throw new Error(`config.offPeakWindows: expected "HH:MM" (24-hour), got "${bound}"`);
	return resolved;
}
/** Minutes since midnight for a strict `H:MM`/`HH:MM` 24-hour clock string. */
function parseClock$1(value) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (match === null) return void 0;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return void 0;
	return hours * 60 + minutes;
}
//#endregion
//#region src/conversation.ts
/** Stable identity for one Feishu conversation facet and one inbound turn. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function component(value, label) {
	if (value === "") throw new Error(label + " must not be empty");
	return encodeURIComponent(value);
}
/** Derive the sole state-partition key for one configured session scope. */
function conversationKey(scope, address) {
	const chat = component(address.chatId, "chatId");
	if (scope === "chat-thread" && address.threadId !== void 0 && address.threadId !== "") return "thread:" + chat + ":" + component(address.threadId, "threadId");
	if (scope === "chat-sender") return "sender:" + chat + ":" + component(address.senderId, "senderId");
	return "chat:" + chat;
}
/** Create a current-generation DSH session id for one conversation key. */
function createSessionId(key, generation = randomUUID()) {
	if (!UUID.test(generation)) throw new Error("invalid session generation");
	return "feishu-" + key + "~" + generation.toLowerCase();
}
/** Test whether a session id is a current-generation id for this key. */
function sessionBelongsTo(key, sessionId) {
	const prefix = "feishu-" + key + "~";
	return sessionId.startsWith(prefix) && UUID.test(sessionId.slice(prefix.length));
}
/** Capture a turn's reply destination before asynchronous work can interleave. */
function createTurnTarget(scope, address) {
	return Object.freeze({
		conversationKey: conversationKey(scope, address),
		chatId: address.chatId,
		replyToMessageId: address.messageId,
		replyInThread: address.threadId !== void 0 && address.threadId !== ""
	});
}
//#endregion
//#region src/agent-registry.ts
function detail$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Serializes lifecycle work per conversation while allowing unrelated
* conversations to progress independently.
*/
var AgentRegistry = class {
	options;
	current = /* @__PURE__ */ new Map();
	conversationBySession = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Map();
	closed = false;
	closing;
	constructor(options) {
		this.options = options;
	}
	/** Return the current owned agent, opening it once when absent. */
	acquire(key) {
		return this.exclusive(key, async () => {
			const existing = this.current.get(key);
			if (existing !== void 0) return existing;
			const opened = await this.restoreOrCreate(key);
			this.remember(opened);
			return opened;
		});
	}
	/** Replace one conversation generation and retire its previous owned agent. */
	reset(key) {
		return this.exclusive(key, async () => {
			const previous = this.current.get(key);
			const replacement = await this.create(key);
			await this.attach(replacement.handle.agent.session.id);
			this.remember(replacement);
			if (previous !== void 0) {
				this.conversationBySession.delete(previous.handle.agent.session.id);
				previous.handle.agent.cancel("user");
				await this.detach(previous.handle.agent.session.id);
				await previous.handle.dispose().catch((error) => {
					this.report("disposing replaced session failed: " + detail$1(error));
				});
			}
			return replacement;
		});
	}
	/** Whether this registry currently owns one exact host session. */
	ownsSession(sessionId) {
		return this.conversationBySession.has(sessionId);
	}
	/** Whether an acquired handle is still the active generation for its conversation. */
	isCurrent(agent) {
		return this.current.get(agent.conversationKey) === agent;
	}
	/** The conversation key currently owning a host session, when any. */
	conversationOf(sessionId) {
		return this.conversationBySession.get(sessionId);
	}
	/** Dispose every owned handle after in-flight lifecycle work settles. */
	close() {
		if (this.closing !== void 0) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			await Promise.allSettled([...this.pending.values()]);
			const handles = [...new Set([...this.current.values()].map((entry) => entry.handle))];
			this.current.clear();
			this.conversationBySession.clear();
			await Promise.allSettled(handles.map((handle) => handle.dispose()));
		})();
		return this.closing;
	}
	exclusive(key, work) {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error("agent registry is closed"));
		const operation = (this.pending.get(key) ?? Promise.resolve()).then(async () => {
			if (this.closed) throw new Error("agent registry is closed");
			return work();
		});
		const settled = operation.then(() => void 0, () => void 0);
		this.pending.set(key, settled);
		return operation.finally(() => {
			if (this.pending.get(key) === settled) this.pending.delete(key);
		});
	}
	async restoreOrCreate(key) {
		for (const sessionId of await this.candidates(key)) {
			if (this.options.agents.get(sessionId) !== void 0) {
				this.report("foreign live agent skipped: " + sessionId);
				continue;
			}
			try {
				const handle = await this.options.agents.resume({
					resumeSessionId: sessionId,
					...this.options.agentOptions === void 0 ? {} : { agentOptions: this.options.agentOptions },
					...this.options.setup === void 0 ? {} : { setup: this.options.setup }
				});
				const owned = Object.freeze({
					conversationKey: key,
					handle
				});
				await this.attach(sessionId);
				return owned;
			} catch (error) {
				this.report("resuming session " + sessionId + " failed: " + detail$1(error));
			}
		}
		const created = await this.create(key);
		await this.attach(created.handle.agent.session.id);
		return created;
	}
	async create(key) {
		const handle = await this.options.agents.create({
			sessionId: createSessionId(key),
			...this.options.meta === void 0 ? {} : { meta: this.options.meta },
			...this.options.agentOptions === void 0 ? {} : { agentOptions: this.options.agentOptions },
			...this.options.setup === void 0 ? {} : { setup: this.options.setup }
		});
		return Object.freeze({
			conversationKey: key,
			handle
		});
	}
	remember(agent) {
		this.current.set(agent.conversationKey, agent);
		this.conversationBySession.set(agent.handle.agent.session.id, agent.conversationKey);
	}
	async candidates(key) {
		const ids = [];
		if (this.options.persistence !== void 0) try {
			const headers = await this.options.persistence.list();
			ids.push(...headers.filter((header) => sessionBelongsTo(key, header.id)).sort((left, right) => right.createdAt - left.createdAt).map((header) => header.id));
		} catch (error) {
			this.report("listing persisted sessions failed: " + detail$1(error));
		}
		ids.push(...(this.options.workspace?.sessionIds ?? []).filter((id) => sessionBelongsTo(key, id)));
		return [...new Set(ids)];
	}
	async attach(sessionId) {
		if (this.options.workspace === void 0) return;
		try {
			await this.options.workspace.attachSession(sessionId);
		} catch (error) {
			this.report("workspace attach failed for " + sessionId + ": " + detail$1(error));
		}
	}
	async detach(sessionId) {
		if (this.options.workspace === void 0) return;
		try {
			await this.options.workspace.detachSession(sessionId);
		} catch (error) {
			this.report("workspace detach failed for " + sessionId + ": " + detail$1(error));
		}
	}
	report(line) {
		this.options.report?.(line);
	}
};
//#endregion
//#region src/card-tokens.ts
/**
* Design-system tokens: the code-layer single source of truth for the
* semantic palette and spacing scale defined in docs/design-system.md.
* Every other module consumes these constants and never hardcodes a color
* or spacing literal.
* @module dsh-feishu-channel/card-tokens
*/
/** Platform semantic colors; clients adapt these tokens to light and dark themes. */
const CARD_COLOR = {
	neutral: "neutral",
	grey: "grey",
	blue: "blue",
	green: "green",
	orange: "orange",
	red: "red",
	indigo: "indigo"
};
/** Map one semantic state to the restrained accent used by status text only. */
function toneColor(tone) {
	switch (tone) {
		case "info": return CARD_COLOR.blue;
		case "success": return CARD_COLOR.green;
		case "warning": return CARD_COLOR.orange;
		case "failure": return CARD_COLOR.red;
		default: return CARD_COLOR.neutral;
	}
}
const SPACE_4 = "12px";
//#endregion
//#region src/card-design.ts
/**
* Interactive-card primitives: the shared building blocks for the channel's
* command, approval, model-setting, and handoff cards. The semantic palette
* and spacing tokens live in card-tokens.ts (docs/design-system.md is the
* design-level source of truth; this file and card-tokens.ts are the
* executable contract).
* @module dsh-feishu-channel/card-design
*/
/** Inline status pill supported by both lark_md and CardKit markdown. */
function statusTag(label, tone) {
	return `<text_tag color='${toneColor(tone)}'>${label}</text_tag>`;
}
/** Neutral JSON 1.0 card shell used by interactive command and approval cards. */
function interactiveCard(elements) {
	return {
		config: { wide_screen_mode: true },
		elements
	};
}
/** Compact JSON 1.0 title row: hierarchy in type, state in one small pill. */
function interactiveStatusLine(title, status, tone) {
	return {
		tag: "div",
		text: {
			tag: "lark_md",
			content: `**${title}**  ${statusTag(status, tone)}`
		}
	};
}
/** One hard divider; Feishu does not expose the mockup's edge-fade treatment. */
function interactiveDivider() {
	return { tag: "hr" };
}
/** Responsive JSON 1.0 label/value row with dynamic content rendered literally. */
function interactiveFieldRow(label, value) {
	return {
		tag: "div",
		fields: [{
			is_short: true,
			text: {
				tag: "lark_md",
				content: `**${label}**`
			}
		}, {
			is_short: true,
			text: {
				tag: "plain_text",
				content: value
			}
		}]
	};
}
/** Static section label followed by literal dynamic content. */
function interactivePlainSection(label, value) {
	return [{
		tag: "div",
		text: {
			tag: "lark_md",
			content: `**${label}**`
		}
	}, {
		tag: "div",
		text: {
			tag: "plain_text",
			content: value
		}
	}];
}
/** Compact CardKit 2.0 state line for cards that do not need a disclosure header. */
function cardKitStatusLine(elementId, title, status, tone) {
	return {
		tag: "markdown",
		element_id: elementId,
		content: `**${title}**  ${statusTag(status, tone)}`,
		text_size: "normal"
	};
}
//#endregion
//#region src/presentation/sensitive-text.ts
/** Redacts credential values before untrusted operational text reaches a card. */
const REDACTED = "[REDACTED]";
const DEFAULT_MAX_CHARS = 600;
function canonicalKey(key) {
	return key.replace(/^--?/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function isSensitiveKey(key) {
	const canonical = canonicalKey(key);
	const parts = canonical.split("_").filter(Boolean);
	const last = parts.at(-1);
	if (last === void 0) return false;
	if ([
		"token",
		"secret",
		"password",
		"passwd",
		"credential",
		"credentials"
	].includes(last)) return true;
	if ([
		"authorization",
		"proxy_authorization",
		"cookie",
		"set_cookie"
	].includes(canonical)) return true;
	if (last === "key" && [
		"api",
		"access",
		"private",
		"secret"
	].includes(parts.at(-2) ?? "")) return true;
	return canonical.endsWith("access_key_id") || canonical.endsWith("password_hash");
}
function redactJson(value) {
	if (Array.isArray(value)) return value.map(redactJson);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? REDACTED : redactJson(item)]));
}
function structuredJson(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return void 0;
	try {
		return JSON.stringify(redactJson(JSON.parse(trimmed)));
	} catch {
		return;
	}
}
function isKeyCharacter(character) {
	return character !== void 0 && /[A-Za-z0-9_.-]/.test(character);
}
function assignmentAt(text, start) {
	if (start > 0 && isKeyCharacter(text[start - 1])) return void 0;
	let cursor = start;
	let cliOption = false;
	if (text.startsWith("--", cursor)) {
		cliOption = true;
		cursor += 2;
	}
	const quote = text[cursor] === "\"" || text[cursor] === "'" ? text[cursor] : void 0;
	if (quote !== void 0) cursor += 1;
	const keyStart = cursor;
	while (isKeyCharacter(text[cursor])) cursor += 1;
	if (cursor === keyStart) return void 0;
	const key = text.slice(keyStart, cursor);
	if (quote !== void 0) {
		if (text[cursor] !== quote) return void 0;
		cursor += 1;
	}
	const whitespaceStart = cursor;
	while (/\s/.test(text[cursor] ?? "")) cursor += 1;
	if (text[cursor] === ":" || text[cursor] === "=") {
		cursor += 1;
		while (/\s/.test(text[cursor] ?? "")) cursor += 1;
		return {
			key,
			valueStart: cursor
		};
	}
	if (cliOption && cursor > whitespaceStart) return {
		key,
		valueStart: cursor
	};
}
function quotedValueEnd(text, start, quote) {
	let cursor = start + 1;
	while (cursor < text.length) {
		if (text[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		if (text[cursor] === quote) return cursor + 1;
		cursor += 1;
	}
	return text.length;
}
function unquotedValueEnd(text, start, key, wrapperQuote) {
	if (wrapperQuote !== void 0) {
		const closing = text.indexOf(wrapperQuote, start);
		return closing < 0 ? text.length : closing;
	}
	if (["authorization", "proxy_authorization"].includes(canonicalKey(key))) {
		const credential = /^(?:Bearer|Basic)\s+\S+/i.exec(text.slice(start));
		if (credential !== null) return start + credential[0].length;
	}
	let cursor = start;
	while (cursor < text.length && !/[\s,;&}]/.test(text[cursor])) cursor += 1;
	return cursor;
}
function redactAssignments(text) {
	let output = "";
	let copiedUntil = 0;
	let cursor = 0;
	while (cursor < text.length) {
		const assignment = assignmentAt(text, cursor);
		if (assignment === void 0 || !isSensitiveKey(assignment.key)) {
			cursor += 1;
			continue;
		}
		const valueStart = assignment.valueStart;
		if (valueStart >= text.length) {
			cursor += 1;
			continue;
		}
		const quote = text[valueStart] === "\"" || text[valueStart] === "'" ? text[valueStart] : void 0;
		const wrapper = quote === void 0 && (text[cursor - 1] === "\"" || text[cursor - 1] === "'") ? text[cursor - 1] : void 0;
		const valueEnd = quote === void 0 ? unquotedValueEnd(text, valueStart, assignment.key, wrapper) : quotedValueEnd(text, valueStart, quote);
		if (valueEnd === valueStart) {
			cursor += 1;
			continue;
		}
		output += text.slice(copiedUntil, valueStart);
		output += quote === void 0 ? REDACTED : quote + REDACTED + quote;
		copiedUntil = valueEnd;
		cursor = valueEnd;
	}
	return output + text.slice(copiedUntil);
}
function bound(text, maxChars) {
	if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");
	if (text.length <= maxChars) return text;
	if (maxChars === 1) return "…";
	return text.slice(0, maxChars - 1) + "…";
}
/**
* Replace values owned by credential-like keys, then bound the complete safe
* result. Redaction always runs before truncation, so the retained prefix
* cannot expose the beginning of a long secret.
*/
function redactSensitiveText(text, maxChars = DEFAULT_MAX_CHARS) {
	return bound(structuredJson(text) ?? redactAssignments(text), maxChars);
}
//#endregion
//#region src/approval-gate.ts
/** Owned-turn approval questions rendered and settled through Feishu cards. */
/** Marker distinguishing this plugin's approval actions. */
const APPROVAL_ACTION = "dsh-feishu-channel/approval";
function deferred() {
	let resolve;
	return {
		promise: new Promise((resolvePromise) => {
			resolve = resolvePromise;
		}),
		resolve
	};
}
function actionValue(value) {
	const payload = typeof value === "object" && value !== null ? value : void 0;
	if (payload?.kind !== "dsh-feishu-channel/approval" || typeof payload.id !== "string") return void 0;
	switch (payload.decision) {
		case "allow":
		case "reject": return {
			kind: APPROVAL_ACTION,
			id: payload.id,
			decision: payload.decision
		};
		default: return;
	}
}
/** Frozen pending approval card. Dynamic values are literal plain text. */
function approvalCard(toolName, reason, command, id) {
	const safeTool = redactSensitiveText(toolName, 120);
	const safeReason = reason === void 0 ? void 0 : redactSensitiveText(reason);
	const safeCommand = command === void 0 ? void 0 : redactSensitiveText(command);
	const content = [
		interactiveStatusLine("操作审批", "待确认", "warning"),
		interactiveDivider(),
		interactiveFieldRow("工具", safeTool),
		...safeCommand === void 0 ? [] : interactivePlainSection("将执行", safeCommand),
		...safeReason === void 0 || safeReason === "" ? [] : interactivePlainSection("模型说明", safeReason)
	];
	content.push(approvalNotice("批准前请确认上面的内容确实是你要执行的。"), {
		tag: "action",
		actions: [approvalButton("允许一次", "primary", id, "allow"), approvalButton("拒绝", "danger", id, "reject")]
	});
	return interactiveCard(content);
}
function approvalNotice(content) {
	return {
		tag: "note",
		elements: [{
			tag: "plain_text",
			content
		}]
	};
}
function approvalButton(label, type, id, decision) {
	return {
		tag: "button",
		text: {
			tag: "plain_text",
			content: label
		},
		type,
		value: {
			kind: APPROVAL_ACTION,
			id,
			decision
		}
	};
}
const SETTLED_LOOK = {
	"allowed-once": {
		status: "已允许",
		tone: "success"
	},
	"rejected": {
		status: "已拒绝",
		tone: "failure"
	},
	"cancelled": {
		status: "已撤回",
		tone: "neutral"
	},
	"unavailable": {
		status: "不可用",
		tone: "neutral"
	}
};
/** Frozen terminal approval card. */
function settledCard(toolName, outcome, decidedBy) {
	const look = SETTLED_LOOK[outcome];
	return interactiveCard([
		interactiveStatusLine("操作审批", look.status, look.tone),
		interactiveDivider(),
		interactiveFieldRow("工具", redactSensitiveText(toolName, 120)),
		...decidedBy === void 0 ? [] : [{
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: "操作人：" + redactSensitiveText(decidedBy, 120)
			}]
		}]
	]);
}
/** Create a gate with exact owner, call, card, and cancellation correlation. */
function createApprovalGate(options) {
	const callsBySession = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const sending = /* @__PURE__ */ new Map();
	let closed = false;
	let closing;
	const reportUpdateFailure = (error) => {
		options.notify("feishu-channel: outbound send failed: " + (error instanceof Error ? error.message : String(error)));
	};
	const updateTerminalCard = async (question, outcome, decidedBy) => {
		await options.port.updateCard(question.messageId, settledCard(question.toolName, outcome, decidedBy)).catch(reportUpdateFailure);
	};
	const settle = (id, outcome, decidedBy) => {
		const question = pending.get(id);
		if (question === void 0) return void 0;
		pending.delete(id);
		question.removeAbortListener();
		question.resolve(outcome);
		return updateTerminalCard(question, outcome, decidedBy);
	};
	const ask = async (owner, request, next) => {
		if (request.agent.session.id !== owner.sessionId) return next();
		if (closed) return "cancelled";
		if (request.signal?.aborted === true) return "cancelled";
		const id = options.createId?.() ?? randomUUID();
		const cancellation = deferred();
		const finished = deferred();
		let cancelled = false;
		let abortListenerInstalled = false;
		const cancel = () => {
			if (cancelled) return;
			cancelled = true;
			cancellation.resolve(void 0);
			settle(id, "cancelled");
		};
		const removeAbortListener = () => {
			if (!abortListenerInstalled) return;
			request.signal?.removeEventListener("abort", cancel);
			abortListenerInstalled = false;
		};
		if (request.signal !== void 0) {
			request.signal.addEventListener("abort", cancel, { once: true });
			abortListenerInstalled = true;
			if (request.signal.aborted) cancel();
		}
		const sendingQuestion = {
			owner,
			done: finished.promise,
			cancel
		};
		sending.set(id, sendingQuestion);
		const call = request.callId === void 0 ? void 0 : callsBySession.get(owner.sessionId)?.get(request.callId);
		const command = call?.owner.turnId === owner.turnId ? call.argumentsText : void 0;
		const sendAttempt = options.port.send(owner.chatId, { card: approvalCard(request.toolName, request.reason, command, id) });
		const result = await Promise.race([sendAttempt.then((sent) => ({
			kind: "sent",
			sent
		}), (error) => ({
			kind: "failed",
			error
		})), cancellation.promise.then(() => ({ kind: "cancelled" }))]);
		if (result.kind === "cancelled") {
			sendAttempt.then((sent) => updateTerminalCard({
				messageId: sent.messageId,
				toolName: request.toolName
			}, "cancelled"), () => void 0).finally(() => {
				removeAbortListener();
				sending.delete(id);
				finished.resolve(void 0);
			});
			return "cancelled";
		}
		sending.delete(id);
		finished.resolve(void 0);
		if (result.kind === "failed") {
			removeAbortListener();
			options.notify("feishu-channel: outbound send failed: " + (result.error instanceof Error ? result.error.message : String(result.error)));
			return cancelled ? "cancelled" : next();
		}
		if (cancelled || closed) {
			removeAbortListener();
			await updateTerminalCard({
				messageId: result.sent.messageId,
				toolName: request.toolName
			}, "cancelled");
			return "cancelled";
		}
		return new Promise((resolve) => {
			pending.set(id, {
				conversationKey: owner.conversationKey,
				chatId: owner.chatId,
				chatType: owner.chatType,
				messageId: result.sent.messageId,
				toolName: request.toolName,
				removeAbortListener,
				resolve
			});
		});
	};
	const cancelConversation = async (key) => {
		const work = [];
		for (const question of sending.values()) {
			if (question.owner.conversationKey !== key) continue;
			question.cancel();
			work.push(question.done);
		}
		for (const [id, question] of [...pending]) {
			if (question.conversationKey !== key) continue;
			const update = settle(id, "cancelled");
			if (update !== void 0) work.push(update);
		}
		for (const [sessionId, calls] of callsBySession) {
			for (const [callId, call] of calls) if (call.owner.conversationKey === key) calls.delete(callId);
			if (calls.size === 0) callsBySession.delete(sessionId);
		}
		await Promise.allSettled(work);
	};
	return {
		recordToolCall(owner, callId, argumentsText) {
			const calls = callsBySession.get(owner.sessionId) ?? /* @__PURE__ */ new Map();
			calls.set(callId, {
				owner,
				argumentsText
			});
			callsBySession.set(owner.sessionId, calls);
		},
		finishTurn(owner) {
			const calls = callsBySession.get(owner.sessionId);
			if (calls === void 0) return;
			for (const [callId, call] of calls) if (call.owner.turnId === owner.turnId) calls.delete(callId);
			if (calls.size === 0) callsBySession.delete(owner.sessionId);
		},
		ask,
		handleCardAction(event) {
			const action = actionValue(event.action.value);
			if (action === void 0) return void 0;
			const question = pending.get(action.id);
			if (question === void 0 || question.messageId !== event.messageId) return { toast: {
				type: "info",
				content: "该审批已失效"
			} };
			const refusal = options.refuseCardAction({
				operatorId: event.operator.openId,
				chatId: event.chatId
			}, question);
			if (refusal !== void 0) {
				options.notify("feishu-channel: rejected an approval click: " + refusal);
				return { toast: {
					type: "error",
					content: "你无权批准此操作"
				} };
			}
			const outcome = action.decision === "allow" ? "allowed-once" : "rejected";
			settle(action.id, outcome, event.operator.name ?? event.operator.openId);
			return { toast: {
				type: action.decision === "allow" ? "success" : "info",
				content: action.decision === "allow" ? "已允许执行一次" : "已拒绝"
			} };
		},
		cancelConversation,
		close() {
			if (closing !== void 0) return closing;
			closed = true;
			closing = (async () => {
				const work = [];
				for (const question of sending.values()) {
					question.cancel();
					work.push(question.done);
				}
				for (const id of [...pending.keys()]) {
					const update = settle(id, "cancelled");
					if (update !== void 0) work.push(update);
				}
				callsBySession.clear();
				await Promise.allSettled(work);
			})();
			return closing;
		}
	};
}
//#endregion
//#region src/authorization.ts
/** Resolve the narrowing rules from configuration. */
function resolveAuthorization(config) {
	return {
		directSenders: new Set(config.senderAllowlist),
		groups: new Set(config.groupAllowlist),
		approvers: new Set(config.approvers)
	};
}
/** State the channel's reach once, for the operator, at startup. */
function describeAuthorization(authorization) {
	const direct = authorization.directSenders.size === 0 ? "direct messages: anyone the app is visible to (narrow with senderAllowlist)" : "direct messages: " + [...authorization.directSenders].join(", ");
	const groups = authorization.groups.size === 0 ? "groups: any group the bot is added to, when @-mentioned" : "groups: " + [...authorization.groups].join(", ");
	const approvers = authorization.approvers.size === 0 ? "approvals: anyone who may drive that chat" : "approvals: " + [...authorization.approvers].join(", ");
	return "feishu-channel: " + direct + "; " + groups + "; " + approvers;
}
/**
* Whether one inbound message may drive this channel.
* @param authorization - the channel's authorization rules.
* @param subject - the message's sender, chat, and chat kind.
* @returns the refusal reason for the operator log, or undefined when allowed.
*/
function refuseMessage(authorization, subject) {
	if (subject.chatType === "p2p") {
		if (authorization.directSenders.size === 0) return void 0;
		return authorization.directSenders.has(subject.senderId) ? void 0 : "sender " + subject.senderId + " is not in senderAllowlist";
	}
	if (authorization.groups.size > 0 && !authorization.groups.has(subject.chatId)) return "group " + subject.chatId + " is not in groupAllowlist";
}
/**
* Whether one card click may settle an approval. With no configured
* approvers, whoever may drive that chat may also answer it.
* @param authorization - the channel's authorization rules.
* @param click - the clicking operator and the chat the click came from.
* @param pending - the chat the approval card was published to, and its kind.
* @returns the refusal reason, or undefined when the click counts.
*/
function refuseApprovalClick(authorization, click, pending) {
	if (click.chatId !== pending.chatId) return "click from chat " + click.chatId + " does not match the card's chat " + pending.chatId;
	if (click.operatorId === void 0) return "the click carries no operator id";
	if (authorization.approvers.size > 0) return authorization.approvers.has(click.operatorId) ? void 0 : "operator " + click.operatorId + " is not in approvers";
	return refuseMessage(authorization, {
		senderId: click.operatorId,
		chatId: pending.chatId,
		chatType: pending.chatType
	});
}
//#endregion
//#region src/presentation/markdown.ts
/** Structure-aware Markdown preparation for Feishu cards. */
const FENCE_START = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_SEPARATOR = /^:?-{3,}:?$/;
const LIST_START = /^ {0,3}(?:[-+*]|\d{1,4}\.)\s+/;
const THINK_TAGS = [
	"<think>",
	"</think>",
	"<thinking>",
	"</thinking>"
];
const THINK_TAG = /<\/?think(?:ing)?>/gi;
const TABLE_COMPACT_NOTE = "> 后续表格已转换为紧凑字段列表，以兼容飞书卡片限制；内容完整保留。";
const TABLE_TRUNCATE_NOTE = "> 内容含超过 5 个表格，超出部分已省略。";
function linesOf(text) {
	return text.match(/.*(?:\n|$)/g)?.filter((line) => line !== "") ?? [];
}
function lineText(line) {
	return line.replace(/\r?\n$/, "");
}
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function fenceStart(line) {
	const match = FENCE_START.exec(lineText(line));
	if (match === null) return void 0;
	return {
		marker: match[1],
		info: match[2].trim()
	};
}
function closesFence(line, marker) {
	return new RegExp("^ {0,3}" + escapeRegExp(marker[0]) + "{" + marker.length + ",}\\s*$").test(lineText(line));
}
/** Parse one Markdown table row while respecting escapes and inline-code spans. */
function parseTableRow(row) {
	const source = row.trim();
	if (source === "") return void 0;
	const cells = [];
	let cell = "";
	let delimiters = 0;
	let codeRun = 0;
	let cursor = 0;
	while (cursor < source.length) {
		const character = source[cursor];
		if (character === "\\" && cursor + 1 < source.length) {
			cell += source.slice(cursor, cursor + 2);
			cursor += 2;
			continue;
		}
		if (character === "`") {
			let end = cursor + 1;
			while (source[end] === "`") end += 1;
			const run = end - cursor;
			cell += source.slice(cursor, end);
			codeRun = codeRun === 0 ? run : codeRun === run ? 0 : codeRun;
			cursor = end;
			continue;
		}
		if (character === "|" && codeRun === 0) {
			cells.push(cell.trim());
			cell = "";
			delimiters += 1;
			cursor += 1;
			continue;
		}
		cell += character;
		cursor += 1;
	}
	cells.push(cell.trim());
	if (delimiters === 0) return void 0;
	if (source.startsWith("|")) cells.shift();
	if (source.endsWith("|")) cells.pop();
	return cells.length === 0 ? void 0 : cells;
}
function tableAt(lines, index) {
	if (index + 1 >= lines.length) return void 0;
	const headers = parseTableRow(lineText(lines[index]));
	const separator = parseTableRow(lineText(lines[index + 1]));
	if (headers === void 0 || separator === void 0 || headers.length !== separator.length || !separator.every((cell) => TABLE_SEPARATOR.test(cell.trim()))) return void 0;
	return {
		headers,
		rows: []
	};
}
/** Scan source Markdown into explicit blocks while preserving every byte. */
function scanMarkdown(text) {
	if (text === "") return [{
		kind: "prose",
		text: "",
		start: 0,
		end: 0
	}];
	const lines = linesOf(text);
	const offsets = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length;
	}
	const blocks = [];
	let proseStart = 0;
	let prose = [];
	const flushProse = (end) => {
		if (prose.length === 0) return;
		blocks.push({
			kind: "prose",
			text: prose.join(""),
			start: proseStart,
			end
		});
		prose = [];
	};
	let index = 0;
	while (index < lines.length) {
		const opening = fenceStart(lines[index]);
		if (opening !== void 0) {
			flushProse(offsets[index]);
			const start = offsets[index];
			const region = [lines[index]];
			index += 1;
			while (index < lines.length) {
				const line = lines[index];
				region.push(line);
				index += 1;
				if (closesFence(line, opening.marker)) break;
			}
			const value = region.join("");
			blocks.push({
				kind: "fence",
				text: value,
				start,
				end: start + value.length
			});
			continue;
		}
		const parsedTable = tableAt(lines, index);
		if (parsedTable !== void 0) {
			flushProse(offsets[index]);
			const start = offsets[index];
			const region = [lines[index], lines[index + 1]];
			const rows = [];
			index += 2;
			while (index < lines.length) {
				const row = parseTableRow(lineText(lines[index]));
				if (row === void 0) break;
				region.push(lines[index]);
				rows.push(row);
				index += 1;
			}
			const value = region.join("");
			blocks.push({
				kind: "table",
				text: value,
				start,
				end: start + value.length,
				table: {
					headers: parsedTable.headers,
					rows
				}
			});
			continue;
		}
		if (LIST_START.test(lineText(lines[index]))) {
			flushProse(offsets[index]);
			const start = offsets[index];
			const region = [];
			while (index < lines.length) {
				const line = lines[index];
				const raw = lineText(line);
				if (!LIST_START.test(raw) && !/^ {2,}\S/.test(raw)) break;
				region.push(line);
				index += 1;
			}
			const value = region.join("");
			blocks.push({
				kind: "list",
				text: value,
				start,
				end: start + value.length
			});
			continue;
		}
		if (prose.length === 0) proseStart = offsets[index];
		prose.push(lines[index]);
		index += 1;
	}
	flushProse(text.length);
	return blocks.length === 0 ? [{
		kind: "prose",
		text,
		start: 0,
		end: text.length
	}] : blocks;
}
function stripInlineCodeLine(line) {
	let output = "";
	let cursor = 0;
	while (cursor < line.length) {
		if (line[cursor] !== "`" || line[cursor - 1] === "\\") {
			output += line[cursor];
			cursor += 1;
			continue;
		}
		let markerEnd = cursor + 1;
		while (line[markerEnd] === "`") markerEnd += 1;
		const marker = line.slice(cursor, markerEnd);
		const closing = line.indexOf(marker, markerEnd);
		if (closing < 0) {
			output += marker;
			cursor = markerEnd;
			continue;
		}
		output += line.slice(markerEnd, closing);
		cursor = closing + marker.length;
	}
	return output;
}
/** Remove inline-code styling outside fenced code blocks. */
function stripInlineCode(text) {
	return scanMarkdown(text).map((block) => block.kind === "fence" ? block.text : linesOf(block.text).map(stripInlineCodeLine).join("")).join("");
}
function expandInlineNumbering(line) {
	const first = /^ {0,3}(\d{1,4})\.\s+/.exec(line);
	if (first === null) return line;
	let expected = Number(first[1]) + 1;
	let contiguous = true;
	return line.replace(/、\s*(\d{1,4})\.\s+/g, (source, numberText) => {
		if (!contiguous || Number(numberText) !== expected) {
			contiguous = false;
			return source;
		}
		expected += 1;
		return "\n" + numberText + ". ";
	});
}
function normalizeInlineNumbering(text) {
	return scanMarkdown(text).map((block) => block.kind === "fence" || block.kind === "table" ? block.text : linesOf(block.text).map(expandInlineNumbering).join("")).join("");
}
function unwrapInventory(block) {
	const lines = linesOf(block);
	if (lines.length < 3) return block;
	const opening = fenceStart(lines[0]);
	if (opening === void 0 || ![
		"",
		"text",
		"plaintext",
		"txt"
	].includes(opening.info.toLowerCase())) return block;
	if (!closesFence(lines.at(-1), opening.marker)) return block;
	const items = /* @__PURE__ */ new Map();
	for (const line of lines.slice(1, -1)) {
		const row = lineText(line).trim();
		if (row === "") continue;
		const match = /^(\d{1,4})[.)]?\s+(\S+)(?:\s+(\d{1,4})[.)]?\s+(\S+))?$/.exec(row);
		if (match === null) return block;
		const pairs = [[match[1], match[2]], ...match[3] === void 0 ? [] : [[match[3], match[4]]]];
		for (const [rawNumber, label] of pairs) {
			const number = Number(rawNumber);
			if (items.has(number)) return block;
			items.set(number, label);
		}
	}
	if (items.size < 4) return block;
	const ordered = [...items].sort(([left], [right]) => left - right);
	const firstNumber = ordered[0][0];
	if (!ordered.every(([number], index) => number === firstNumber + index)) return block;
	return ordered.map(([number, label]) => number + ". " + label).join("\n") + (block.endsWith("\n") ? "\n" : "");
}
function normalizeInventoryFences(text) {
	return scanMarkdown(text).map((block) => block.kind === "fence" ? unwrapInventory(block.text) : block.text).join("");
}
/** Apply all visual Markdown normalizations used by reply and command cards. */
function normalizeMarkdownForCard(text) {
	return stripInlineCode(normalizeInlineNumbering(normalizeInventoryFences(text)));
}
/** Count actual Markdown tables, excluding fenced examples. */
function countMarkdownTables(text) {
	return scanMarkdown(text).filter((block) => block.kind === "table").length;
}
function tableHeaders(headers, columns) {
	const seen = /* @__PURE__ */ new Map();
	return Array.from({ length: columns }, (_, index) => {
		const base = headers[index]?.trim() || "Column " + (index + 1);
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return count === 1 ? base : base + " (" + count + ")";
	});
}
function compactTable(table, tableNumber) {
	const columns = Math.max(table.headers.length, ...table.rows.map((row) => row.length));
	const headers = tableHeaders(table.headers, columns);
	if (table.rows.length === 0) return "**Table " + tableNumber + "**\n- Columns: " + headers.join(", ") + "\n- Rows: （空）\n\n";
	return table.rows.map((row, rowIndex) => ["**Table " + tableNumber + " · Row " + (rowIndex + 1) + "**", ...headers.map((header, column) => "- " + header + ": " + (row[column] ?? ""))].join("\n")).join("\n\n") + "\n\n";
}
/** Compact or truncate Markdown tables beyond the allowed count. */
function applyTableOverflow(text, options = { mode: "compact" }) {
	const maxTables = Math.max(0, Math.floor(options.maxTables ?? 5));
	const blocks = scanMarkdown(text);
	const sourceTableCount = blocks.filter((block) => block.kind === "table").length;
	const overflow = Math.max(0, sourceTableCount - maxTables);
	if (overflow === 0) return {
		text,
		sourceTableCount,
		compactedTableCount: 0,
		truncatedTableCount: 0
	};
	let tableNumber = 0;
	let wroteNote = false;
	const output = [];
	for (const block of blocks) {
		if (block.kind !== "table") {
			output.push(block.text);
			continue;
		}
		tableNumber += 1;
		if (tableNumber <= maxTables) {
			output.push(block.text);
			continue;
		}
		if (!wroteNote) {
			output.push((options.mode === "compact" ? TABLE_COMPACT_NOTE : TABLE_TRUNCATE_NOTE) + "\n\n");
			wroteNote = true;
		}
		if (options.mode === "compact" && block.table !== void 0) output.push(compactTable(block.table, tableNumber));
	}
	return {
		text: output.join(""),
		sourceTableCount,
		compactedTableCount: options.mode === "compact" ? overflow : 0,
		truncatedTableCount: options.mode === "truncate" ? overflow : 0
	};
}
function splitPlain(text, maxChars) {
	const chunks = [];
	let remaining = text;
	while (remaining.length > maxChars) {
		const window = remaining.slice(0, maxChars + 1);
		const newline = window.lastIndexOf("\n");
		const space = window.lastIndexOf(" ");
		const boundary = Math.max(newline >= 0 ? newline + 1 : 0, space >= 0 ? space + 1 : 0);
		const size = boundary > 0 ? boundary : maxChars;
		chunks.push(remaining.slice(0, size));
		remaining = remaining.slice(size);
	}
	if (remaining !== "" || chunks.length === 0) chunks.push(remaining);
	return chunks;
}
function wrapFence(opening, body, closing) {
	return opening + body + (body === "" || body.endsWith("\n") ? "" : "\n") + closing;
}
function splitFence(block, maxChars) {
	const lines = linesOf(block);
	const openingInfo = fenceStart(lines[0] ?? "");
	if (openingInfo === void 0) return splitPlain(block, maxChars);
	const opening = lines[0].endsWith("\n") ? lines[0] : lines[0] + "\n";
	const hasClosing = lines.length > 1 && closesFence(lines.at(-1), openingInfo.marker);
	const closing = hasClosing ? lines.at(-1).endsWith("\n") ? lines.at(-1) : lines.at(-1) + "\n" : openingInfo.marker + "\n";
	const body = (hasClosing ? lines.slice(1, -1) : lines.slice(1)).join("");
	const capacity = maxChars - opening.length - closing.length;
	if (capacity < 1) return [block];
	return splitPlain(body, capacity).map((part) => wrapFence(opening, part, closing));
}
function formatTableRow(cells) {
	return "| " + cells.map((cell) => cell.trim()).join(" | ") + " |\n";
}
function splitOversizedRow(row, maxChars) {
	const cells = parseTableRow(lineText(row));
	if (cells === void 0) return splitPlain(row, maxChars);
	let target = 0;
	for (let index = 1; index < cells.length; index += 1) if (cells[index].length > cells[target].length) target = index;
	const firstTemplate = [...cells];
	firstTemplate[target] = "";
	const continuationTemplate = cells.map(() => "");
	const firstCapacity = maxChars - formatTableRow(firstTemplate).length;
	const continuationCapacity = maxChars - formatTableRow(continuationTemplate).length;
	if (firstCapacity < 1 || continuationCapacity < 1) return [row];
	const output = [];
	let remaining = cells[target];
	let first = true;
	while (remaining !== "") {
		const capacity = first ? firstCapacity : continuationCapacity;
		const piece = remaining.slice(0, capacity);
		remaining = remaining.slice(capacity);
		const rowCells = first ? [...cells] : cells.map(() => "");
		rowCells[target] = piece;
		output.push(formatTableRow(rowCells));
		first = false;
	}
	return output;
}
function splitTable(block, maxChars) {
	const lines = linesOf(block);
	if (lines.length <= 2) return [block];
	const header = lines.slice(0, 2).join("");
	if (header.length >= maxChars) return [block];
	const rowBudget = maxChars - header.length;
	const rows = lines.slice(2).flatMap((row) => row.length > rowBudget ? splitOversizedRow(row, rowBudget) : [row]);
	const chunks = [];
	let body = "";
	for (const row of rows) {
		if (body !== "" && body.length + row.length > rowBudget) {
			chunks.push(header + body);
			body = "";
		}
		if (row.length > rowBudget) {
			if (body !== "") {
				chunks.push(header + body);
				body = "";
			}
			chunks.push(header + row);
			continue;
		}
		body += row;
	}
	if (body !== "" || chunks.length === 0) chunks.push(header + body);
	return chunks;
}
/** Split Markdown to size while re-closing fences and repeating table headers. */
function splitMarkdown(text, maxChars) {
	if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");
	if (text === "" || text.length <= maxChars) return [text];
	const chunks = [];
	let plain = "";
	const flushPlain = () => {
		if (plain !== "") chunks.push(plain);
		plain = "";
	};
	for (const block of scanMarkdown(text)) {
		if (block.kind === "fence" || block.kind === "table") {
			flushPlain();
			chunks.push(...block.kind === "fence" ? splitFence(block.text, maxChars) : splitTable(block.text, maxChars));
			continue;
		}
		for (const piece of splitPlain(block.text, maxChars)) {
			if (plain !== "" && plain.length + piece.length > maxChars) flushPlain();
			plain += piece;
			if (plain.length >= maxChars) flushPlain();
		}
	}
	flushPlain();
	return chunks.length === 0 ? [""] : chunks;
}
/** Stateful filter for think tags split across model stream chunks. */
var MarkdownStreamFilter = class {
	suffix = "";
	push(delta) {
		const combined = this.suffix + delta;
		const lower = combined.toLowerCase();
		let held = 0;
		for (const tag of THINK_TAGS) for (let size = 1; size < tag.length; size += 1) if (lower.endsWith(tag.slice(0, size))) held = Math.max(held, size);
		this.suffix = held === 0 ? "" : combined.slice(-held);
		return combined.slice(0, combined.length - held).replace(THINK_TAG, "");
	}
};
//#endregion
//#region src/command-card.ts
/** Keep a command result inside one interactive card's practical text budget. */
const COMMAND_RESULT_MAX_CHARS = 6e3;
/** Marker distinguishing command-card callbacks from other card actions. */
const COMMAND_INTERACTION_ACTION = "dsh-feishu-channel/command-interaction";
/** Form field carrying one command's free-form argument text. */
const COMMAND_INPUT_NAME = "command_input";
const COMMAND_FORM_ACTION_PREFIX = "dsh_command_submit_";
/** Narrow an arbitrary card value to this plugin's command interaction. */
function commandInteractionActionValue(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (record.kind !== "dsh-feishu-channel/command-interaction" || typeof record.id !== "string") return void 0;
	if (record.action !== "open" && record.action !== "run" && record.action !== "cancel") return void 0;
	return {
		kind: COMMAND_INTERACTION_ACTION,
		id: record.id,
		action: record.action
	};
}
/** Encode one unguessable pending id into a CardKit form-submit button name. */
function commandFormActionName(id) {
	return COMMAND_FORM_ACTION_PREFIX + id;
}
/** Recover a pending id only from this plugin's form-submit namespace. */
function commandFormActionId(name) {
	if (typeof name !== "string" || !name.startsWith(COMMAND_FORM_ACTION_PREFIX)) return void 0;
	const id = name.slice(19);
	return id === "" ? void 0 : id;
}
function normalizedResult(text) {
	const normalized = normalizeMarkdownForCard(text.replace(/^(?:✅|⚠️|⏹)\s*/, "")).trim();
	if (normalized === "") return "命令已执行。";
	return normalized.length <= COMMAND_RESULT_MAX_CHARS ? normalized : normalized.slice(0, 5988) + "\n\n内容已截断。";
}
function outcomeLook(outcome) {
	switch (outcome.status) {
		case "success": return {
			status: "已完成",
			tone: "success"
		};
		case "failure": return {
			status: "失败",
			tone: "failure"
		};
		default: return {
			status: "提示",
			tone: "info"
		};
	}
}
/** Render one command's result without falling back to a naked chat message. */
function commandResultCard(command, outcome) {
	const look = outcomeLook(outcome);
	return interactiveCard([
		interactiveStatusLine("命令执行", look.status, look.tone),
		interactiveDivider(),
		interactiveFieldRow("命令", "/" + command),
		{
			tag: "div",
			text: {
				tag: "lark_md",
				content: normalizedResult(outcome.reply)
			}
		}
	]);
}
/** Render every available command as one native selector. */
function commandHelpCard(commands, id) {
	return interactiveCard([
		interactiveStatusLine("命令中心", "可用", "info"),
		interactiveDivider(),
		{
			tag: "action",
			actions: [{
				tag: "select_static",
				placeholder: {
					tag: "plain_text",
					content: "选择命令"
				},
				options: commands.map((command) => ({
					text: {
						tag: "plain_text",
						content: ("/" + command.name + " · " + command.description).slice(0, 120)
					},
					value: command.name
				})),
				value: {
					kind: COMMAND_INTERACTION_ACTION,
					id,
					action: "open"
				}
			}]
		},
		{
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: "选择后将在当前卡片中打开对应操作。"
			}]
		}
	]);
}
/** Render one host descriptor as a confirmation card or free-text form. */
function commandPromptCard(command, id) {
	const interaction = command.input === void 0 ? {
		tag: "action",
		actions: [{
			tag: "button",
			text: {
				tag: "plain_text",
				content: commandActionLabel(command.name)
			},
			type: "primary",
			value: {
				kind: COMMAND_INTERACTION_ACTION,
				id,
				action: "run"
			}
		}, {
			tag: "button",
			text: {
				tag: "plain_text",
				content: "取消"
			},
			type: "default",
			value: {
				kind: COMMAND_INTERACTION_ACTION,
				id,
				action: "cancel"
			}
		}]
	} : {
		tag: "form",
		name: "dsh_command_form",
		elements: [{
			tag: "input",
			element_id: COMMAND_INPUT_NAME,
			name: COMMAND_INPUT_NAME,
			input_type: "text",
			placeholder: {
				tag: "plain_text",
				content: command.input.hint.slice(0, 120)
			},
			width: "fill",
			required: false
		}, {
			tag: "button",
			text: {
				tag: "plain_text",
				content: "执行"
			},
			type: "primary",
			width: "default",
			form_action_type: "submit",
			name: commandFormActionName(id)
		}]
	};
	return interactiveCard([
		interactiveStatusLine("命令确认", command.input === void 0 ? "待确认" : "待输入", "warning"),
		interactiveDivider(),
		interactiveFieldRow("命令", "/" + command.name),
		interactiveFieldRow("作用", command.description),
		interaction
	]);
}
/** Replace a dismissed prompt with a terminal, inert card. */
function cancelledCommandCard(command) {
	return interactiveCard([
		interactiveStatusLine("命令确认", "已取消", "neutral"),
		interactiveDivider(),
		interactiveFieldRow("命令", "/" + command)
	]);
}
function commandActionLabel(name) {
	switch (name) {
		case "new": return "新建会话";
		case "reset": return "重置会话";
		case "stop": return "停止任务";
		default: return "执行命令";
	}
}
//#endregion
//#region src/model-catalog.ts
/** Stable provider/model label used in command output and card options. */
function route(selection) {
	return selection.provider + "/" + selection.model;
}
/** Flatten the advisory directory without losing provider identity. */
function catalog(directory) {
	return directory.groups.flatMap((group) => group.models.map((model) => ({
		provider: group.id,
		model
	})));
}
/** The current model's advertised metadata, when it appears in the advisory directory. */
function currentModel(directory) {
	return directory.groups.find((group) => group.id === directory.current.provider)?.models.find((model) => model.id === directory.current.model);
}
const RESET_COMMAND = "reset";
const STOP_COMMAND = "stop";
const HELP_COMMAND = "help";
const MODEL_COMMAND = "model";
const EFFORT_COMMAND = "effort";
/** Commands owned by this channel, shared by help and slash-panel sync. */
const CHANNEL_COMMANDS = [
	channelCommand("new", "新建会话"),
	channelCommand(RESET_COMMAND, "重置会话"),
	channelCommand(STOP_COMMAND, "停止当前任务"),
	channelCommand(MODEL_COMMAND, "查看或更换当前会话模型"),
	channelCommand(EFFORT_COMMAND, "调整当前会话推理强度"),
	channelCommand(HELP_COMMAND, "显示可用命令")
];
const COMMAND_SYNTAX = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*?))?\s*$/;
/** Parse one complete command line; surrounding non-command text is rejected. */
function parseCommandLine(text) {
	const source = text.trim();
	const match = COMMAND_SYNTAX.exec(source);
	if (match === null) return void 0;
	return Object.freeze({
		name: match[1].toLowerCase(),
		input: (match[2] ?? "").trim(),
		source
	});
}
/** Deduplicated directory shared by help cards and slash-panel sync. */
function commandCatalog(commands, agent) {
	const owned = new Set(CHANNEL_COMMANDS.map((command) => command.name));
	const hosted = (commands?.list(agent) ?? []).filter((command) => !owned.has(command.name));
	return [...new Map([...hosted, ...CHANNEL_COMMANDS].map((command) => [command.name, command])).values()];
}
function helpText(commands, agent) {
	return ["**可用命令**", ...commandCatalog(commands, agent).map((command) => "/" + command.name + " — " + command.description)].join("\n");
}
/** Execute a command that has already passed syntax parsing. */
async function executeCommand(command, context) {
	if (command.name === "stop") {
		context.agent.cancel("user");
		return success("⏹ 已停止当前任务。");
	}
	if (command.name === "help") return info(helpText(context.commands, context.agent));
	if (command.name === "model" || command.name === "effort") {
		if (context.models === void 0) return failure("⚠️ 当前部署没有会话模型控制服务。");
		return command.name === "model" ? executeModelCommand(command.input, context.agent, context.models) : executeEffortCommand(command.input, context.agent, context.models);
	}
	return executeHostCommand(command, context);
}
async function executeHostCommand(command, context) {
	if (context.commands === void 0) return failure("⚠️ 本部署没有组合命令运行时，/" + command.name + " 无法执行。");
	let execution;
	try {
		execution = await context.commands.execute(context.agent, command.source, [], context.signal);
	} catch (error) {
		return commandFailure(command.name, error);
	}
	if (execution === void 0) return failure("⚠️ 未知命令 /" + command.name + "。\n\n" + helpText(context.commands, context.agent));
	if (execution.result.kind === "error") return commandFailure(command.name, execution.result.text);
	return success(execution.result.text ?? "");
}
async function executeModelCommand(input, agent, models) {
	try {
		const directory = await models.inspect(agent.session.id);
		if (input === "") return info(modelChoices(directory));
		const matches = matchingModels(directory, input);
		if (matches.length === 0) return failure("⚠️ 找不到模型“" + input + "”。\n\n" + modelChoices(directory));
		if (matches.length > 1) return failure("⚠️ 模型 ID“" + input + "”属于多个提供方，请使用完整名称：\n" + matches.map((entry) => "- /model " + route({
			provider: entry.provider,
			model: entry.model.id
		})).join("\n"));
		const match = matches[0];
		const selected = await models.select(agent.session.id, {
			provider: match.provider,
			model: match.model.id,
			...match.model.reasoning?.defaultEffort === void 0 ? {} : { reasoningEffort: match.model.reasoning.defaultEffort }
		});
		return success("✅ 已切换模型：" + route(selected) + (selected.reasoningEffort === void 0 ? "" : "（推理强度：" + selected.reasoningEffort + "）"));
	} catch (error) {
		return commandFailure(MODEL_COMMAND, error);
	}
}
async function executeEffortCommand(input, agent, models) {
	try {
		const directory = await models.inspect(agent.session.id);
		const reasoning = currentModel(directory)?.reasoning;
		const choices = effortChoices(directory);
		if (input === "") return info(choices);
		if (reasoning === void 0) return failure("⚠️ 当前模型没有公布可调的推理强度。");
		const effort = input === "default" ? reasoning.defaultEffort : reasoning.efforts.find((candidate) => candidate.id === input)?.id;
		if (input !== "default" && effort === void 0) return failure("⚠️ 不支持推理强度“" + input + "”。\n\n" + choices);
		return success("✅ 推理强度已调整为：" + ((await models.select(agent.session.id, {
			provider: directory.current.provider,
			model: directory.current.model,
			...effort === void 0 ? {} : { reasoningEffort: effort }
		})).reasoningEffort ?? "默认"));
	} catch (error) {
		return commandFailure(EFFORT_COMMAND, error);
	}
}
function modelChoices(directory) {
	return choiceDocument(directory, "可选模型", catalog(directory).map((entry) => "- /model " + route({
		provider: entry.provider,
		model: entry.model.id
	}) + " — " + entry.model.name));
}
function effortChoices(directory) {
	return choiceDocument(directory, "可选强度", ["- /effort default — 使用模型默认值", ...(currentModel(directory)?.reasoning?.efforts ?? []).map((effort) => "- /effort " + effort.id + " — " + effort.name)]);
}
function choiceDocument(directory, title, choices) {
	return [
		"当前模型：" + route(directory.current),
		"当前推理强度：" + (directory.current.reasoningEffort ?? "默认"),
		"",
		"**" + title + "**",
		...choices
	].join("\n");
}
function channelCommand(name, description) {
	return {
		name,
		description
	};
}
function matchingModels(directory, input) {
	const entries = catalog(directory);
	const byRoute = entries.filter((entry) => route({
		provider: entry.provider,
		model: entry.model.id
	}) === input);
	return byRoute.length > 0 ? byRoute : entries.filter((entry) => entry.model.id === input);
}
function commandFailure(name, error) {
	const detail = error instanceof Error ? error.message : String(error);
	return failure("⚠️ 命令执行失败（/" + name + "）：" + detail);
}
function success(reply) {
	return {
		reply,
		status: "success"
	};
}
function info(reply) {
	return {
		reply,
		status: "info"
	};
}
function failure(reply) {
	return {
		reply,
		status: "failure"
	};
}
//#endregion
//#region src/host.ts
/** Narrow a session event to the active model request context. */
function isRequestContextEvent(event) {
	return event.type === "request/context";
}
/** Narrow a session event to the assembled assistant message for one step. */
function isAssistantMessageEvent(event) {
	return event.type === "assistant/message";
}
/** Narrow a session event to a closed turn boundary. */
function isTurnEndEvent(event) {
	return event.type === "turn/end";
}
/** Narrow a session event to one raw assistant stream chunk. */
function isAssistantChunkEvent(event) {
	return event.type === "assistant/chunk";
}
/** Narrow a session event to one completed tool call's result. */
function isToolResultEvent(event) {
	return event.type === "tool/result";
}
/** Narrow a session event to one model-requested tool invocation. */
function isToolCallEvent(event) {
	return event.type === "tool/call";
}
/** Join the text blocks of a committed assistant message. */
function assistantText(data) {
	return data.message.content.filter((block) => block.type === "text" && block.text !== void 0 && block.text !== "").map((block) => block.text).join("");
}
/** The model that produced a committed message, when the payload names it. */
function assistantModel(data) {
	const model = data.message.source?.model;
	return typeof model === "string" && model !== "" ? model : void 0;
}
/** The call one result answers. */
function toolResultCallId(data) {
	return data.message.content[0]?.toolCallId ?? data.message.source?.callId;
}
//#endregion
//#region src/images.ts
/** Streamed, size-bounded intake for images attached to a Feishu message. */
/** Download accepted images, commit bounded bytes, and always remove staging files. */
async function collectImages(message, port, attachments, enabled, signal) {
	const images = message.resources.filter((resource) => resource.type === "image");
	if (images.length === 0) return emptyCollection();
	if (!enabled) return noteOnly("（用户发送了 " + images.length + " 张图片，本渠道未向模型传递图片：attachImages 未开启）");
	if (attachments === void 0) return noteOnly("（用户发送了 " + images.length + " 张图片，但本部署没有组合附件存储，模型看不到它们）");
	if (isAborted$1(signal)) return emptyCollection();
	const stagingDir = await mkdtemp(join(tmpdir(), "dsh-feishu-images-"));
	const blocks = [];
	const notes = [];
	let remainingBytes = attachments.imageLimits.maxMessageImageBytes;
	try {
		for (const [index, image] of images.entries()) {
			if (isAborted$1(signal)) break;
			if (index >= attachments.imageLimits.maxImagesPerMessage) {
				notes.push("（还有 " + (images.length - index) + " 张图片超出单条消息上限，未附加）");
				break;
			}
			const path = join(stagingDir, String(index));
			try {
				const download = await port.downloadResourceToFile(message.messageId, image.fileKey, "image", path);
				if (isAborted$1(signal)) break;
				const mediaType = acceptedMediaType(download.contentType, image.fileName, attachments.imageLimits.mediaTypes);
				if (mediaType === void 0) {
					notes.push("（一张图片的格式 " + (download.contentType ?? "未知") + " 不被支持，未附加）");
					continue;
				}
				if (download.bytesWritten > attachments.imageLimits.maxImageBytes || download.bytesWritten > remainingBytes) {
					notes.push("（一张图片超出大小上限，未附加）");
					continue;
				}
				const bytesOnDisk = (await stat(path)).size;
				if (bytesOnDisk !== download.bytesWritten) throw new Error("下载大小校验失败");
				if (bytesOnDisk > attachments.imageLimits.maxImageBytes || bytesOnDisk > remainingBytes) {
					notes.push("（一张图片超出大小上限，未附加）");
					continue;
				}
				const data = await readFile(path);
				if (isAborted$1(signal)) break;
				const attachment = await attachments.saveImage({
					data,
					mediaType,
					...image.fileName === void 0 ? {} : { name: image.fileName }
				});
				remainingBytes -= data.byteLength;
				blocks.push({
					type: "image",
					attachment
				});
			} catch (error) {
				if (isAborted$1(signal)) break;
				notes.push("（一张图片附加失败：" + errorDetail$2(error) + "）");
			} finally {
				await rm(path, { force: true }).catch(() => void 0);
			}
		}
		return {
			blocks,
			notes
		};
	} finally {
		await rm(stagingDir, {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
}
function acceptedMediaType(contentType, fileName, accepted) {
	const declared = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	const extension = fileName?.split(".").at(-1)?.toLowerCase();
	return [declared, extension === void 0 ? void 0 : "image/" + (extension === "jpg" ? "jpeg" : extension)].find((candidate) => candidate !== void 0 && accepted.includes(candidate));
}
function errorDetail$2(error) {
	return error instanceof Error ? error.message : String(error);
}
function isAborted$1(signal) {
	return signal?.aborted === true;
}
function emptyCollection() {
	return {
		blocks: [],
		notes: []
	};
}
function noteOnly(note) {
	return {
		blocks: [],
		notes: [note]
	};
}
//#endregion
//#region src/presentation/cost.ts
/** Suffix marking a row billed at the off-peak rates. */
const OFF_PEAK_MARK = " ·空闲";
/**
* Render the 费用 disclosure-row value for one turn: reported usage times the
* configured per-million-token prices of the turn's model. When the model has
* `offPeak` rates and `atMs` falls inside one of the Beijing-time windows, the
* discounted rates apply and the row gains an 空闲 marker. An empty string
* means "no price covers this model" (or no usage yet), which the meta
* renderer omits — an absent row, never a blank one.
*/
function estimateCost(usage, pricing, model, atMs, windows) {
	const price = lookupPrice(pricing, model);
	if (usage === void 0 || price === void 0) return "";
	const { offPeak: discount } = price;
	const discounted = discount !== void 0 && atMs !== void 0 && inOffPeak(atMs, windows);
	return formatAmount(price.currency ?? "¥", amount(usage, discounted ? discount : price)) + (discounted ? OFF_PEAK_MARK : "");
}
/** Whether `atMs` falls inside any half-open Beijing-time window. */
function inOffPeak(atMs, windows) {
	if (windows === void 0 || windows.length === 0) return false;
	const minutes = beijingMinutesOfDay(atMs);
	return windows.some((window) => insideWindow(minutes, window));
}
function insideWindow(minutes, window) {
	const start = parseClock(window.start);
	const end = parseClock(window.end);
	if (start === void 0 || end === void 0 || start === end) return false;
	return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
function parseClock(value) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (match === null) return void 0;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return void 0;
	return hours * 60 + minutes;
}
/** Wall-clock minutes since midnight in Beijing (UTC+8), host timezone aside. */
function beijingMinutesOfDay(atMs) {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Shanghai",
		hourCycle: "h23",
		hour: "2-digit",
		minute: "2-digit"
	}).formatToParts(new Date(atMs));
	const hour = Number(parts.find((part) => part.type === "hour")?.value);
	const minute = Number(parts.find((part) => part.type === "minute")?.value);
	if (!Number.isInteger(hour) || !Number.isInteger(minute)) return -1;
	return hour * 60 + minute;
}
/** Exact model-id match first, then the segment after the last route slash. */
function lookupPrice(pricing, model) {
	const id = model.trim();
	if (id === "" || pricing === void 0) return void 0;
	return pricing[id] ?? pricing[id.split("/").pop() ?? ""];
}
function amount(usage, rates) {
	const hit = usage.cacheReadTokens ?? 0;
	const hitRate = rates.cacheHitInput ?? rates.input;
	return (usage.inputTokens * rates.input + hit * hitRate + usage.outputTokens * rates.output) / 1e6;
}
/** Two decimals from one unit up; up to four significant decimals below. */
function formatAmount(currency, value) {
	if (value >= 1) return currency + value.toFixed(2);
	const rounded = Number(value.toFixed(4));
	if (value > 0 && rounded === 0) return currency + "<0.0001";
	return currency + String(rounded);
}
const SAFE_CARD_JSON_BYTES = 28e3;
function isPlainObject(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/**
* Serialize and inspect a card through one JSON traversal. Unsupported or
* circular values are replaced only inside the temporary serialization and
* always make the verdict unsafe.
*/
function inspectCardBudget(card) {
	let elementCount = 0;
	let tableCount = 0;
	let serializationError = "";
	const ancestors = [];
	const reject = (reason) => {
		if (serializationError === "") serializationError = reason;
		return null;
	};
	let serialized = "";
	try {
		serialized = JSON.stringify(card, function(_key, value) {
			while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
			if (value === void 0) return reject("undefined_value");
			if (typeof value === "bigint") return reject("bigint_value");
			if (typeof value === "function") return reject("function_value");
			if (typeof value === "symbol") return reject("symbol_value");
			if (typeof value === "number" && !Number.isFinite(value)) return reject("non_finite_number");
			if (typeof value !== "object" || value === null) return value;
			if (ancestors.includes(value)) return reject("circular_reference");
			if (!Array.isArray(value) && !isPlainObject(value)) return reject("unsupported_object");
			ancestors.push(value);
			if (!Array.isArray(value)) {
				const record = value;
				if (typeof record.tag === "string") {
					elementCount += 1;
					if (record.tag === "table") tableCount += 1;
					else if (record.tag === "markdown" && typeof record.content === "string") tableCount += countMarkdownTables(record.content);
				}
			}
			return value;
		}) ?? "";
	} catch (error) {
		serializationError = serializationError || (error instanceof Error ? error.message : String(error));
	}
	const jsonBytes = Buffer.byteLength(serialized, "utf8");
	const violations = [
		[serializationError !== "", "unserializable"],
		[jsonBytes > SAFE_CARD_JSON_BYTES, "json_bytes"],
		[elementCount > 200, "elements"],
		[tableCount > 5, "tables"]
	].filter(([violated]) => violated).map(([, reason]) => reason);
	return {
		jsonBytes,
		elementCount,
		tableCount,
		violations,
		safe: violations.length === 0,
		primaryReason: violations[0] ?? "",
		serializationError
	};
}
//#endregion
//#region src/presentation/feishu-card.ts
/** Compose the frozen Feishu reply-card UI from one transport-free turn view. */
const CARD_TEXT_CHUNK = 2400;
const FAILURE_HEADING_LIMIT = 48;
const FAILURE_MESSAGE_LIMIT = 240;
const TOOL_LABEL_WIDTH = 72;
const SPINNER = {
	intervalMs: 120,
	frames: [
		"⠋",
		"⠙",
		"⠹",
		"⠸",
		"⠼",
		"⠴",
		"⠦",
		"⠧",
		"⠇",
		"⠏"
	]
};
const COLOR = {
	quiet: CARD_COLOR.grey,
	active: CARD_COLOR.blue,
	reasoning: CARD_COLOR.indigo,
	success: CARD_COLOR.green,
	failure: CARD_COLOR.red
};
const DEFAULT_META_FIELDS = [
	"duration",
	"model",
	"input_tokens",
	"output_tokens",
	"cost",
	"context"
];
/** Card-button payload marking this plugin's retry action. */
const RETRY_ACTION = "dsh-feishu-channel/retry";
/** Card-button payload marking this plugin's copy-error action. */
const COPY_ERROR_ACTION = "dsh-feishu-channel/copy-error";
/** Narrow an arbitrary card-action value to this plugin's retry payload. */
function isRetryAction(value) {
	return objectValue(value)?.kind === RETRY_ACTION;
}
/** Narrow an arbitrary card-action value to this plugin's copy-error payload. */
function isCopyErrorAction(value) {
	const payload = objectValue(value);
	return payload?.kind === "dsh-feishu-channel/copy-error" && typeof payload.text === "string";
}
/** Assemble a reply card, replacing an oversized result with the handoff card. */
function renderCard(view, options) {
	const candidate = composeReplyCard(view, options);
	const inspection = inspectCardBudget(candidate);
	if (inspection.safe) return {
		card: candidate,
		disposition: "card",
		inspection,
		limitReason: ""
	};
	return {
		card: renderHandoffCard(isTerminal(view.status)),
		disposition: "native",
		inspection,
		limitReason: inspection.primaryReason
	};
}
/** Return one stable spinner frame for an integer index. */
function spinnerFrame(index) {
	const bounded = Math.max(0, Math.trunc(index));
	return SPINNER.frames[bounded % SPINNER.frames.length];
}
/** Derive the spinner frame from elapsed time without retaining timer state. */
function spinnerFrameIndex(elapsedMs) {
	return Math.floor(Math.max(0, elapsedMs) / SPINNER.intervalMs);
}
/** Format a live elapsed time in the same notation as terminal duration. */
function formatClock(elapsedMs) {
	return formatDuration(elapsedMs / 1e3);
}
/** Format a local wall-clock time without seconds. */
function formatWallClock(ms) {
	return localTime(ms, false);
}
/** Format a local wall-clock time with seconds for timeline rows. */
function formatStepTime(ms) {
	return localTime(ms, true);
}
function composeReplyCard(view, options) {
	const now = Date.now();
	const renderedAt = isTerminal(view.status) ? view.finishedAt ?? now : now;
	const elapsed = now - view.startedAt;
	const meta = collectCardMeta(view, options.footerFields, options.pricing, options.offPeakWindows, renderedAt);
	return cardDocument([
		composeStatusDisclosure(view.status, formatWallClock(renderedAt), meta),
		divider("head_divider", "0px -16px 0px -16px"),
		...composeStatePanel(view, options, spinnerFrameIndex(elapsed))
	], SPACE_4, "0px 16px 14px 16px");
}
function composeStatePanel(view, options, frame) {
	switch (view.status) {
		case "completed": return composeCompletedPanel(view, options);
		case "failed": return composeFailedPanel(view, options);
		default: return composeLoadingPanel(view, options, frame);
	}
}
function composeLoadingPanel(view, options, frame) {
	const panel = [markdown("main_content", spinnerFrame(frame) + " **正在分析**", "heading")];
	if (options.showProcess && (view.steps.length > 0 || view.status === "in_progress")) {
		const activity = composeLiveActivity(view, options, frame);
		if (activity !== void 0) panel.push(activity);
	}
	panel.push(composeLoadingSkeleton());
	return panel;
}
function composeCompletedPanel(view, options) {
	const panel = view.answerText === "" ? [] : composeAnswer(view.answerText, options);
	if (!options.showProcess) return panel.length === 0 ? [emptyAnswer()] : panel;
	if (panel.length > 0) panel.push(divider("main_divider"));
	panel.push(composeAnalysisDisclosure(view, options));
	return panel;
}
function composeFailedPanel(view, options) {
	const panel = view.answerText === "" ? [] : composeMarkdown(view.answerText, options);
	if (panel.length > 0) panel.push(divider("main_divider"));
	panel.push(composeFailureHeading(view), composeFailureBox(view), composeFailureActions(view));
	return panel;
}
function composeAnswer(text, options) {
	const partition = partitionAnswer(stripInlineCode(text));
	const nodes = [];
	if (partition.heading !== "") nodes.push(markdown("answer_title", "**" + partition.heading + "**", "heading"));
	if (partition.primary !== "") nodes.push(...composeMarkdown(partition.primary, options));
	if (partition.details !== "") nodes.push(simpleDisclosure("answer_details", "**详细说明**", [markdown("answer_details_text", partition.details, "normal")]));
	return nodes;
}
/** Split answer content around the preferred conclusion and optional details heading. */
function partitionAnswer(input) {
	const source = input.replace(/\r\n/g, "\n").trim();
	const headings = headingBoundaries(source);
	if (headings.length === 0) return {
		heading: "",
		primary: source,
		details: ""
	};
	const conclusion = headings.find((item) => /(?:最终|核心|明确)结论/.test(plainLabel(item.label))) ?? headings[0];
	const conclusionIndex = headings.indexOf(conclusion);
	const conclusionEnd = headings.slice(conclusionIndex + 1).find((item) => item.depth <= conclusion.depth)?.start ?? source.length;
	let primary = source.slice(conclusion.contentStart, conclusionEnd).trim();
	let details = "";
	if (conclusionIndex === 0) primary = joinText(primary, source.slice(conclusionEnd));
	else details = joinText(source.slice(0, conclusion.start), source.slice(conclusionEnd));
	const detailsHeading = headingBoundaries(primary).find((item) => /^(?:详细说明|详细证据|证据与细节)$/.test(plainLabel(item.label)));
	if (detailsHeading !== void 0) {
		details = joinText(details, primary.slice(detailsHeading.contentStart));
		primary = primary.slice(0, detailsHeading.start).trim();
	}
	return {
		heading: conclusion.label,
		primary,
		details
	};
}
/** Find ATX headings only inside prose blocks, so fenced code never becomes structure. */
function headingBoundaries(source) {
	const boundaries = [];
	const pattern = /^ {0,3}(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/gm;
	for (const block of scanMarkdown(source)) {
		if (block.kind !== "prose") continue;
		for (const match of block.text.matchAll(pattern)) {
			const relative = match.index;
			const full = match[0];
			const marks = match[1];
			const label = match[2];
			if (relative === void 0 || full === void 0 || marks === void 0 || label === void 0) continue;
			const start = block.start + relative;
			boundaries.push({
				start,
				contentStart: start + full.length,
				depth: marks.length,
				label: label.trim()
			});
		}
	}
	return boundaries.sort((left, right) => left.start - right.start);
}
function plainLabel(value) {
	return value.replace(/<[^>]+>/g, "").replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();
}
function joinText(...parts) {
	return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}
function composeStatusDisclosure(status, clock, meta) {
	const visual = statusVisual(status);
	return {
		tag: "collapsible_panel",
		element_id: "card_head",
		expanded: false,
		direction: "vertical",
		margin: "5px 0px 5px 0px",
		padding: "0px",
		vertical_spacing: "4px",
		header: {
			title: {
				tag: "markdown",
				content: [
					clock,
					meta.duration,
					statusTag(visual.label, visual.tone)
				].join(" · "),
				text_size: "notation"
			},
			width: "fill",
			vertical_align: "center",
			padding: "0px",
			icon: disclosureIcon(),
			icon_position: "right",
			icon_expanded_angle: -180
		},
		elements: [composeMetaRows(meta.rows)]
	};
}
function composeMetaRows(rows) {
	const column = (side) => ({
		tag: "column",
		width: side === "label" ? "auto" : "weighted",
		...side === "value" ? { weight: 1 } : {},
		vertical_spacing: "3px",
		elements: rows.map((row) => side === "label" ? metaLabel(row) : metaValue(row))
	});
	return {
		tag: "column_set",
		element_id: "head_details",
		flex_mode: "none",
		horizontal_spacing: "8px",
		margin: "1px 0px 3px 0px",
		columns: [column("label"), column("value")]
	};
}
function metaLabel(row) {
	return {
		tag: "div",
		text: plainText(row.label, {
			text_size: "notation",
			text_color: COLOR.quiet,
			lines: 1
		})
	};
}
function metaValue(row) {
	return {
		tag: "div",
		element_id: "head_" + row.id,
		width: "fill",
		text: plainText(row.value, {
			text_size: "notation",
			text_color: COLOR.quiet,
			text_align: "right",
			lines: 1
		})
	};
}
function statusVisual(status) {
	return {
		thinking: {
			label: "处理中",
			tone: "neutral"
		},
		in_progress: {
			label: "处理中",
			tone: "neutral"
		},
		completed: {
			label: "已完成",
			tone: "success"
		},
		failed: {
			label: "失败",
			tone: "failure"
		}
	}[status];
}
/** Turn Markdown into separately spaced CardKit blocks without losing structure. */
function composeMarkdown(text, options) {
	const boundedTables = applyTableOverflow(normalizeMarkdownForCard(text), { mode: options.tableOverflowMode }).text;
	const groups = [];
	for (const block of scanMarkdown(boundedTables)) {
		const previous = groups.at(-1);
		if (block.kind === "list" && previous !== void 0 && !/\n\s*\n$/.test(previous)) groups[groups.length - 1] = previous + block.text;
		else groups.push(block.text);
	}
	const chunks = groups.filter((group) => group.trim() !== "").flatMap((group) => group.length <= CARD_TEXT_CHUNK ? [group] : splitMarkdown(group, CARD_TEXT_CHUNK));
	return (chunks.length === 0 ? splitMarkdown(boundedTables, CARD_TEXT_CHUNK) : chunks).map((content, index) => markdown(index === 0 ? "main_content" : "main_content_" + index, content));
}
function composeLoadingSkeleton() {
	return {
		tag: "column_set",
		element_id: "loading_skeleton",
		flex_mode: "none",
		horizontal_spacing: "0px",
		margin: "14px 0px 0px 0px",
		columns: [{
			tag: "column",
			width: "weighted",
			weight: 1,
			vertical_spacing: "8px",
			elements: [
				[5, 1],
				[3, 2],
				[2, 3]
			].map(([bar, space], index) => skeletonRow(index + 1, bar, space))
		}]
	};
}
function skeletonRow(index, barWeight, spaceWeight) {
	const segment = (weight, filled) => ({
		tag: "column",
		width: "weighted",
		weight,
		...filled ? {
			background_style: COLOR.quiet,
			padding: "6px 0px 6px 0px"
		} : {},
		elements: []
	});
	return {
		tag: "column_set",
		element_id: "skeleton_bar_" + index,
		flex_mode: "none",
		horizontal_spacing: "0px",
		columns: [segment(barWeight, true), segment(spaceWeight, false)]
	};
}
function composeLiveActivity(view, options, frame) {
	const lines = timelineLines(view.steps, options, frame, true);
	return lines.length === 0 ? void 0 : markdown("live_steps", lines.join("\n"), "small");
}
function timelineLines(steps, options, frame, appendNextStep) {
	const visible = steps.slice(-options.maxTimelineItems);
	const hidden = steps.length - visible.length;
	const lines = hidden > 0 ? ["<font color=\"" + COLOR.quiet + "\">已折叠 " + hidden + " 条早期步骤</font>"] : [];
	lines.push(...visible.map((step) => timelineLine(step, options, frame)));
	if (appendNextStep) lines.push("<font color=\"" + COLOR.quiet + "\">下一步 · 生成回复</font>");
	return lines;
}
function timelineLine(step, options, frame) {
	const timestamp = formatStepTime(step.atMs);
	if (step.kind === "reasoning") return timestamp + " <font color=\"" + COLOR.reasoning + "\">**思考**</font> · " + step.status;
	const indicator = toolIndicator(step.status, frame);
	const label = boundedToolLabel(step, options);
	return timestamp + " <font color=\"" + indicator.color + "\">" + indicator.glyph + "</font> **" + escapeCardText(label) + "**";
}
function toolIndicator(status, frame) {
	const terminal = {
		completed: {
			glyph: "✓",
			color: COLOR.success
		},
		failed: {
			glyph: "✕",
			color: COLOR.failure
		}
	};
	return status === "running" ? {
		glyph: spinnerFrame(frame),
		color: COLOR.active
	} : terminal[status];
}
function boundedToolLabel(step, options) {
	const presented = compactLine(callTitle(options.presentCall, step.name, step.argumentsJson));
	const preferred = presented === "" ? compactLine(step.name) : presented;
	if (visualWidth(preferred) <= TOOL_LABEL_WIDTH) return preferred === "" ? "工具" : preferred;
	const rawName = compactLine(step.name);
	return rawName !== "" && visualWidth(rawName) <= TOOL_LABEL_WIDTH ? rawName : "执行工具";
}
function callTitle(presenter, name, argumentsJson) {
	if (presenter === void 0) return "";
	try {
		const title = presenter(name, argumentsJson)?.title;
		return typeof title === "string" ? title : "";
	} catch {
		return "";
	}
}
function visualWidth(value) {
	let width = 0;
	for (const character of value) width += /[^\u0000-\u00ff]/.test(character) ? 2 : 1;
	return width;
}
function composeAnalysisDisclosure(view, options) {
	const ordered = [...view.steps].sort((left, right) => left.atMs - right.atMs);
	const visible = ordered.slice(-options.maxTimelineItems);
	const hidden = ordered.length - visible.length;
	const content = [];
	if (hidden > 0) content.push(markdown("timeline_folded", "> 已折叠 " + hidden + " 条早期步骤", "x-small"));
	if (visible.length === 0) content.push(markdown("timeline_empty", "<font color=\"" + COLOR.quiet + "\">本轮直接生成回复</font>", "small"));
	else {
		const elapsed = (view.finishedAt ?? Date.now()) - view.startedAt;
		const lines = visible.map((step) => timelineLine(step, options, spinnerFrameIndex(elapsed)));
		content.push(markdown("timeline_steps", lines.join("\n"), "small"));
	}
	return {
		tag: "collapsible_panel",
		element_id: "analysis_timeline",
		expanded: options.timelineExpanded ?? false,
		margin: "0px",
		padding: "0px",
		vertical_spacing: "4px",
		header: {
			title: {
				tag: "markdown",
				content: "🔍 **分析过程**"
			},
			icon: disclosureIcon(),
			icon_position: "right",
			icon_expanded_angle: -180
		},
		elements: content
	};
}
function composeFailureHeading(view) {
	const reason = bounded(compactLine(view.errorMessage), FAILURE_HEADING_LIMIT);
	return markdown("failure_title", "**" + (reason === "" ? "分析失败" : "分析失败：" + escapeCardText(reason)) + "**", "heading");
}
function composeFailureBox(view) {
	const lines = [];
	if (view.errorCode !== "") lines.push("<font color=\"" + COLOR.failure + "\">**" + escapeCardText(view.errorCode) + "**</font>");
	const message = bounded(compactLine(view.errorMessage), FAILURE_MESSAGE_LIMIT);
	if (message !== "") lines.push(escapeCardText(message));
	lines.push("<font color=\"" + COLOR.quiet + "\">last attempt: " + failureTime(view) + "</font>");
	return {
		tag: "column_set",
		element_id: "failure_error_box",
		flex_mode: "none",
		background_style: COLOR.failure,
		horizontal_spacing: "0px",
		columns: [{
			tag: "column",
			width: "weighted",
			weight: 1,
			background_style: COLOR.failure,
			padding: "12px 8px 12px 8px",
			elements: [markdown("failure_error", lines.join("<br>"), "small")]
		}]
	};
}
function composeFailureActions(view) {
	const actionColumn = (id, label, type, value) => ({
		tag: "column",
		width: "auto",
		elements: [{
			tag: "button",
			element_id: id,
			text: plainText(label),
			type,
			width: "default",
			size: "medium",
			behaviors: [{
				type: "callback",
				value
			}]
		}]
	});
	return {
		tag: "column_set",
		element_id: "failure_actions",
		flex_mode: "none",
		horizontal_spacing: "8px",
		columns: [actionColumn("retry_button", "↻ 重试", "primary", { kind: RETRY_ACTION }), actionColumn("copy_error_button", "复制错误", "default", {
			kind: COPY_ERROR_ACTION,
			text: copyableError(view)
		})]
	};
}
function copyableError(view) {
	const parts = [];
	if (view.errorCode !== "") parts.push(view.errorCode);
	const message = bounded(compactLine(view.errorMessage), 120);
	if (message !== "") parts.push(message);
	parts.push("last attempt: " + failureTime(view));
	return parts.join(" · ");
}
function collectCardMeta(view, requested, pricing, offPeakWindows, renderedAt) {
	const duration = isTerminal(view.status) ? formatDuration(view.durationMs / 1e3) : formatClock(renderedAt - view.startedAt);
	const usage = view.usage;
	const inputTokens = usage?.inputTokens;
	const catalog = [
		{
			field: "duration",
			id: "duration",
			label: "耗时",
			value: duration
		},
		{
			field: "model",
			id: "model",
			label: "模型",
			value: view.model.trim()
		},
		{
			field: "input_tokens",
			id: "input",
			label: "输入 Token",
			value: inputTokens !== void 0 && inputTokens > 0 ? "↑" + formatCount(inputTokens) : ""
		},
		{
			field: "output_tokens",
			id: "output",
			label: "输出 Token",
			value: usage !== void 0 && usage.outputTokens > 0 ? "↓" + formatCount(usage.outputTokens) : ""
		},
		{
			field: "cost",
			id: "cost",
			label: "费用",
			value: estimateCost(usage, pricing, view.model, view.usageAtMs ?? view.startedAt, offPeakWindows)
		},
		{
			field: "context",
			id: "context",
			label: "ctx",
			value: formatContext(inputTokens, view.contextWindow)
		}
	];
	const fields = requested.length === 0 ? DEFAULT_META_FIELDS : requested;
	const rows = [];
	const included = /* @__PURE__ */ new Set();
	for (const field of fields) {
		const row = catalog.find((candidate) => candidate.field === field);
		if (row === void 0 || row.id === "duration" || row.value === "" || included.has(row.id)) continue;
		rows.push(row);
		included.add(row.id);
	}
	if (!included.has("context")) rows.push(catalog.find((row) => row.id === "context"));
	return {
		duration,
		rows
	};
}
function formatContext(used, capacity) {
	const safeUsed = used === void 0 ? void 0 : Math.max(0, used);
	const percent = safeUsed === void 0 || capacity === void 0 ? 0 : Math.min(100, Math.round(safeUsed / capacity * 100));
	return (safeUsed === void 0 ? "—" : formatCount(safeUsed)) + "/" + (capacity === void 0 ? "—" : formatCount(capacity)) + " · " + percent + "%";
}
/** Render seconds as a compact h/m/s duration. */
function formatDuration(seconds) {
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const remainder = total % 60;
	if (hours > 0) return hours + "h" + minutes + "m" + remainder + "s";
	if (minutes > 0) return minutes + "m" + remainder + "s";
	return remainder + "s";
}
/** Format a token count with compact decimal suffixes. */
function formatCount(value) {
	if (value < 1e3) return String(value);
	const factor = value >= 1e6 ? 1e6 : 1e3;
	const suffix = factor === 1e6 ? "m" : "k";
	const scaled = value / factor;
	if (scaled >= 100 || Number.isInteger(scaled)) return Math.round(scaled) + suffix;
	return scaled.toFixed(1).replace(/\.0$/, "") + suffix;
}
/** Build the compact card shown before native-message delivery. */
function renderHandoffCard(terminal) {
	const message = terminal ? "完整内容已切换为原生消息发送。" : "内容较长，完成后将由原生消息发送。";
	return cardDocument([
		cardKitStatusLine("handoff_status", "内容交付", terminal ? "已完成" : "生成中", terminal ? "success" : "warning"),
		divider("handoff_divider", "0px -16px 12px -16px"),
		markdown("main_content", message)
	], "0px", "0px 16px 14px 16px");
}
function simpleDisclosure(id, title, elements) {
	return {
		tag: "collapsible_panel",
		element_id: id,
		expanded: false,
		margin: "0px",
		padding: "8px 0px 0px 0px",
		vertical_spacing: "4px",
		header: {
			title: {
				tag: "markdown",
				content: title
			},
			padding: "0px"
		},
		elements
	};
}
function cardDocument(elements, spacing, padding) {
	return {
		schema: "2.0",
		config: {
			wide_screen_mode: true,
			update_multi: true
		},
		body: {
			direction: "vertical",
			vertical_spacing: spacing,
			padding,
			elements
		}
	};
}
function divider(id, margin) {
	return {
		tag: "hr",
		element_id: id,
		...margin === void 0 ? {} : { margin }
	};
}
function markdown(id, content, size) {
	return {
		tag: "markdown",
		element_id: id,
		content,
		...size === void 0 ? {} : { text_size: size }
	};
}
function plainText(content, extra = {}) {
	return {
		tag: "plain_text",
		content,
		...extra
	};
}
function disclosureIcon() {
	return {
		tag: "standard_icon",
		token: "down-small-ccm_outlined",
		color: COLOR.quiet,
		size: "14px 14px"
	};
}
function emptyAnswer() {
	return markdown("main_content", "<font color=\"" + COLOR.quiet + "\">—</font>", "x-small");
}
function bounded(value, limit) {
	return value.length <= limit ? value : value.slice(0, limit - 1) + "…";
}
function compactLine(value) {
	return value.replace(/\s+/g, " ").trim();
}
function escapeCardText(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function localTime(ms, includeSeconds) {
	const date = new Date(ms);
	return [
		date.getHours(),
		date.getMinutes(),
		...includeSeconds ? [date.getSeconds()] : []
	].map((value) => String(value).padStart(2, "0")).join(":");
}
function failureTime(view) {
	return formatStepTime(view.finishedAt ?? Date.now());
}
function isTerminal(status) {
	return status === "completed" || status === "failed";
}
function objectValue(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
//#endregion
//#region src/presentation/turn-view.ts
/**
* Fold host events into exactly the state consumed by the Feishu card.
* The first turn/end event seals the projection; later events are ignored.
*/
var TurnView = class {
	turn;
	status = "thinking";
	answerText = "";
	model = "";
	startedAt = Date.now();
	finishedAt;
	durationMs = 0;
	usage;
	/** When the usage-bearing message arrived: the billing-window anchor. */
	usageAtMs;
	contextWindow;
	errorCode = "";
	errorMessage = "";
	stepEntries = [];
	toolStepByCallId = /* @__PURE__ */ new Map();
	seenMessages = /* @__PURE__ */ new Set();
	answerFilter = new MarkdownStreamFilter();
	constructor(turn, initialContext = {}) {
		this.turn = turn;
		this.applyContext(initialContext);
	}
	/** Process rows in observation order. */
	get steps() {
		return this.stepEntries;
	}
	/** Fold one event into the projection. */
	observe(event) {
		if (this.isTerminal()) return;
		if (isRequestContextEvent(event)) {
			this.applyContext(event.data);
			return;
		}
		if (isAssistantChunkEvent(event)) {
			if (event.data.turn !== this.turn) return;
			const chunk = event.data.chunk;
			if (chunk.type === "text-delta" && chunk.text !== void 0) {
				this.answerText += this.answerFilter.push(chunk.text);
				this.markInProgress();
			} else if (chunk.type === "reasoning-delta") this.markInProgress();
			return;
		}
		if (isAssistantMessageEvent(event)) {
			if (event.data.turn === this.turn) this.observeAssistantMessage(event.data);
			return;
		}
		if (isToolCallEvent(event)) {
			if (event.data.turn === this.turn) this.observeToolCall(event.data);
			return;
		}
		if (isToolResultEvent(event)) {
			if (event.data.turn === this.turn) this.observeToolResult(event.data);
			return;
		}
		if (isTurnEndEvent(event) && event.data.turn === this.turn) this.finish(event.data);
	}
	isTerminal() {
		return this.status === "completed" || this.status === "failed";
	}
	markInProgress() {
		if (this.status === "thinking") this.status = "in_progress";
	}
	applyContext(context) {
		if (typeof context.model === "string" && context.model.trim() !== "") this.model = context.model.trim();
		const capacity = context.contextWindow;
		if (typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0) this.contextWindow = Math.floor(capacity);
	}
	observeAssistantMessage(data) {
		const identity = messageIdentity(data);
		if (this.seenMessages.has(identity)) return;
		this.seenMessages.add(identity);
		const text = assistantText(data);
		if (text !== "") this.answerText = text;
		for (const block of data.message.content) if (block.type === "reasoning" && block.text !== void 0 && block.text !== "") this.stepEntries.push({
			kind: "reasoning",
			status: "completed",
			atMs: Date.now()
		});
		const model = assistantModel(data);
		if (model !== void 0) this.model = model;
		if (data.usage !== void 0) {
			this.usage = {
				inputTokens: data.usage.inputTokens ?? 0,
				outputTokens: data.usage.outputTokens ?? 0,
				...data.usage.cacheReadTokens !== void 0 ? { cacheReadTokens: data.usage.cacheReadTokens } : {}
			};
			this.usageAtMs = Date.now();
		}
	}
	observeToolCall(data) {
		if (this.toolStepByCallId.has(data.callId)) return;
		const step = {
			kind: "tool",
			name: data.name,
			status: "running",
			argumentsJson: data.arguments,
			atMs: Date.now()
		};
		this.toolStepByCallId.set(data.callId, step);
		this.stepEntries.push(step);
		this.markInProgress();
	}
	observeToolResult(data) {
		const callId = toolResultCallId(data);
		if (callId === void 0) return;
		const step = this.toolStepByCallId.get(callId);
		if (step === void 0 || step.status !== "running") return;
		step.status = data.error === void 0 ? "completed" : "failed";
		step.atMs = Date.now();
	}
	finish(data) {
		const finishedAt = Date.now();
		const failed = data.reason.kind === "error";
		this.finishedAt = finishedAt;
		this.durationMs = finishedAt - this.startedAt;
		if (!failed) {
			this.status = "completed";
			return;
		}
		this.status = "failed";
		if (data.reason.error === void 0) return;
		this.errorCode = data.reason.error.code ?? "";
		this.errorMessage = data.reason.error.message ?? "";
	}
};
/** Stable replay identity without retaining message text. */
function messageIdentity(data) {
	if (data.step !== void 0) return "step:" + data.step;
	let hash = 2166136261;
	let length = 0;
	for (const block of data.message.content) {
		const value = block.type + "\0" + (block.text ?? "") + "";
		length += value.length;
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
	}
	return "content:" + length + ":" + (hash >>> 0);
}
//#endregion
//#region src/presentation/reply-presenter.ts
const UPDATE_INTERVAL_MS = 350;
const TOOL_CALL_BLOCK = /<tool_calls>[\s\S]*?(?:<\/tool_calls>|$)/g;
const TOOL_CALL_NOTICE = "\n\n⚠️ 模型输出了未被识别的工具调用标记，已省略——通常意味着本次请求没有可用工具。";
/** Create a presenter whose destination cannot be retargeted later. */
function createReplyPresenter(port, destination, options) {
	return new TurnReplyPresenter(port, destination, options);
}
var TurnReplyPresenter = class {
	port;
	options;
	chatId;
	sendOptions;
	cardOptions;
	context;
	view;
	messageId;
	writes = Promise.resolve();
	timer;
	dirty = false;
	cardUnavailable = false;
	nativeAnswerSent = false;
	closed = false;
	finalization;
	closePromise;
	constructor(port, destination, options) {
		this.port = port;
		this.options = options;
		this.chatId = destination.chatId;
		this.sendOptions = {
			replyTo: destination.replyToMessageId,
			...destination.replyInThread ? { replyInThread: true } : {}
		};
		this.cardOptions = options;
		this.messageId = options.reuseCardMessageId;
		this.context = contextSnapshot(options.initialContext);
	}
	observe(event) {
		if (this.closed) return;
		if (isRequestContextEvent(event)) {
			this.context = contextSnapshot(event.data);
			if (this.view !== void 0) {
				this.view.observe(event);
				this.schedule();
			}
			return;
		}
		const turn = eventTurn$1(event);
		if (turn === void 0) return;
		this.view ??= new TurnView(turn, this.context);
		if (this.view.turn !== turn) return;
		this.view.observe(event);
		if (isTurnEndEvent(event)) this.finalize();
		else this.schedule();
	}
	close() {
		this.closePromise ??= this.closeOnce();
		return this.closePromise;
	}
	async closeOnce() {
		this.closed = true;
		this.clearTimer();
		if (this.view?.status === "completed" || this.view?.status === "failed") await this.finalize();
		else await this.writes;
	}
	schedule() {
		if (this.closed || this.cardUnavailable) return;
		this.dirty = true;
		if (this.timer !== void 0) return;
		this.timer = setTimeout(() => {
			this.flush();
		}, UPDATE_INTERVAL_MS);
	}
	async flush() {
		this.timer = void 0;
		const view = this.view;
		if (this.closed || !this.dirty || view === void 0 || this.cardUnavailable) return;
		this.dirty = false;
		const result = renderCard(view, this.cardOptions);
		if (result.disposition === "native") {
			this.cardUnavailable = true;
			return;
		}
		await this.publishCard(result.card);
	}
	finalize() {
		this.finalization ??= this.finalizeOnce();
		return this.finalization;
	}
	async finalizeOnce() {
		this.clearTimer();
		this.dirty = false;
		const view = this.view;
		if (view === void 0) return;
		const result = renderCard(view, this.cardOptions);
		if (result.disposition === "card" && !this.cardUnavailable) {
			await this.publishCard(result.card);
			if (!this.cardUnavailable) return;
		} else await this.writes;
		await this.publishHandoffIfNeeded();
		await this.publishNativeAnswer(view.answerText);
	}
	publishCard(card) {
		this.writes = this.writes.then(async () => {
			if (this.cardUnavailable) return;
			try {
				if (this.messageId === void 0) {
					const sent = await this.port.send(this.chatId, { card }, this.sendOptions);
					this.messageId = sent.messageId;
				} else await this.port.updateCard(this.messageId, card);
				this.options.onCardPublished?.(this.messageId);
			} catch (error) {
				this.cardUnavailable = true;
				this.options.onFailure(error);
			}
		});
		return this.writes;
	}
	async publishHandoffIfNeeded() {
		await this.writes;
		if (this.messageId === void 0) return;
		try {
			await this.port.updateCard(this.messageId, renderHandoffCard(true));
			this.options.onCardPublished?.(this.messageId);
		} catch (error) {
			this.options.onFailure(error);
		}
	}
	async publishNativeAnswer(answer) {
		if (this.nativeAnswerSent) return;
		this.nativeAnswerSent = true;
		const text = stripToolCallMarkup(answer).trim();
		if (text === "") return;
		await this.port.send(this.chatId, { markdown: text }, this.sendOptions).catch(this.options.onFailure);
	}
	clearTimer() {
		if (this.timer !== void 0) clearTimeout(this.timer);
		this.timer = void 0;
	}
};
/** Remove model-emitted pseudo tool calls before a native fallback is sent. */
function stripToolCallMarkup(text) {
	const stripped = text.replace(TOOL_CALL_BLOCK, "");
	if (stripped === text) return text;
	return stripped.trimEnd() + TOOL_CALL_NOTICE;
}
function eventTurn$1(event) {
	if (typeof event.data !== "object" || event.data === null) return void 0;
	const turn = event.data.turn;
	return typeof turn === "number" && Number.isInteger(turn) && turn >= 0 ? turn : void 0;
}
function contextSnapshot(context) {
	if (context === void 0) return {};
	const model = context.model.trim();
	const capacity = context.contextWindow;
	return {
		...model === "" ? {} : { model },
		...typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0 ? { contextWindow: Math.floor(capacity) } : {}
	};
}
//#endregion
//#region src/model-card.ts
/** Marker distinguishing model-setting selectors from other card actions. */
const MODEL_SETTING_ACTION = "dsh-feishu-channel/model-setting";
/** Narrow one arbitrary card-action value to a model-setting callback. */
function modelSettingActionValue(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (record.kind !== "dsh-feishu-channel/model-setting" || typeof record.id !== "string") return void 0;
	return {
		kind: MODEL_SETTING_ACTION,
		id: record.id
	};
}
function settingLabel(kind) {
	return kind === "model" ? "模型设置" : "推理强度";
}
/** Build exact server-approved choices for one selector. */
function modelSettingChoices(directory, kind) {
	if (kind === "model") return directory.groups.flatMap((group) => group.models.map((model) => ({
		value: route({
			provider: group.id,
			model: model.id
		}),
		label: model.name + " · " + group.name,
		selection: {
			provider: group.id,
			model: model.id,
			...model.reasoning?.defaultEffort === void 0 ? {} : { reasoningEffort: model.reasoning.defaultEffort }
		}
	})));
	const reasoning = currentModel(directory)?.reasoning;
	return [{
		value: "default",
		label: "模型默认" + (reasoning?.defaultEffort === void 0 ? "" : "（" + reasoning.defaultEffort + "）"),
		selection: {
			provider: directory.current.provider,
			model: directory.current.model,
			...reasoning?.defaultEffort === void 0 ? {} : { reasoningEffort: reasoning.defaultEffort }
		}
	}, ...(reasoning?.efforts ?? []).map((effort) => ({
		value: effort.id,
		label: effort.name + "（" + effort.id + "）",
		selection: {
			provider: directory.current.provider,
			model: directory.current.model,
			reasoningEffort: effort.id
		}
	}))];
}
/** Build a native Feishu dropdown card showing the current value and choices. */
function modelSettingCard(directory, kind, id, choices) {
	const title = kind === "model" ? "选择模型" : "选择推理强度";
	const currentRows = kind === "model" ? [interactiveFieldRow("当前模型", directory.current.model), interactiveFieldRow("提供方", directory.current.provider)] : [interactiveFieldRow("当前强度", directory.current.reasoningEffort ?? "模型默认")];
	return interactiveCard([
		interactiveStatusLine(settingLabel(kind), "请选择", "info"),
		interactiveDivider(),
		...currentRows,
		{
			tag: "action",
			actions: [{
				tag: "select_static",
				placeholder: {
					tag: "plain_text",
					content: title
				},
				options: choices.map((choice) => ({
					text: {
						tag: "plain_text",
						content: choice.label
					},
					value: choice.value
				})),
				value: {
					kind: MODEL_SETTING_ACTION,
					id
				}
			}]
		},
		{
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: "选择后将作用于当前会话的下一条消息。"
			}]
		}
	]);
}
/** Replace a used selector with an unambiguous settled result. */
function settledModelSettingCard(kind, selected) {
	const rows = kind === "model" ? [
		interactiveFieldRow("当前模型", selected.model),
		interactiveFieldRow("提供方", selected.provider),
		...selected.reasoningEffort === void 0 ? [] : [interactiveFieldRow("推理强度", selected.reasoningEffort)]
	] : [interactiveFieldRow("当前强度", selected.reasoningEffort ?? "模型默认")];
	return interactiveCard([
		interactiveStatusLine(settingLabel(kind), "已完成", "success"),
		interactiveDivider(),
		...rows
	]);
}
/** Replace a failed selector with a clear retry instruction. */
function failedModelSettingCard(kind, detail) {
	return interactiveCard([
		interactiveStatusLine(settingLabel(kind), "失败", "failure"),
		interactiveDivider(),
		{
			tag: "div",
			text: {
				tag: "plain_text",
				content: detail.slice(0, 300)
			}
		},
		{
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: "请重新输入 /" + (kind === "model" ? "model" : "effort") + "再试。"
			}]
		}
	]);
}
//#endregion
//#region src/permission-card.ts
/** Marker distinguishing permission-setting selectors from other card actions. */
const PERMISSION_SETTING_ACTION = "dsh-feishu-channel/permission-setting";
/** DSH's derived current-only state; it is descriptive, not a writable preset. */
const CUSTOM_PERMISSION = "custom";
/** Narrow one arbitrary card-action value to a permission-setting callback. */
function permissionSettingActionValue(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (record.kind !== "dsh-feishu-channel/permission-setting" || typeof record.id !== "string") return void 0;
	if (record.action !== "select" && record.action !== "confirm" && record.action !== "cancel") return void 0;
	return {
		kind: PERMISSION_SETTING_ACTION,
		id: record.id,
		action: record.action
	};
}
/** Preserve the host's option order while excluding the non-writable custom state. */
function permissionSettingChoices(select) {
	return select.options.filter((option) => option.value !== CUSTOM_PERMISSION).map((option) => ({
		value: option.value,
		label: option.name,
		...option.description === void 0 ? {} : { description: option.description }
	}));
}
/** Build a native Feishu dropdown from the session's permission projection. */
function permissionSettingCard(select, id, choices) {
	return interactiveCard([
		interactiveStatusLine("权限设置", "请选择", "info"),
		interactiveDivider(),
		interactiveFieldRow("当前权限", select.currentValue),
		{
			tag: "action",
			actions: [{
				tag: "select_static",
				placeholder: {
					tag: "plain_text",
					content: "选择权限预设"
				},
				options: choices.map((choice) => ({
					text: {
						tag: "plain_text",
						content: choice.label.slice(0, 120)
					},
					value: choice.value
				})),
				value: {
					kind: PERMISSION_SETTING_ACTION,
					id,
					action: "select"
				}
			}]
		},
		{
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: "选择后将作用于当前会话；高风险权限需要再次确认。"
			}]
		}
	]);
}
/** Require a second explicit click before enabling unrestricted access. */
function permissionConfirmationCard(choice, id) {
	return interactiveCard([
		interactiveStatusLine("权限设置", "高风险", "warning"),
		interactiveDivider(),
		interactiveFieldRow("将切换为", choice.value),
		...interactivePlainSection("风险说明", choice.description ?? "该预设允许命令脱离工作区沙箱执行，请确认这是你的明确选择。"),
		{
			tag: "action",
			actions: [{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "确认启用"
				},
				type: "danger",
				value: {
					kind: PERMISSION_SETTING_ACTION,
					id,
					action: "confirm"
				}
			}, {
				tag: "button",
				text: {
					tag: "plain_text",
					content: "返回"
				},
				type: "default",
				value: {
					kind: PERMISSION_SETTING_ACTION,
					id,
					action: "cancel"
				}
			}]
		}
	]);
}
/** Replace a used selector with the chosen current value. */
function settledPermissionSettingCard(choice) {
	return interactiveCard([
		interactiveStatusLine("权限设置", "已完成", "success"),
		interactiveDivider(),
		interactiveFieldRow("当前权限", choice.value),
		...choice.description === void 0 ? [] : [{
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: choice.description
			}]
		}]
	]);
}
/** Replace a failed selector with a bounded retry instruction. */
function failedPermissionSettingCard(detail) {
	return interactiveCard([
		interactiveStatusLine("权限设置", "失败", "failure"),
		interactiveDivider(),
		{
			tag: "div",
			text: {
				tag: "plain_text",
				content: detail.slice(0, 300)
			}
		},
		{
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: "请重新输入 /permission 再试。"
			}]
		}
	]);
}
//#endregion
//#region src/slash-panel.ts
/** Read all pages, then apply the exact desired/remote difference in stable order. */
async function syncSlashPanel(port, desired, notify, options = {}) {
	const signal = options.signal;
	let existing;
	try {
		existing = await listAllCommands(port, signal);
	} catch (error) {
		if (!isAborted(signal)) notify("feishu-channel: slash-command panel not synced: " + errorDetail$1(error));
		return unchanged();
	}
	if (isAborted(signal)) return unchanged();
	const wantedCommands = [...new Map(desired.map((command) => [command.name, command])).values()];
	const remoteNames = new Set(existing.map((command) => command.command));
	const wantedNames = new Set(wantedCommands.map((command) => command.name));
	const added = [];
	const removed = [];
	for (const command of wantedCommands) {
		if (isAborted(signal)) break;
		if (remoteNames.has(command.name)) continue;
		try {
			await port.createSlashCommand(command.name, command.description);
			added.push(command.name);
			remoteNames.add(command.name);
		} catch (error) {
			notify("feishu-channel: could not register /" + command.name + ": " + errorDetail$1(error));
		}
	}
	if (options.removeUnknown !== false) for (const command of existing) {
		if (isAborted(signal)) break;
		if (wantedNames.has(command.command)) continue;
		try {
			await port.deleteSlashCommand(command.commandId);
			removed.push(command.command);
		} catch (error) {
			notify("feishu-channel: could not remove /" + command.command + ": " + errorDetail$1(error));
		}
	}
	return {
		added,
		removed
	};
}
async function listAllCommands(port, signal) {
	const commands = [];
	const visitedTokens = /* @__PURE__ */ new Set();
	let pageToken;
	while (!isAborted(signal)) {
		const page = await port.listSlashCommands(pageToken);
		commands.push(...page.commands);
		const next = page.nextPageToken;
		if (next === void 0 || next === "") break;
		if (visitedTokens.has(next)) throw new Error("slash-command pagination repeated token " + next);
		visitedTokens.add(next);
		pageToken = next;
	}
	return commands;
}
function unchanged() {
	return {
		added: [],
		removed: []
	};
}
function isAborted(signal) {
	return signal?.aborted === true;
}
function errorDetail$1(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/turn-coordinator.ts
/** Correlates Feishu messages with host turn events and immutable reply targets. */
function eventTurn(event) {
	if (typeof event.data !== "object" || event.data === null) return void 0;
	const turn = event.data.turn;
	return typeof turn === "number" && Number.isInteger(turn) && turn >= 0 ? turn : void 0;
}
/**
* Keeps turn correlation independent from rendering and transport. Host turn
* numbers are learned from events, so queued messages bind FIFO per session.
*/
var TurnCoordinator = class {
	queued = /* @__PURE__ */ new Map();
	active = /* @__PURE__ */ new Map();
	latest = /* @__PURE__ */ new Map();
	nextId = 0;
	/** Queue one user message before handing it to the owned agent. */
	submit(owner, target, message) {
		if (owner.conversationKey !== target.conversationKey) throw new Error("turn target does not belong to the owned agent");
		const turn = Object.freeze({
			id: "feishu-turn-" + ++this.nextId,
			target,
			owner,
			message
		});
		const sessionId = owner.handle.agent.session.id;
		const queue = this.queued.get(sessionId) ?? [];
		queue.push(turn);
		this.queued.set(sessionId, queue);
		this.latest.set(target.conversationKey, turn);
		try {
			owner.handle.agent.followup(message);
		} catch (error) {
			this.remove(turn);
			throw error;
		}
		return turn;
	}
	/**
	* Replay only the latest turn of one exact conversation. A stale card id is
	* refused instead of borrowing a newer message.
	*/
	retry(key, turnId) {
		const previous = this.latest.get(key);
		if (previous === void 0 || previous.id !== turnId) return void 0;
		return this.submit(previous.owner, previous.target, Object.freeze({
			...previous.message,
			id: randomUUID()
		}));
	}
	/** Resolve one host event to the Feishu turn that submitted it. */
	route(sessionId, event) {
		const hostTurn = eventTurn(event);
		if (hostTurn === void 0) {
			const active = this.active.get(sessionId);
			if (active !== void 0 && active.size > 0) return [...active.values()].at(-1);
			return this.queued.get(sessionId)?.[0];
		}
		let byTurn = this.active.get(sessionId);
		let coordinated = byTurn?.get(hostTurn);
		if (coordinated === void 0) {
			const queue = this.queued.get(sessionId);
			coordinated = queue?.shift();
			if (queue !== void 0 && queue.length === 0) this.queued.delete(sessionId);
			if (coordinated === void 0) return void 0;
			if (byTurn === void 0) {
				byTurn = /* @__PURE__ */ new Map();
				this.active.set(sessionId, byTurn);
			}
			byTurn.set(hostTurn, coordinated);
		}
		if (event.type === "turn/end") {
			byTurn?.delete(hostTurn);
			if (byTurn?.size === 0) this.active.delete(sessionId);
		}
		return coordinated;
	}
	/** Current Feishu-submitted turn allowed to own a host-side interaction. */
	current(sessionId) {
		const active = this.active.get(sessionId);
		if (active !== void 0 && active.size > 0) return [...active.values()].at(-1);
		return this.queued.get(sessionId)?.[0];
	}
	/** Drop queued, active, and retryable state for one conversation. */
	clear(key) {
		this.latest.delete(key);
		for (const [sessionId, queue] of this.queued) {
			const remaining = queue.filter((turn) => turn.target.conversationKey !== key);
			if (remaining.length === 0) this.queued.delete(sessionId);
			else this.queued.set(sessionId, remaining);
		}
		for (const [sessionId, turns] of this.active) {
			for (const [hostTurn, turn] of turns) if (turn.target.conversationKey === key) turns.delete(hostTurn);
			if (turns.size === 0) this.active.delete(sessionId);
		}
	}
	/** Drop all process-local turn correlation. */
	close() {
		this.queued.clear();
		this.active.clear();
		this.latest.clear();
	}
	remove(turn) {
		const sessionId = turn.owner.handle.agent.session.id;
		const queue = this.queued.get(sessionId);
		if (queue !== void 0) {
			const index = queue.indexOf(turn);
			if (index >= 0) queue.splice(index, 1);
			if (queue.length === 0) this.queued.delete(sessionId);
		}
		if (this.latest.get(turn.target.conversationKey) === turn) this.latest.delete(turn.target.conversationKey);
	}
};
//#endregion
//#region src/channel.ts
/** Feishu channel composition: inbound messages, owned agents, turns, and transport lifecycle. */
/** Model-facing layout contract for the frozen reply-card experience. */
const REPLY_CARD_PROMPT = "Your final reply is rendered in a compact Feishu card. Use one `##` heading for the outcome. If 2–4 facts materially support it, place a two-column Markdown table headed `关键事实` and `值` immediately below. Put the outcome and next action before an optional `### 详细说明`; supporting evidence belongs after that heading. The card already shows tool activity, so omit that transcript from the answer. For every ordered collection, give each item its own physical Markdown line and a strictly increasing `N.` marker, including when the list crosses headings. Do not join items with `·`, `、`, or commas, and do not place an ordered list in a fenced block or multi-column text. Before submitting, check: is every ordered item visibly numbered on its own line, and is the outcome understandable without opening `详细说明`?";
function detail(error) {
	return error instanceof Error ? error.message : String(error);
}
function valueOf(result) {
	if (result.ok) return result.value;
	throw new Error(result.error.code + ": " + result.error.message);
}
function createModelController(api) {
	if (api === void 0) return void 0;
	return {
		async inspect(sessionId) {
			return valueOf((await api.sessions.models({
				rpcId: randomUUID(),
				payload: { sessionId }
			})).result);
		},
		async select(sessionId, selection) {
			return valueOf((await api.sessions.selectModel({
				rpcId: randomUUID(),
				payload: {
					sessionId,
					...selection
				}
			})).result).selected;
		}
	};
}
async function inspectPermissions(api, sessionId) {
	const history = api?.sessions.history;
	if (history === void 0) throw new Error("当前部署没有会话权限投影服务。");
	const permissions = valueOf((await history({
		rpcId: randomUUID(),
		payload: {
			sessionId,
			maxMessages: 1
		}
	})).result).projections?.values.permissions;
	if (permissions === void 0) throw new Error("当前会话没有可用的权限预设。");
	return permissions;
}
function activityLabel(value) {
	const singleLine = value.replace(/[\s`]+/g, " ").trim();
	return singleLine.length <= 90 ? singleLine : singleLine.slice(0, 89) + "…";
}
function createToolPresentation(tools, scope) {
	return (name, argumentsJson) => {
		let argumentsValue;
		try {
			argumentsValue = JSON.parse(argumentsJson);
		} catch {
			return { title: name };
		}
		try {
			const presented = tools?.get(name, scope)?.presentCall?.(argumentsValue);
			if (typeof presented?.title === "string" && presented.title.trim() !== "") return { title: activityLabel(presented.title) };
		} catch {
			return { title: name };
		}
		const description = argumentsValue?.description;
		return typeof description === "string" && description.trim() !== "" ? { title: name + " · " + activityLabel(description) } : { title: name };
	};
}
function composeAgent(agentCtx, config) {
	const prompt = agentCtx.get("systemPrompt");
	const addPrompt = (name, order, text) => {
		prompt?.section({
			name: "feishu-channel:" + name,
			order,
			text
		});
	};
	addPrompt("reply-card", 149, REPLY_CARD_PROMPT);
	const denied = new Set(config.denyTools);
	if (denied.size === 0) return;
	agentCtx.get("tools")?.guard(({ name }) => {
		if (!denied.has(name)) return void 0;
		return name + " is unavailable from this chat because its response belongs to another interface. Ask the user in the normal reply and continue after their next message.";
	});
	addPrompt("interaction", 150, "This conversation happens in chat. Put questions and plan-approval requests in the reply; the next user message supplies the answer. Unavailable tools: " + [...denied].join(", ") + ".");
}
/** Convert one normalized Feishu message into an immutable host user message. */
function chatUserMessage(message, images) {
	const speaker = message.chatType === "group" ? message.senderName ?? message.senderId : void 0;
	const transcript = joinTextLines(speaker === void 0 ? message.content : speaker + ": " + message.content, images.notes);
	const content = [...images.blocks];
	if (transcript !== "") content.unshift({
		type: "text",
		text: transcript
	});
	return Object.freeze({
		id: randomUUID(),
		role: "user",
		content: Object.freeze(content),
		source: Object.freeze({ kind: "user" })
	});
}
function joinTextLines(first, remaining) {
	return [first, ...remaining].filter((line) => line !== "").join("\n");
}
/** Install one channel and bind every registration to the current plugin fiber. */
function installChannel(ctx, config, port, notify, authorization) {
	let active = true;
	const coordinator = new TurnCoordinator();
	const bindingsBySession = /* @__PURE__ */ new Map();
	const bindingsByKey = /* @__PURE__ */ new Map();
	const presentations = /* @__PURE__ */ new Map();
	const retryCards = /* @__PURE__ */ new Map();
	const reuseCardForTurn = /* @__PURE__ */ new Map();
	const pendingModelSettings = /* @__PURE__ */ new Map();
	const pendingCommandInteractions = /* @__PURE__ */ new Map();
	const pendingPermissionSettings = /* @__PURE__ */ new Map();
	const commandOperations = /* @__PURE__ */ new Set();
	const commandController = new AbortController();
	const imageController = new AbortController();
	const panelController = new AbortController();
	const imageCollections = /* @__PURE__ */ new Set();
	const cwd = resolve(config.cwd);
	const reportSendFailure = (error) => {
		const message = detail(error);
		notify("feishu-channel: outbound send failed: " + message);
		ctx.logger.warn("outbound send failed: %s", message);
	};
	const collectMessageImages = (message) => {
		const collection = collectImages(message, port, ctx.get("attachments"), config.attachImages, imageController.signal);
		imageCollections.add(collection);
		collection.then(() => {
			imageCollections.delete(collection);
		}, () => {
			imageCollections.delete(collection);
		});
		return collection;
	};
	const approvals = createApprovalGate({
		port,
		notify,
		refuseCardAction: (subject, pending) => refuseApprovalClick(authorization, subject, pending)
	});
	let prepared;
	let preparing;
	const resolveWorkspace = async () => {
		const workspaces = ctx.get("workspaceRegistry");
		if (workspaces === void 0) return void 0;
		try {
			await mkdir(cwd, { recursive: true });
			return await workspaces.resolveByPath(cwd) ?? await workspaces.create(cwd);
		} catch (error) {
			notify("feishu-channel: workspace lookup failed for " + cwd + ": " + detail(error));
			return;
		}
	};
	const resolveModelSelection = () => {
		if (config.provider !== void 0 || config.model !== void 0) return {
			provider: config.provider,
			model: config.model
		};
		const defaults = ctx.get("agentDefaultModel");
		if (defaults === void 0) throw new Error("feishu-channel: no model configured — set config.provider/model or compose the agentDefaultModel service");
		return defaults.currentSelection();
	};
	const prepare = () => {
		if (prepared !== void 0) return Promise.resolve(prepared);
		preparing ??= (async () => {
			await ctx.get("loader")?.await();
			if (!active) throw new Error("feishu-channel is closed");
			const presets = ctx.get("agentPresets");
			const presetId = presets === void 0 ? void 0 : (await presets.resolve(config.preset)).id;
			const toolScope = presets === void 0 || presetId === void 0 ? void 0 : await presets.standingKeyFor(presetId);
			const workspace = await resolveWorkspace();
			const setup = async (agentCtx) => {
				if (presets !== void 0 && presetId !== void 0) await presets.mount(agentCtx, presetId);
				composeAgent(agentCtx, config);
			};
			prepared = {
				agents: new AgentRegistry({
					agents: ctx.agents,
					workspace,
					persistence: ctx.get("sessionPersistence"),
					agentOptions: resolveModelSelection(),
					meta: {
						cwd: workspace?.path ?? cwd,
						...presetId === void 0 ? {} : { agentPreset: presetId }
					},
					setup,
					report: (line) => {
						ctx.logger.info(line);
					}
				}),
				presentCall: createToolPresentation(ctx.get("tools"), toolScope)
			};
			return prepared;
		})();
		preparing.catch(() => {
			preparing = void 0;
		});
		return preparing;
	};
	let panelAgent;
	let panelQueue = Promise.resolve();
	const queuePanelSync = (desired, removeUnknown) => {
		if (!config.syncSlashCommands || !active) return;
		panelQueue = panelQueue.then(async () => {
			if (!active) return;
			const changes = await syncSlashPanel(port, desired, notify, {
				removeUnknown,
				signal: panelController.signal
			});
			if (changes.added.length > 0) notify("feishu-channel: registered /" + changes.added.join(", /") + " on the bot slash panel");
			if (changes.removed.length > 0) notify("feishu-channel: removed /" + changes.removed.join(", /") + " from the bot slash panel");
		}).catch((error) => {
			notify("feishu-channel: slash-command panel sync failed: " + detail(error));
		});
	};
	const publishPanel = (agent) => {
		panelAgent = agent;
		const hosted = ctx.get("commands")?.list(agent) ?? [];
		queuePanelSync([...hosted, ...CHANNEL_COMMANDS], true);
	};
	const rememberBinding = (owner, target, chatType) => {
		const previous = bindingsByKey.get(owner.conversationKey);
		if (previous !== void 0 && previous.owner.handle.agent.session.id !== owner.handle.agent.session.id) bindingsBySession.delete(previous.owner.handle.agent.session.id);
		const binding = Object.freeze({
			key: owner.conversationKey,
			chatId: target.chatId,
			chatType,
			owner
		});
		bindingsByKey.set(owner.conversationKey, binding);
		bindingsBySession.set(owner.handle.agent.session.id, binding);
		publishPanel(owner.handle.agent);
		return binding;
	};
	const closePresentations = async (key) => {
		const closing = [];
		for (const [turnId, presentation] of presentations) {
			if (key !== void 0 && presentation.key !== key) continue;
			presentations.delete(turnId);
			closing.push(presentation.presenter.close().catch(reportSendFailure));
		}
		await Promise.all(closing);
	};
	const approvalTurn = (turn) => {
		const binding = bindingsByKey.get(turn.target.conversationKey);
		if (binding === void 0) return void 0;
		return {
			sessionId: turn.owner.handle.agent.session.id,
			turnId: turn.id,
			conversationKey: turn.target.conversationKey,
			chatId: turn.target.chatId,
			chatType: binding.chatType
		};
	};
	const forgetConversationCards = (key) => {
		const turnIds = /* @__PURE__ */ new Set();
		for (const [messageId, card] of retryCards) {
			if (card.turn.target.conversationKey !== key) continue;
			turnIds.add(card.turn.id);
			retryCards.delete(messageId);
		}
		for (const turnId of turnIds) reuseCardForTurn.delete(turnId);
	};
	const forgetCommandInteractions = (key) => {
		for (const [id, pending] of pendingCommandInteractions) if (pending.target.conversationKey === key) pendingCommandInteractions.delete(id);
		for (const [id, pending] of pendingPermissionSettings) if (pending.target.conversationKey === key) pendingPermissionSettings.delete(id);
	};
	const trackCommandOperation = (operation) => {
		commandOperations.add(operation);
		const retire = () => {
			commandOperations.delete(operation);
		};
		operation.then(retire, retire);
	};
	const presentationFor = (turn, presentCall) => {
		const existing = presentations.get(turn.id);
		if (existing !== void 0) return existing.presenter;
		const chatType = bindingsByKey.get(turn.target.conversationKey)?.chatType ?? "p2p";
		const reusedMessageId = reuseCardForTurn.get(turn.id);
		if (reusedMessageId !== void 0) reuseCardForTurn.delete(turn.id);
		const presenter = createReplyPresenter(port, {
			chatId: turn.target.chatId,
			replyToMessageId: turn.target.replyToMessageId,
			replyInThread: turn.target.replyInThread
		}, {
			showProcess: config.showProcess,
			maxTimelineItems: config.maxTimelineItems,
			tableOverflowMode: config.tableOverflowMode,
			footerFields: config.footerFields,
			pricing: config.pricing,
			offPeakWindows: config.offPeakWindows,
			presentCall,
			onFailure: reportSendFailure,
			initialContext: turn.owner.handle.agent.session.requestContext(),
			reuseCardMessageId: reusedMessageId,
			onCardPublished(messageId) {
				retryCards.set(messageId, {
					turn,
					chatType
				});
			}
		});
		presentations.set(turn.id, {
			key: turn.target.conversationKey,
			presenter
		});
		return presenter;
	};
	const sendModelSetting = async (binding, kind, controller, cardMessageId) => {
		const directory = await controller.inspect(binding.owner.handle.agent.session.id);
		const choices = modelSettingChoices(directory, kind);
		if (choices.length === 0) return false;
		const id = randomUUID();
		const card = modelSettingCard(directory, kind, id, choices);
		const messageId = cardMessageId ?? (await port.send(binding.chatId, { card })).messageId;
		if (cardMessageId !== void 0) await port.updateCard(cardMessageId, card);
		for (const [pendingId, pending] of pendingModelSettings) if (pending.target.conversationKey === binding.key && pending.kind === kind) pendingModelSettings.delete(pendingId);
		pendingModelSettings.set(id, {
			target: {
				conversationKey: binding.key,
				chatId: binding.chatId,
				chatType: binding.chatType,
				cardMessageId: messageId,
				sessionId: binding.owner.handle.agent.session.id
			},
			kind,
			choices: new Map(choices.map((choice) => [choice.value, choice.selection])),
			controller
		});
		return true;
	};
	const interactionTarget = (binding, cardMessageId) => ({
		conversationKey: binding.key,
		chatId: binding.chatId,
		chatType: binding.chatType,
		cardMessageId,
		sessionId: binding.owner.handle.agent.session.id
	});
	const publishInteractionCard = async (binding, card, cardMessageId) => {
		const messageId = cardMessageId ?? (await port.send(binding.chatId, { card })).messageId;
		if (cardMessageId !== void 0) await port.updateCard(cardMessageId, card);
		return interactionTarget(binding, messageId);
	};
	const sendCommandMenu = async (binding, cardMessageId) => {
		const catalog = commandCatalog(ctx.get("commands"), binding.owner.handle.agent);
		const id = randomUUID();
		const target = await publishInteractionCard(binding, commandHelpCard(catalog, id), cardMessageId);
		for (const [pendingId, pending] of pendingCommandInteractions) if (pending.target.conversationKey === binding.key) pendingCommandInteractions.delete(pendingId);
		pendingCommandInteractions.set(id, {
			kind: "menu",
			target,
			commands: new Map(catalog.map((command) => [command.name, command]))
		});
	};
	const sendCommandPrompt = async (binding, command, cardMessageId) => {
		const id = randomUUID();
		const target = await publishInteractionCard(binding, commandPromptCard(command, id), cardMessageId);
		for (const [pendingId, pending] of pendingCommandInteractions) if (pending.target.conversationKey === binding.key) pendingCommandInteractions.delete(pendingId);
		pendingCommandInteractions.set(id, {
			kind: "prompt",
			target,
			command
		});
	};
	const sendSessionCommandPrompt = async (target, chatType, command) => {
		const id = randomUUID();
		const sent = await port.send(target.chatId, { card: commandPromptCard(command, id) });
		for (const [pendingId, pending] of pendingCommandInteractions) if (pending.target.conversationKey === target.conversationKey) pendingCommandInteractions.delete(pendingId);
		pendingCommandInteractions.set(id, {
			kind: "prompt",
			target: {
				conversationKey: target.conversationKey,
				chatId: target.chatId,
				chatType,
				cardMessageId: sent.messageId,
				sessionId: bindingsByKey.get(target.conversationKey)?.owner.handle.agent.session.id ?? ""
			},
			command
		});
	};
	const sendPermissionSetting = async (binding, cardMessageId) => {
		const select = await inspectPermissions(ctx.get("apiProxy"), binding.owner.handle.agent.session.id);
		const choices = permissionSettingChoices(select);
		if (choices.length === 0) throw new Error("当前会话没有可切换的权限预设。");
		const id = randomUUID();
		const target = await publishInteractionCard(binding, permissionSettingCard(select, id, choices), cardMessageId);
		for (const [pendingId, pending] of pendingPermissionSettings) if (pending.target.conversationKey === binding.key) pendingPermissionSettings.delete(pendingId);
		pendingPermissionSettings.set(id, {
			target,
			select,
			choices: new Map(choices.map((choice) => [choice.value, choice]))
		});
	};
	const openCommandInteraction = async (binding, command, cardMessageId) => {
		if (command.name === "help") {
			await sendCommandMenu(binding, cardMessageId);
			return;
		}
		if (command.name === "model" || command.name === "effort") {
			const controller = createModelController(ctx.get("apiProxy"));
			if (controller === void 0) throw new Error("当前部署没有会话模型控制服务。");
			if (!await sendModelSetting(binding, command.name === "model" ? "model" : "effort", controller, cardMessageId)) throw new Error("当前会话没有可选项。");
			return;
		}
		if (command.name === "permission") {
			await sendPermissionSetting(binding, cardMessageId);
			return;
		}
		await sendCommandPrompt(binding, command, cardMessageId);
	};
	const resetConversation = async (target, command) => {
		const state = prepared;
		if (state === void 0) throw new Error("命令运行时尚未准备完成。");
		const replacement = await state.agents.reset(target.conversationKey);
		coordinator.clear(target.conversationKey);
		await closePresentations(target.conversationKey);
		forgetConversationCards(target.conversationKey);
		forgetCommandInteractions(target.conversationKey);
		await approvals.cancelConversation(target.conversationKey);
		for (const [id, pending] of pendingModelSettings) if (pending.target.conversationKey === target.conversationKey) pendingModelSettings.delete(id);
		rememberBinding(replacement, target, target.chatType);
		return {
			reply: command === "reset" ? "已重置当前会话，下一条消息将不带入之前的上下文。" : "已新建空白会话，下一条消息将不带入之前的上下文。",
			status: "success"
		};
	};
	const handleCommand = async (command, binding) => {
		const commands = ctx.get("commands");
		const descriptor = commandCatalog(commands, binding.owner.handle.agent).find((candidate) => candidate.name === command.name);
		if (command.input === "" && descriptor !== void 0) {
			await openCommandInteraction(binding, descriptor);
			return;
		}
		const controller = createModelController(ctx.get("apiProxy"));
		const outcome = await executeCommand(command, {
			agent: binding.owner.handle.agent,
			commands,
			signal: commandController.signal,
			models: controller
		});
		await port.send(binding.chatId, { card: commandResultCard(command.name, outcome) });
	};
	const handleMessage = async (message) => {
		const refusal = refuseMessage(authorization, message);
		if (refusal !== void 0) {
			notify("feishu-channel: ignored a message in " + message.chatId + ": " + refusal);
			return;
		}
		if (message.senderIsBot === true || message.content.trim() === "") return;
		const target = createTurnTarget(config.sessionScope, message);
		const command = parseCommandLine(message.content);
		try {
			const state = await prepare();
			if (command?.input === "" && (command.name === "new" || command.name === "reset")) {
				const descriptor = CHANNEL_COMMANDS.find((candidate) => candidate.name === command.name);
				await sendSessionCommandPrompt(target, message.chatType, descriptor);
				return;
			}
			let owner = await state.agents.acquire(target.conversationKey);
			let binding = rememberBinding(owner, target, message.chatType);
			if (command !== void 0) {
				await handleCommand(command, binding);
				return;
			}
			const images = await collectMessageImages(message);
			if (!active) return;
			if (!state.agents.isCurrent(owner)) {
				owner = await state.agents.acquire(target.conversationKey);
				binding = rememberBinding(owner, target, message.chatType);
			}
			coordinator.submit(owner, target, chatUserMessage(message, images));
		} catch (error) {
			const messageDetail = detail(error);
			const operation = command === void 0 ? "agent creation" : "command handling";
			notify("feishu-channel: " + operation + " failed for chat " + message.chatId + ": " + messageDetail);
			ctx.logger.warn("%s failed for chat %s: %s", operation, message.chatId, messageDetail);
			await port.send(message.chatId, command === void 0 ? { text: "⚠️ 无法启动会话：" + messageDetail } : { card: commandResultCard(command.name, {
				reply: "命令执行失败（/" + command.name + "）：" + messageDetail,
				status: "failure"
			}) }).catch(reportSendFailure);
		}
	};
	const currentBinding = (target) => {
		const binding = bindingsByKey.get(target.conversationKey);
		return binding?.owner.handle.agent.session.id === target.sessionId ? binding : void 0;
	};
	const interactionRefusal = (target, event, label) => {
		const refusal = refuseApprovalClick(authorization, {
			operatorId: event.operator.openId,
			chatId: event.chatId
		}, {
			chatId: target.chatId,
			chatType: target.chatType
		});
		if (refusal === void 0) return void 0;
		notify("feishu-channel: rejected a " + label + " click: " + refusal);
		return { toast: {
			type: "error",
			content: "你无权操作此会话"
		} };
	};
	const executeCommandInteraction = async (pending, input) => {
		const target = pending.target;
		try {
			let outcome;
			if (pending.command.name === "new" || pending.command.name === "reset") outcome = await resetConversation(target, pending.command.name);
			else {
				const binding = currentBinding(target);
				if (binding === void 0) throw new Error("该命令卡已失效。");
				const command = parseCommandLine("/" + pending.command.name + (input === "" ? "" : " " + input));
				if (command === void 0) throw new Error("命令参数无法解析。");
				outcome = await executeCommand(command, {
					agent: binding.owner.handle.agent,
					commands: ctx.get("commands"),
					signal: commandController.signal,
					models: createModelController(ctx.get("apiProxy"))
				});
			}
			await port.updateCard(target.cardMessageId, commandResultCard(pending.command.name, outcome));
		} catch (error) {
			const message = detail(error);
			notify("feishu-channel: interactive /" + pending.command.name + " failed: " + message);
			await port.updateCard(target.cardMessageId, commandResultCard(pending.command.name, {
				reply: "命令执行失败（/" + pending.command.name + "）：" + message,
				status: "failure"
			})).catch(reportSendFailure);
		}
	};
	const openSelectedCommand = async (pending, binding, command) => {
		try {
			await openCommandInteraction(binding, command, pending.target.cardMessageId);
		} catch (error) {
			const message = detail(error);
			notify("feishu-channel: could not open /" + command.name + " interaction: " + message);
			const card = command.name === "permission" ? failedPermissionSettingCard(message) : commandResultCard(command.name, {
				reply: message,
				status: "failure"
			});
			await port.updateCard(pending.target.cardMessageId, card).catch(reportSendFailure);
		}
	};
	const applyPermissionSetting = async (pending, choice) => {
		const target = pending.target;
		try {
			const binding = currentBinding(target);
			if (binding === void 0) throw new Error("该权限选择卡已失效。");
			const command = parseCommandLine("/permission " + choice.value);
			if (command === void 0) throw new Error("权限预设无法解析。");
			const outcome = await executeCommand(command, {
				agent: binding.owner.handle.agent,
				commands: ctx.get("commands"),
				signal: commandController.signal,
				models: createModelController(ctx.get("apiProxy"))
			});
			if (outcome.status === "failure") {
				await port.updateCard(target.cardMessageId, failedPermissionSettingCard(outcome.reply));
				return;
			}
			await port.updateCard(target.cardMessageId, settledPermissionSettingCard(choice));
		} catch (error) {
			const message = detail(error);
			notify("feishu-channel: permission selection failed: " + message);
			await port.updateCard(target.cardMessageId, failedPermissionSettingCard(message)).catch(reportSendFailure);
		}
	};
	const applyModelSetting = async (pending, selection) => {
		const target = pending.target;
		try {
			if (pending.kind === "effort") {
				const directory = await pending.controller.inspect(target.sessionId);
				if (directory.current.provider !== selection.provider || directory.current.model !== selection.model) throw new Error("当前模型已变化");
			}
			const selected = await pending.controller.select(target.sessionId, selection);
			await port.updateCard(target.cardMessageId, settledModelSettingCard(pending.kind, selected));
		} catch (error) {
			const message = detail(error);
			notify("feishu-channel: model-setting selection failed: " + message);
			await port.updateCard(target.cardMessageId, failedModelSettingCard(pending.kind, message)).catch(reportSendFailure);
		}
	};
	const handleCardAction = async (event) => {
		if (isCopyErrorAction(event.action.value)) return { toast: {
			type: "info",
			content: event.action.value.text.slice(0, 200)
		} };
		if (isRetryAction(event.action.value)) {
			const card = retryCards.get(event.messageId);
			if (card === void 0) return { toast: {
				type: "info",
				content: "会话已失效，无法重试"
			} };
			const refusal = refuseApprovalClick(authorization, {
				operatorId: event.operator.openId,
				chatId: event.chatId
			}, {
				chatId: card.turn.target.chatId,
				chatType: card.chatType
			});
			if (refusal !== void 0) {
				notify("feishu-channel: rejected a retry click: " + refusal);
				return { toast: {
					type: "error",
					content: "你无权操作此会话"
				} };
			}
			const retried = coordinator.retry(card.turn.target.conversationKey, card.turn.id);
			if (retried === void 0) return { toast: {
				type: "info",
				content: "会话已失效，无法重试"
			} };
			retryCards.set(event.messageId, {
				turn: retried,
				chatType: card.chatType
			});
			reuseCardForTurn.set(retried.id, event.messageId);
			return { toast: {
				type: "success",
				content: "已重新发起请求"
			} };
		}
		const formId = commandFormActionId(event.action.name);
		if (formId !== void 0) {
			const pending = pendingCommandInteractions.get(formId);
			if (pending === void 0 || pending.kind !== "prompt" || pending.target.cardMessageId !== event.messageId) return { toast: {
				type: "info",
				content: "该命令卡已失效"
			} };
			const refusal = interactionRefusal(pending.target, event, "command-form");
			if (refusal !== void 0) return refusal;
			if (currentBinding(pending.target) === void 0) {
				pendingCommandInteractions.delete(formId);
				return { toast: {
					type: "info",
					content: "该命令卡已失效"
				} };
			}
			const rawInput = event.action.formValue?.[COMMAND_INPUT_NAME];
			if (rawInput !== void 0 && typeof rawInput !== "string") return { toast: {
				type: "error",
				content: "命令参数格式无效"
			} };
			pendingCommandInteractions.delete(formId);
			trackCommandOperation(executeCommandInteraction(pending, rawInput?.trim() ?? ""));
			return { toast: {
				type: "info",
				content: "正在执行 /" + pending.command.name
			} };
		}
		const commandAction = commandInteractionActionValue(event.action.value);
		if (commandAction !== void 0) {
			const pending = pendingCommandInteractions.get(commandAction.id);
			if (pending === void 0 || pending.target.cardMessageId !== event.messageId) return { toast: {
				type: "info",
				content: "该命令卡已失效"
			} };
			const refusal = interactionRefusal(pending.target, event, "command");
			if (refusal !== void 0) return refusal;
			const binding = currentBinding(pending.target);
			const isSessionReset = pending.kind === "prompt" && (pending.command.name === "new" || pending.command.name === "reset");
			if (binding === void 0 && !isSessionReset) {
				pendingCommandInteractions.delete(commandAction.id);
				return { toast: {
					type: "info",
					content: "该命令卡已失效"
				} };
			}
			if (commandAction.action === "open") {
				if (pending.kind !== "menu") return { toast: {
					type: "error",
					content: "命令卡状态无效"
				} };
				if (binding === void 0) return { toast: {
					type: "info",
					content: "该命令卡已失效"
				} };
				const command = event.action.option === void 0 ? void 0 : pending.commands.get(event.action.option);
				if (command === void 0) return { toast: {
					type: "error",
					content: "选项无效，请重新打开命令中心"
				} };
				pendingCommandInteractions.delete(commandAction.id);
				trackCommandOperation(openSelectedCommand(pending, binding, command));
				return { toast: {
					type: "info",
					content: "正在打开 /" + command.name
				} };
			}
			if (pending.kind !== "prompt") return { toast: {
				type: "error",
				content: "命令卡状态无效"
			} };
			pendingCommandInteractions.delete(commandAction.id);
			if (commandAction.action === "cancel") {
				trackCommandOperation(port.updateCard(pending.target.cardMessageId, cancelledCommandCard(pending.command.name)).catch(reportSendFailure));
				return { toast: {
					type: "success",
					content: "已取消 /" + pending.command.name
				} };
			}
			trackCommandOperation(executeCommandInteraction(pending, ""));
			return { toast: {
				type: "info",
				content: "正在执行 /" + pending.command.name
			} };
		}
		const permissionAction = permissionSettingActionValue(event.action.value);
		if (permissionAction !== void 0) {
			const pending = pendingPermissionSettings.get(permissionAction.id);
			if (pending === void 0 || pending.target.cardMessageId !== event.messageId) return { toast: {
				type: "info",
				content: "该权限选择卡已失效"
			} };
			const refusal = interactionRefusal(pending.target, event, "permission-setting");
			if (refusal !== void 0) return refusal;
			if (currentBinding(pending.target) === void 0) {
				pendingPermissionSettings.delete(permissionAction.id);
				return { toast: {
					type: "info",
					content: "该权限选择卡已失效"
				} };
			}
			if (permissionAction.action === "cancel") {
				pendingPermissionSettings.set(permissionAction.id, {
					target: pending.target,
					select: pending.select,
					choices: pending.choices
				});
				trackCommandOperation(port.updateCard(pending.target.cardMessageId, permissionSettingCard(pending.select, permissionAction.id, [...pending.choices.values()])).catch(reportSendFailure));
				return { toast: {
					type: "info",
					content: "已返回权限选择"
				} };
			}
			const choice = permissionAction.action === "confirm" ? pending.confirmation : event.action.option === void 0 ? void 0 : pending.choices.get(event.action.option);
			if (choice === void 0) return { toast: {
				type: "error",
				content: "选项无效，请重新输入 /permission"
			} };
			if (permissionAction.action === "select" && choice.value === "danger-full-access" && pending.select.currentValue !== "danger-full-access") {
				pendingPermissionSettings.set(permissionAction.id, {
					...pending,
					confirmation: choice
				});
				trackCommandOperation(port.updateCard(pending.target.cardMessageId, permissionConfirmationCard(choice, permissionAction.id)).catch(reportSendFailure));
				return { toast: {
					type: "info",
					content: "请再次确认高风险权限"
				} };
			}
			pendingPermissionSettings.delete(permissionAction.id);
			trackCommandOperation(applyPermissionSetting(pending, choice));
			return { toast: {
				type: "info",
				content: "正在切换权限"
			} };
		}
		const action = modelSettingActionValue(event.action.value);
		if (action !== void 0) {
			const pending = pendingModelSettings.get(action.id);
			if (pending === void 0 || pending.target.cardMessageId !== event.messageId) return { toast: {
				type: "info",
				content: "该选择卡已失效"
			} };
			const refusal = refuseApprovalClick(authorization, {
				operatorId: event.operator.openId,
				chatId: event.chatId
			}, {
				chatId: pending.target.chatId,
				chatType: pending.target.chatType
			});
			if (refusal !== void 0) {
				notify("feishu-channel: rejected a model-setting click: " + refusal);
				return { toast: {
					type: "error",
					content: "你无权操作此会话"
				} };
			}
			const selection = event.action.option === void 0 ? void 0 : pending.choices.get(event.action.option);
			if (selection === void 0) return { toast: {
				type: "error",
				content: "选项无效，请重新输入命令"
			} };
			pendingModelSettings.delete(action.id);
			trackCommandOperation(applyModelSetting(pending, selection));
			return { toast: {
				type: "info",
				content: pending.kind === "model" ? "正在切换模型" : "正在调整推理强度"
			} };
		}
		return approvals.handleCardAction(event);
	};
	const reportRejectedEvent = (event) => {
		if (event.reason === "no_mention") {
			ctx.logger.debug("rejected %s in %s: %s", event.messageId, event.chatId, event.reason);
			return;
		}
		ctx.logger.info("rejected %s in %s from %s: %s", event.messageId, event.chatId, event.senderId, event.reason);
		if (event.reason === "bot_loop") notify("feishu-channel: bot loop guard tripped in chat " + event.chatId + " — traffic from bots is being refused");
	};
	const reportTransportError = (error) => {
		notify("feishu-channel: transport error [" + error.code + "]: " + error.message);
		ctx.logger.warn("transport error [%s]: %s", error.code, error.message);
	};
	const reportReconnecting = () => {
		notify("feishu-channel: connection lost, reconnecting — events arriving now are not replayed");
		ctx.logger.warn("connection lost, reconnecting");
	};
	const reportReconnected = () => {
		notify("feishu-channel: connection restored");
		ctx.logger.info("connection restored");
	};
	ctx.effect(() => port.on("message", handleMessage), "feishu:on(message)");
	ctx.effect(() => port.on("cardAction", handleCardAction), "feishu:on(cardAction)");
	ctx.effect(() => port.on("reject", reportRejectedEvent), "feishu:on(reject)");
	ctx.effect(() => port.on("error", reportTransportError), "feishu:on(error)");
	ctx.effect(() => port.on("reconnecting", reportReconnecting), "feishu:on(reconnecting)");
	ctx.effect(() => port.on("reconnected", reportReconnected), "feishu:on(reconnected)");
	ctx.on("commands/change", () => {
		if (panelAgent !== void 0) publishPanel(panelAgent);
	});
	ctx.on("session/event", (session, event) => {
		const turn = coordinator.route(session.id, event);
		if (turn === void 0 || prepared === void 0 || !prepared.agents.ownsSession(session.id)) return;
		const approvalOwner = approvalTurn(turn);
		if (isToolCallEvent(event) && approvalOwner !== void 0) approvals.recordToolCall(approvalOwner, event.data.callId, event.data.arguments);
		const presenter = presentationFor(turn, prepared.presentCall);
		presenter.observe(event);
		if (isTurnEndEvent(event)) {
			if (approvalOwner !== void 0) approvals.finishTurn(approvalOwner);
			presenter.close().finally(() => {
				presentations.delete(turn.id);
			});
		}
	});
	ctx.on("approval/request", (request, next) => {
		if (prepared?.agents.ownsSession(request.agent.session.id) !== true) return next();
		const turn = coordinator.current(request.agent.session.id);
		if (turn === void 0) return next();
		const owner = approvalTurn(turn);
		return owner === void 0 ? next() : approvals.ask(owner, request, next);
	}, { prepend: true });
	ctx.effect(() => () => {
		active = false;
		commandController.abort();
		imageController.abort();
		panelController.abort();
		coordinator.close();
		bindingsBySession.clear();
		bindingsByKey.clear();
		pendingModelSettings.clear();
		pendingCommandInteractions.clear();
		pendingPermissionSettings.clear();
		retryCards.clear();
		reuseCardForTurn.clear();
		const closeAgents = prepared !== void 0 ? prepared.agents.close() : preparing?.then((state) => state.agents.close(), () => void 0);
		return Promise.allSettled([
			closePresentations(),
			approvals.close(),
			Promise.allSettled([...imageCollections]),
			Promise.allSettled([...commandOperations]),
			panelQueue,
			...closeAgents === void 0 ? [] : [closeAgents]
		]).then(() => void 0);
	}, "feishu:channel");
	ctx.effect(() => {
		let connected = false;
		const connection = port.connect().then(() => {
			connected = true;
			if (active) queuePanelSync(CHANNEL_COMMANDS, false);
		}).catch((error) => {
			notify("feishu-channel: connect failed: " + detail(error));
			ctx.logger.error("feishu channel connect failed: %s", error);
		});
		return async () => {
			active = false;
			await connection;
			if (connected) await port.disconnect().catch(reportSendFailure);
		};
	}, "feishu:connect");
}
//#endregion
//#region src/onboarding.ts
/** First-boot Feishu app registration through the official QR flow. */
const REGISTRATION_PRESET = {
	source: "dsh-feishu-channel",
	appPreset: {
		name: "DSH Agent",
		desc: "DSH 会话机器人"
	}
};
const EXPIRED_CODE = "expired_token";
const REISSUE_FLOOR_MS = 6e4;
/** Start registration and return an explicit cancellation boundary. */
function startOnboarding(options) {
	const controller = new AbortController();
	const { signal } = controller;
	const announcements = /* @__PURE__ */ new Set();
	let lastIssuedAt = 0;
	const announce = (url, expireIn) => {
		lastIssuedAt = Date.now();
		if (signal.aborted) return;
		const pending = announceQr(url, expireIn, signal, options.notify);
		announcements.add(pending);
		pending.finally(() => {
			announcements.delete(pending);
		}).catch(() => void 0);
	};
	const run = async () => {
		while (!signal.aborted) {
			options.notify("feishu-channel: 未配置应用凭据，开始扫码注册流程…");
			let registered;
			try {
				registered = await options.register({
					...REGISTRATION_PRESET,
					...options.appId === void 0 ? {} : { appId: options.appId },
					signal,
					onQRCodeReady: (info) => {
						announce(info.url, info.expireIn);
					}
				});
			} catch (error) {
				if (signal.aborted) return;
				if (registrationCode(error) !== EXPIRED_CODE) {
					options.notify("feishu-channel: 扫码注册失败: " + errorDetail(error));
					return;
				}
				const waitMs = Math.max(0, (options.reissueFloorMs ?? REISSUE_FLOOR_MS) - (Date.now() - lastIssuedAt));
				if (waitMs > 0) {
					options.notify("feishu-channel: 注册码意外过期，稍后重试");
					await abortableDelay(waitMs, signal);
				}
				continue;
			}
			if (signal.aborted) return;
			const app = {
				appId: registered.client_id,
				appSecret: registered.client_secret,
				...registered.user_info?.open_id === void 0 ? {} : { registeredBy: registered.user_info.open_id }
			};
			let saved = false;
			try {
				saved = await options.persist(app);
			} catch (error) {
				if (signal.aborted) return;
				options.notify("feishu-channel: 凭据保存失败: " + errorDetail(error));
			}
			if (signal.aborted) return;
			options.notify(saved ? "feishu-channel: 扫码成功，凭据已保存，正在连接…" : "feishu-channel: 扫码成功，凭据未持久化，正在连接…");
			options.onCredentials(app);
			return;
		}
	};
	return {
		completed: run().finally(async () => {
			await Promise.allSettled([...announcements]);
		}),
		close() {
			controller.abort();
		}
	};
}
async function announceQr(url, expireIn, signal, notify) {
	const drawn = await drawQrCode(url);
	if (signal.aborted) return;
	notify("feishu-channel: 请用飞书扫码创建应用（" + Math.round(expireIn / 60) + " 分钟内有效）:");
	if (drawn !== void 0) notify(drawn);
	notify("feishu-channel: 扫码页面: " + url);
}
function drawQrCode(url) {
	return new Promise((resolve) => {
		try {
			qrcode.generate(url, { small: true }, (drawn) => {
				resolve(drawn);
			});
		} catch {
			resolve(void 0);
		}
	});
}
function abortableDelay(ms, signal) {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}
function registrationCode(error) {
	if (typeof error !== "object" || error === null) return void 0;
	const code = error.code;
	return typeof code === "string" ? code : void 0;
}
function errorDetail(error) {
	if (error instanceof Error) return error.message;
	const code = registrationCode(error);
	if (code === void 0) return String(error);
	const description = error.description;
	return typeof description === "string" ? code + ": " + description : code;
}
//#endregion
//#region src/runtime.ts
/**
* Runtime boundary and Cordis activation for the plugin.
* @module dsh-feishu-channel/runtime
*/
/** The app-config endpoint for the bot's slash-command panel. */
const SLASH_COMMAND_API = "/open-apis/application/v7/app_slash_commands";
/** The user-settings namespace holding this plugin's section. */
const SETTINGS_NAMESPACE = "feishu-channel";
/** Narrow a resolved configuration to one carrying live credentials. */
function hasCredentials(config) {
	return typeof config.appId === "string" && config.appId !== "" && typeof config.appSecret === "string" && config.appSecret !== "";
}
/**
* Create the production Lark transport from resolved configuration.
* @param config - resolved plugin configuration with credentials.
* @param authorization - the channel's authorization rules.
* @returns the real @larksuite/channel client behind the channel's port surface.
*/
function createLarkChannelPort(config, authorization) {
	const policy = { requireMention: config.requireMention };
	if (authorization.directSenders.size > 0) {
		policy.dmMode = "allowlist";
		policy.dmAllowlist = [...authorization.directSenders];
	}
	if (config.groupAllowlist.length > 0) policy.groupAllowlist = config.groupAllowlist;
	const options = {
		appId: config.appId,
		appSecret: config.appSecret,
		policy,
		source: "dsh-feishu-channel"
	};
	if (config.domain !== void 0) options.domain = config.domain;
	const channel = createLarkChannel(options);
	const raw = channel.rawClient;
	return Object.assign(channel, {
		async listSlashCommands(pageToken) {
			const query = new URLSearchParams({ page_size: "50" });
			if (pageToken !== void 0) query.set("page_token", pageToken);
			const response = await raw.request({
				method: "GET",
				url: "/open-apis/application/v7/app_slash_commands?" + query.toString()
			});
			const commands = (response.data?.items ?? []).filter((item) => typeof item.command === "string" && typeof item.command_id === "string").map((item) => ({
				command: item.command,
				commandId: item.command_id
			}));
			const next = response.data?.has_more === true ? response.data.page_token : void 0;
			return {
				commands,
				...typeof next === "string" && next !== "" ? { nextPageToken: next } : {}
			};
		},
		async deleteSlashCommand(commandId) {
			await raw.request({
				method: "DELETE",
				url: "/open-apis/application/v7/app_slash_commands/" + commandId
			});
		},
		async createSlashCommand(command, description) {
			await raw.request({
				method: "POST",
				url: SLASH_COMMAND_API,
				data: {
					command,
					description: { default_value: description }
				}
			});
		}
	});
}
/** Substitutable production boundaries; tests replace them with fakes. */
const internals = {
	createPort: createLarkChannelPort,
	registerApp,
	notify: (line) => void process.stderr.write(line + "\n")
};
/**
* Apply the plugin to its Cordis context. With credentials configured the
* transport connects directly; without them the QR registration flow runs
* first and persists the scanned credentials through the host settings
* service when one is composed.
* @param ctx - scoped plugin context; requires the agents service.
* @param config - configuration resolved by Cordis from the exported schema.
*/
function apply(ctx, config) {
	let active = true;
	let started = false;
	let onboarding;
	ctx.effect(() => () => {
		active = false;
		onboarding?.close();
	}, "feishu:lifetime");
	const start = (resolved) => {
		if (!active || started) return;
		started = true;
		const authorization = resolveAuthorization(resolved);
		internals.notify(describeAuthorization(authorization));
		installChannel(ctx, resolved, internals.createPort(resolved, authorization), internals.notify, authorization);
	};
	const bootstrap = async () => {
		await ctx.get("loader")?.await();
		if (!active) return;
		let resolved = resolveConfig(config);
		let persist = async (_app) => false;
		const settings = ctx.get("settings");
		if (settings !== void 0) try {
			const scope = settings.register(SETTINGS_NAMESPACE, Config, { base: config });
			resolved = resolveConfig(scope.get());
			persist = async (credentials) => {
				await scope.update(credentials);
				return true;
			};
		} catch (error) {
			ctx.logger.error("settings registration failed; continuing with entry config only: %s", error instanceof Error ? error.message : error);
		}
		if (hasCredentials(resolved)) {
			start(resolved);
			return;
		}
		const base = resolved;
		onboarding = startOnboarding({
			register: internals.registerApp,
			notify: internals.notify,
			persist,
			onCredentials: (app) => {
				start({
					...base,
					...app
				});
			},
			...resolved.appId === void 0 ? {} : { appId: resolved.appId },
			...internals.reissueFloorMs === void 0 ? {} : { reissueFloorMs: internals.reissueFloorMs }
		});
		onboarding.completed.catch((error) => {
			ctx.logger.error("feishu-channel onboarding failed: %s", error instanceof Error ? error.message : error);
		});
	};
	bootstrap().catch((error) => {
		ctx.logger.error("feishu-channel bootstrap failed: %s", error instanceof Error ? error.message : error);
	});
}
//#endregion
//#region src/index.ts
/**
* Feishu/Lark IM channel for DeepSeek Harness: each chat drives its own
* agent, committed assistant output returns as streaming rich cards or chat
* messages, and approval questions become interactive cards.
* @module dsh-feishu-channel
*/
/** Cordis plugin name; keep this stable after publishing. */
const name = "feishu-channel";
/** Services that must exist before the plugin is applied. */
const inject = ["agents"];
//#endregion
export { Config, apply, inject, name };
