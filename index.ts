import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ApiKeyCredential, AuthContext, AuthResult, Credential, Provider, ProviderAuth, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Input } from "@earendil-works/pi-tui";
import { ACCOUNT_NAME, AccountStore, BLOCK, RESERVED_ACCOUNT } from "./store.ts";

// Hops between named logins by project folder. Each provider with a login
// (subscription or API key) is re-registered with an auth wrapper: while a named
// account is selected, every request resolves that account's credential (and
// fails closed if it has none);
// with Pi's built-in login selected, the wrapper defers to Pi untouched.

const STATUS_KEY = "agent-hopper";
const OVERRIDE_ENTRY = "agent-hopper-override";
const BASE = Symbol("agent-hopper.base");

// `piLogin` names Pi's own /login so it can be used like any other profile.
// `colors` maps profile → "#rrggbb", a gradient ["#rrggbb", "#rrggbb", …], or "none".
// `agentColors` maps provider ID → color for the model and subscription text.
type Color = string | string[];
type Config = {
	folders: Record<string, string>;
	piLogin?: string;
	colors?: Record<string, Color>;
	agentColors?: Record<string, Color>;
};

// Brand colors: Claude's orange, and OpenAI's brand-book blue at its blue-400 step
// (#7989ff), since pure #0000ff is too dark to read on a dark terminal.
// Shell variables a provider's requests read ahead of a stored credential's settings.
const AMBIENT_CREDENTIALS: Record<string, string[]> = {
	"amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID"],
};

// Free endpoints that answer "is this key valid?"; other providers get a one-token request.
const KEY_CHECKS: Record<string, (key: string) => [url: string, headers: Record<string, string>]> = {
	anthropic: (key) => ["https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" }],
	openai: (key) => ["https://api.openai.com/v1/models", { authorization: `Bearer ${key}` }],
	openrouter: (key) => ["https://openrouter.ai/api/v1/key", { authorization: `Bearer ${key}` }],
};
const KEY_CHECK_TIMEOUT_MS = 20_000;

type KeyCheck = { ok: true; how: string } | { ok: false; rejected: boolean; message: string };

const AGENT_NAMES: Record<string, string> = { anthropic: "Claude", openai: "ChatGPT", "openai-codex": "Codex" };

const AGENT_COLORS: Record<string, Color> = {
	anthropic: "#d97757",
	openai: "#7989ff",
	"openai-codex": "#7989ff",
};

// Distinct, readable badge colors; client profiles without a configured color get one by name.
// Red ("no profile"), orange and blue (the agent colors) are left out so they never collide.
const PALETTE = ["#e2a336", "#12a594", "#30a46c", "#8e4ec6", "#d6409f"];
const BLOCKED_COLOR = "#e5484d";
// Pi's own login gets a gradient by default, so it never looks like a (solid) client badge.
const PI_LOGIN_GRADIENT = ["#00c2ff", "#7b61ff", "#ff5ea8"];
const HEX = /^#[0-9a-f]{6}$/i;

// Badge colors offered by /hop. Red, orange and blue are left out (warning, Claude, ChatGPT).
const SWATCHES: Array<[string, Color]> = [
	["Amber", "#e2a336"],
	["Gold", "#ffc53d"],
	["Lime", "#99d52a"],
	["Green", "#30a46c"],
	["Teal", "#12a594"],
	["Purple", "#8e4ec6"],
	["Pink", "#d6409f"],
	["Brown", "#a0522d"],
	["Slate", "#687076"],
	["Sunset", ["#ffc53d", "#d6409f"]],
	["Forest", ["#99d52a", "#12a594"]],
	["Aurora", PI_LOGIN_GRADIENT],
];

// Sets (or, with undefined, clears) a profile's color in agent-hopper.json, keeping everything else.
function saveColor(profile: string, color: Color | undefined): void {
	let raw: Record<string, unknown> = { folders: {} };
	try {
		raw = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const colors = { ...(raw.colors as Record<string, Color> | undefined) };
	if (color === undefined) delete colors[profile];
	else colors[profile] = color;
	raw.colors = colors;
	const tmp = `${configPath()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
	renameSync(tmp, configPath());
}

type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as RGB;

// One color per character: solid colors repeat, gradients interpolate across the text.
function spread(color: Color, length: number): RGB[] {
	const stops = (Array.isArray(color) ? color : [color]).map(rgb);
	if (stops.length === 1) return Array.from({ length }, () => stops[0]);
	return Array.from({ length }, (_, i) => {
		const t = length === 1 ? 0 : (i / (length - 1)) * (stops.length - 1);
		const [a, b] = [stops[Math.floor(t)], stops[Math.min(Math.ceil(t), stops.length - 1)]];
		const f = t - Math.floor(t);
		return a.map((v, k) => Math.round(v + (b[k] - v) * f)) as RGB;
	});
}

function badge(text: string, color: Color | undefined): string {
	if (!color) return text;
	const chars = [...` ${text} `];
	const colors = spread(color, chars.length);
	const light = colors.reduce((sum, [r, g, b]) => sum + 0.299 * r + 0.587 * g + 0.114 * b, 0) / colors.length > 150;
	const fg = light ? "0;0;0" : "255;255;255";
	if (!Array.isArray(color)) return `\x1b[1;48;2;${colors[0].join(";")};38;2;${fg}m${chars.join("")}\x1b[0m`;
	return `${chars.map((c, i) => `\x1b[1;48;2;${colors[i].join(";")};38;2;${fg}m${c}`).join("")}\x1b[0m`;
}

// Same color as the profile badge, as plain text (no background).
function tint(text: string, color: Color | undefined): string {
	if (!color) return text;
	const chars = [...text];
	const colors = spread(color, chars.length);
	if (!Array.isArray(color)) return `\x1b[38;2;${colors[0].join(";")}m${text}\x1b[39m`;
	return `${chars.map((c, i) => `\x1b[38;2;${colors[i].join(";")}m${c}`).join("")}\x1b[39m`;
}
// `account: null` is Pi's built-in login; `blocked` means no credentials at all.
type Selection = { account: string | null; label: string; folder: string | null; blocked?: boolean };

const configPath = () => join(getAgentDir(), "agent-hopper.json");
const examplePath = () => join(getAgentDir(), "agent-hopper.example.json");
const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

// Written next to the config on first run, like a .env.example: never loaded, just copied.
const EXAMPLE_CONFIG = {
	piLogin: "personal",
	folders: {
		"~": "personal",
		"~/clients": "block",
		"~/clients/acme": "acme",
		"~/clients/globex": "globex",
	},
	colors: { globex: "#ffc53d" },
};

function writeExample(): void {
	if (existsSync(configPath())) return;
	try {
		writeFileSync(examplePath(), `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`, { flag: "wx" }); // never overwrite
	} catch {}
}

const setupHint = () => `No config yet. Start from the example:\n  cp ${tilde(examplePath())} ${tilde(configPath())}`;
const store = new AccountStore(join(getAgentDir(), "agent-hopper", "profiles"));

function canonical(path: string): string {
	const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
	const absolute = resolve(expanded);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function loadConfig(): Config {
	let raw: string;
	try {
		raw = readFileSync(configPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { folders: {} };
		throw error;
	}
	const config = JSON.parse(raw) as Config;
	if (!config.folders || typeof config.folders !== "object") {
		throw new Error(`${configPath()}: expected { "folders": { "<path>": "<profile>" } }`);
	}
	if (config.piLogin !== undefined && !ACCOUNT_NAME.test(config.piLogin)) {
		throw new Error(`${configPath()}: invalid piLogin name "${config.piLogin}"`);
	}
	for (const [key, map] of [["colors", config.colors], ["agentColors", config.agentColors]] as const) {
		for (const [name, color] of Object.entries(map ?? {})) {
			const valid = Array.isArray(color)
				? color.length >= 2 && color.every((c) => HEX.test(c))
				: color === "none" || HEX.test(color);
			if (!valid) {
				throw new Error(`${configPath()}: ${key}.${name} must be "#rrggbb", a list of them for a gradient, or "none"`);
			}
		}
	}
	for (const [folder, account] of Object.entries(config.folders)) {
		if (account !== RESERVED_ACCOUNT && account !== BLOCK && !ACCOUNT_NAME.test(account)) {
			throw new Error(`${configPath()}: invalid profile name "${account}" for ${folder}`);
		}
	}
	return config;
}

// Longest matching folder wins; unmapped folders use Pi's built-in login.
function folderSelection(cwd: string, config: Config): Selection {
	const here = canonical(cwd);
	let match: { folder: string; account: string; root: string } | undefined;
	for (const [folder, account] of Object.entries(config.folders)) {
		const root = canonical(folder);
		const inside = here === root || here.startsWith(root.endsWith(sep) ? root : root + sep);
		if (inside && (!match || root.length > match.root.length)) match = { folder, account, root };
	}
	const piLogin = config.piLogin ?? RESERVED_ACCOUNT;
	if (!match) return { account: null, label: piLogin, folder: null };
	if (match.account === BLOCK) return { account: null, label: "no profile", folder: match.folder, blocked: true };
	const builtIn = match.account === RESERVED_ACCOUNT || match.account === piLogin;
	return { account: builtIn ? null : match.account, label: builtIn ? piLogin : match.account, folder: match.folder };
}

function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	execFile(cmd, args, () => {});
}

// Ambient context for OAuth's toAuth path, which Pi calls without one.
const processAuthContext: AuthContext = {
	env: async (name) => process.env[name],
	fileExists: async (path) => existsSync(path.replace(/^~(?=$|\/)/, homedir())),
};

// A text prompt that shows "•" for each character, for keys and tokens. Pi's own
// input dialog has no masked mode, so this wraps pi-tui's Input (which handles
// paste and editing) and draws only the dots.
async function secretInput(ctx: ExtensionContext, title: string, signal: AbortSignal): Promise<string | undefined> {
	let drawn = false;
	const value = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		drawn = true;
		const input = new Input();
		input.onSubmit = (value) => done(value);
		input.onEscape = () => done(undefined);
		signal.addEventListener("abort", () => done(undefined), { once: true });
		return {
			render: (width) => {
				const length = input.getValue().length;
				const dots = length ? `${"•".repeat(Math.min(length, Math.max(1, width - 16)))} ${theme.fg("muted", `(${length})`)}` : theme.fg("muted", "paste or type — hidden");
				return [theme.fg("accent", theme.bold(title)), "", `  ${dots}`, "", theme.fg("muted", "  enter save · escape cancel")];
			},
			handleInput: (data) => {
				input.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => input.invalidate?.(),
		};
	});
	// RPC mode has no custom UI and returns without drawing: fall back to a plain prompt.
	return drawn ? value : ctx.ui.input(title, undefined, { signal });
}

function loginInteraction(ctx: ExtensionContext, signal: AbortSignal): ProviderAuthInteraction {
	const cancelled = () => new Error("Login cancelled");
	return {
		signal,
		async prompt(prompt) {
			const opts = { signal: prompt.signal ?? signal };
			if (prompt.type === "select") {
				const labels = prompt.options.map((o) => o.label);
				const choice = await ctx.ui.select(prompt.message, labels, opts);
				if (!choice) throw cancelled();
				return prompt.options[labels.indexOf(choice)].id;
			}
			const value =
				prompt.type === "secret"
					? await secretInput(ctx, prompt.message, opts.signal)
					: await ctx.ui.input(prompt.message, prompt.placeholder, opts);
			if (value === undefined) throw cancelled();
			return value;
		},
		notify(event) {
			if (event.type === "auth_url") {
				openBrowser(event.url);
				ctx.ui.notify(`Sign in in your browser. If it didn't open:\n${event.url}${event.instructions ? `\n${event.instructions}` : ""}`, "info");
			} else if (event.type === "device_code") {
				ctx.ui.notify(`Go to ${event.verificationUri} and enter code ${event.userCode}`, "info");
			} else {
				ctx.ui.notify(event.message, "info");
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	let folder: Selection = { account: null, label: "default", folder: null };
	// A /hop switch for this session only; undefined means "follow the folder".
	let override: { account: string | null } | undefined;
	let configError: string | undefined;
	let piLogin = RESERVED_ACCOUNT; // display name for Pi's own /login
	let colors: Record<string, Color> = {};
	let agentColors: Record<string, Color> = {};
	let configProfiles: string[] = []; // profiles named in the config, signed in or not
	const providers = new Map<string, Provider>(); // providerId → unwrapped provider

	const selection = (): Selection =>
		override ? { account: override.account, label: override.account ?? piLogin, folder: null } : folder;

	const providerName = (id: string) => providers.get(id)?.auth.oauth?.name ?? providers.get(id)?.name ?? id;
	// "Claude" rather than "Anthropic (Claude Pro/Max)", for tight spots.
	const shortName = (id: string) => AGENT_NAMES[id] ?? (providers.get(id)?.name ?? id).replace(/\s*\(.*\)$/, "");
	// "OpenAI · ChatGPT subscription or API key": the provider and how it can sign in.
	const signInLabel = (id: string) => {
		const { oauth, apiKey } = providers.get(id)?.auth ?? {};
		const subscription = oauth && (/\(([^)]+)\)/.exec(oauth.name)?.[1] ?? "subscription");
		const key = apiKey && (/API key$/i.test(apiKey.name) ? "API key" : apiKey.name.replace(/^AWS credentials or bearer token$/, "token or AWS profile"));
		return `${providers.get(id)?.name ?? id} · ${[subscription, key].filter(Boolean).join(" or ")}`;
	};

	// The profile's credential for a provider, resolved the way Pi resolves its own:
	// subscriptions through the provider's OAuth, API keys (and Bedrock's AWS settings)
	// through its key resolver. Throws when the profile has none, so nothing falls back.
	const resolveKey = async (account: string, base: Provider, credential: ApiKeyCredential, ctx: AuthContext, signal: AbortSignal) => {
		// A stored key is passed explicitly and wins. Settings like AWS_PROFILE don't: Pi lets
		// shell credentials override them, so refuse rather than run on a personal one.
		if (!credential.key && credential.env) {
			for (const name of AMBIENT_CREDENTIALS[base.id] ?? []) {
				if (!credential.env[name] && (await ctx.env(name))) {
					throw new Error(`agent-hopper: ${name} is set in this shell and would override profile "${account}"'s ${shortName(base.id)} settings. Unset it, or sign "${account}" in with a token.`);
				}
			}
		}
		return base.auth.apiKey?.resolve({ ctx, credential, signal });
	};

	// Tries a new key before it's saved: a free GET where the provider has one, otherwise
	// a one-token request through Pi's own client, sent the way real requests are.
	const checkKey = async (ctx: ExtensionContext, account: string, base: Provider, credential: ApiKeyCredential): Promise<KeyCheck> => {
		const signal = AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS);
		try {
			const resolved = await resolveKey(account, base, credential, processAuthContext, signal);
			if (!resolved) return { ok: false, rejected: true, message: "the provider found no usable credential" };
			const { apiKey, headers, baseUrl } = resolved.auth;
			const check = apiKey && KEY_CHECKS[base.id];
			if (check) {
				const [url, probeHeaders] = check(apiKey);
				const response = await fetch(url, { headers: probeHeaders, signal });
				if (response.ok) return { ok: true, how: "key accepted" };
				const body = await response.text();
				let detail = body.slice(0, 200);
				try {
					const { error, message } = JSON.parse(body);
					detail = error?.message ?? message ?? detail;
				} catch {}
				const message = `${response.status}: ${detail}`;
				return { ok: false, rejected: response.status === 401 || response.status === 403, message };
			}
			const models = ctx.modelRegistry.getAll().filter((m) => m.provider === base.id);
			const model = ctx.model?.provider === base.id ? ctx.model : models.sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0))[0];
			if (!model) return { ok: false, rejected: false, message: "no model to test with" };
			const reply = await completeSimple(
				{ ...model, baseUrl: baseUrl ?? model.baseUrl },
				{ messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
				{ apiKey, headers, env: resolved.env, maxTokens: 16, signal },
			);
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				return { ok: false, rejected: false, message: reply.errorMessage ?? reply.stopReason };
			}
			return { ok: true, how: `${model.id} answered` };
		} catch (error) {
			return { ok: false, rejected: false, message: (error as Error).message };
		}
	};

	const profileAuth = async (account: string, base: Provider, ctx: AuthContext, signal: AbortSignal): Promise<AuthResult> => {
		const { oauth, apiKey } = base.auth;
		const credential = await store.fresh(account, base.id, oauth);
		const source = `agent-hopper: ${account}`;
		if (credential?.type === "oauth" && oauth) return { auth: await oauth.toAuth(credential), source };
		const result = credential?.type === "api_key" ? await resolveKey(account, base, credential, ctx, signal) : undefined;
		if (!result) throw new Error(`agent-hopper: profile "${account}" has no ${shortName(base.id)} login. Run /hop to sign in.`);
		return { ...result, source };
	};

	const BLOCKED_MESSAGE = 'agent-hopper: this folder has no profile, so no login is used. Run /hop → Switch profile, or map the folder in agent-hopper.json.';

	const wrap = (base: Provider): Provider => {
		const { oauth, apiKey } = base.auth;
		const auth: ProviderAuth = {
			...base.auth,
			...(oauth && {
				oauth: {
					...oauth,
					// Pi has its own stored login for this provider: swap in the account's.
					toAuth: async (credential) => {
						const { account, blocked } = selection();
						if (blocked) throw new Error(BLOCKED_MESSAGE);
						if (!account) return oauth.toAuth(credential);
						return (await profileAuth(account, base, processAuthContext, AbortSignal.timeout(15_000))).auth;
					},
				},
			}),
			apiKey: {
				...apiKey,
				name: apiKey?.name ?? oauth?.name ?? base.name,
				// Pi has a stored API key, or nothing stored (ambient env keys): same swap.
				resolve: async (input): Promise<AuthResult | undefined> => {
					const { account, blocked } = selection();
					if (blocked) throw new Error(BLOCKED_MESSAGE);
					if (account) return profileAuth(account, base, input.ctx, input.signal);
					return apiKey?.resolve(input);
				},
			},
		};
		return Object.assign(Object.create(Object.getPrototypeOf(base)), base, { auth, [BASE]: base });
	};

	const installWrappers = (ctx: ExtensionContext) => {
		providers.clear();
		for (const id of new Set(ctx.modelRegistry.getAll().map((m) => m.provider))) {
			const current = ctx.modelRegistry.getProvider(id) as (Provider & { [BASE]?: Provider }) | undefined;
			const base = current?.[BASE] ?? current;
			if (!base?.auth.oauth && !base?.auth.apiKey) continue;
			providers.set(id, base);
			pi.registerProvider(wrap(base));
		}
	};

	const hasLogin = (account: string, providerId: string) => !!store.read(account)[providerId];

	const piHasLogin = (ctx: ExtensionContext, providerId: string) =>
		ctx.modelRegistry.getProviderAuthStatus(providerId).source === "stored";

	// Why the current model can't run under the current selection, if it can't.
	const blocker = (ctx: ExtensionContext): string | undefined => {
		if (configError) return configError;
		// Blocks every provider, not just wrapped ones: env/API-key logins are personal too.
		if (selection().blocked) return BLOCKED_MESSAGE;
		const { account, label } = selection();
		const provider = ctx.model?.provider;
		if (!account || !provider || !providers.has(provider) || hasLogin(account, provider)) return;
		const name = providerName(provider);
		// The easy mistake: signing in with Pi's /login, which saves Pi's own login, not this account's.
		const hint = piHasLogin(ctx, provider)
			? ` Pi's /login saved Pi's built-in login, not "${label}". Run /hop to sign in, or map this folder to "${piLogin}" to use Pi's login.`
			: " Run /hop to sign in.";
		return `Profile "${label}" has no ${name} login.${hint}`;
	};

	// Configured color, else a gradient for Pi's own login and a stable palette color for clients.
	const autoColorFor = (profile: string): Color => {
		if (profile === piLogin) return PI_LOGIN_GRADIENT;
		const hash = [...profile].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
		return PALETTE[hash % PALETTE.length];
	};

	const colorFor = (profile: string): Color | undefined => {
		const configured = colors[profile];
		if (configured) return configured === "none" ? undefined : configured;
		return autoColorFor(profile);
	};

	const showStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (configError) return ctx.ui.setStatus(STATUS_KEY, "hop config error");
		if (selection().blocked) {
			return ctx.ui.setStatus(STATUS_KEY, `hop ${badge("NO PROFILE", BLOCKED_COLOR)} prompts blocked, run /hop`);
		}
		const { account, label } = selection();
		const color = colorFor(label);
		const tag = `hop ${badge(label, color)}${override ? " (switched)" : ""}`;
		const provider = ctx.model?.provider;
		const configuredAgent = provider ? (agentColors[provider] ?? AGENT_COLORS[provider]) : undefined;
		const agentColor = configuredAgent === "none" ? undefined : configuredAgent;
		const model = ctx.model ? tint(ctx.model.id, agentColor) : undefined;
		if (!provider || !providers.has(provider)) return ctx.ui.setStatus(STATUS_KEY, model ? `${tag} · ${model}` : tag);
		// Pi's own login also counts env keys and ambient AWS credentials.
		const signedIn = account ? hasLogin(account, provider) : ctx.modelRegistry.getProviderAuthStatus(provider).configured;
		// "Anthropic (Claude Pro/Max)" → "Claude Pro/Max": the subscription is the useful part.
		const name = providerName(provider);
		const keyed = account && store.read(account)[provider]?.type === "api_key" && providers.get(provider)?.auth.oauth;
		const subscription = keyed ? `${providers.get(provider)?.name ?? shortName(provider)} API key` : (/\(([^)]+)\)/.exec(name)?.[1] ?? name);
		// Signed in is the normal state, so it gets no marker; only a missing login is flagged (in red).
		const state = signedIn
			? `\x1b[1m${tint(subscription, agentColor)}\x1b[22m`
			: `\x1b[2;9m${subscription}\x1b[22;29m ${tint("✗ not signed in", BLOCKED_COLOR)}`;
		ctx.ui.setStatus(STATUS_KEY, `${tag} · ${model} · ${state}`);
	};

	const loadFolder = (ctx: ExtensionContext) => {
		try {
			const config = loadConfig();
			piLogin = config.piLogin ?? RESERVED_ACCOUNT;
			colors = config.colors ?? {};
			agentColors = config.agentColors ?? {};
			configProfiles = [...Object.values(config.folders), ...Object.keys(config.colors ?? {})];
			folder = folderSelection(ctx.cwd, config);
			configError = undefined;
		} catch (error) {
			configError = `agent-hopper: ${(error as Error).message}`;
			ctx.ui.notify(configError, "error");
		}
	};

	// Overrides belong to this exact session; forks and clones start from the folder.
	const restoreOverride = (ctx: ExtensionContext) => {
		override = undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "custom" || entry.customType !== OVERRIDE_ENTRY) continue;
			const data = entry.data as { sessionId?: string; override?: { account: string | null } | null };
			if (data?.sessionId !== sessionId) continue;
			override = data.override ?? undefined;
			return;
		}
	};

	const setOverride = (ctx: ExtensionContext, next: { account: string | null } | undefined) => {
		// Picking the folder's own profile drops the switch; a blocked folder has none to pick.
		override = next && !folder.blocked && next.account === folder.account ? undefined : next;
		pi.appendEntry(OVERRIDE_ENTRY, { sessionId: ctx.sessionManager.getSessionId(), override: override ?? null });
		showStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		writeExample();
		installWrappers(ctx);
		loadFolder(ctx);
		restoreOverride(ctx);
		showStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => showStatus(ctx));

	// Never send a prompt that would run on the wrong login.
	pi.on("input", (_event, ctx) => {
		showStatus(ctx); // logins made outside /hop (e.g. Pi's /login) emit no event
		const reason = blocker(ctx);
		if (!reason) return { action: "continue" };
		ctx.ui.notify(reason.startsWith("agent-hopper") ? reason : `agent-hopper: ${reason}`, "error");
		return { action: "handled" };
	});

	const summary = (ctx: ExtensionContext): string => {
		const { account, label, folder: path, blocked } = selection();
		const where = override ? "switched for this session" : (path ?? "no matching folder");
		if (blocked) {
			return [`${label} · ${where}`, "This folder has no profile, so prompts are blocked.", "Switch profile for this session, or add the folder to agent-hopper.json."].join("\n");
		}
		const piLogins = [...providers.keys()].filter((id) => piHasLogin(ctx, id));
		const ids = [...new Set([...piLogins, ...(account ? Object.keys(store.read(account)) : []), ...(ctx.model?.provider && providers.has(ctx.model.provider) ? [ctx.model.provider] : [])])];
		const width = Math.max(0, ...ids.map((id) => providerName(id).length));
		const row = (id: string, credential: Credential | boolean | undefined) =>
			`  ${providerName(id).padEnd(width)}  ${!credential ? "✗ not signed in" : typeof credential === "object" && credential.type === "api_key" ? "✓ API key" : "✓ signed in"}`;

		if (!account) {
			const rows = ids.map((id) => row(id, piLogins.includes(id)));
			const hint = existsSync(configPath()) ? [] : rows.length ? ["", setupHint()] : [setupHint()];
			return [`${label} · ${where}`, "Uses Pi's own login. Sign in with /login.", "", ...rows, ...hint].join("\n");
		}
		const logins = store.read(account);
		const rows = ids.filter((id) => logins[id] || id === ctx.model?.provider).map((id) => row(id, logins[id]));
		const lines = [`${label} · ${where}`, `Profile "${label}". Sign in with /hop, not /login.`, "", ...(rows.length ? rows : ["  No logins yet"])];
		if (piLogins.length) lines.push("", `  \x1b[2mIgnored here: /login (${piLogins.map(shortName).join(", ")})\x1b[22m`);
		return lines.join("\n");
	};

	const chooseAccount = async (ctx: ExtensionContext, title: string): Promise<string | null | undefined> => {
		const { account: current, blocked } = selection();
		const builtInLabel = piLogin === RESERVED_ACCOUNT ? "Pi built-in login" : `${piLogin} (Pi's /login)`;
		// Saved profiles plus any the config names, so a client shows up before its first sign-in.
		const named = [...new Set([...store.list(), ...configProfiles])]
			.filter((n) => n !== piLogin && n !== RESERVED_ACCOUNT && n !== BLOCK)
			.sort();
		const names: Array<string | null> = [...named, null];
		const labels = names.map((n) => `${n === current && !blocked ? "✓ " : "  "}${n ?? builtInLabel}`);
		const NEW = "  New profile";
		const choice = await ctx.ui.select(title, [...labels, NEW]);
		if (!choice) return undefined;
		if (choice !== NEW) return names[labels.indexOf(choice)];
		const name = (await ctx.ui.input("Profile name", "e.g. acme"))?.trim();
		if (!name) return undefined;
		if (name === RESERVED_ACCOUNT || name === BLOCK || name === piLogin || !ACCOUNT_NAME.test(name)) {
			ctx.ui.notify(`agent-hopper: profile names use letters, numbers, ".", "_" or "-" ("${RESERVED_ACCOUNT}", "${BLOCK}" and "${piLogin}" are taken)`, "error");
			return undefined;
		}
		await store.modify(name, async (data) => data); // save it now, before any sign-in
		if (!colors[name]) await pickColor(ctx, name); // Esc keeps the automatic color
		return name;
	};

	const pickColor = async (ctx: ExtensionContext, profile: string) => {
		const configured = colors[profile];
		const AUTO = "Automatic";
		const CUSTOM = "  Custom hex color";
		const entries: Array<[string, Color | undefined]> = [[AUTO, undefined], ...SWATCHES];
		const width = Math.max(...entries.map(([n]) => n.length));
		const isCurrent = (c: Color | undefined) => JSON.stringify(c) === JSON.stringify(configured);
		const labels = entries.map(([n, c]) => `${isCurrent(c) ? "✓ " : "  "}${n.padEnd(width)}  ${badge(profile, c ?? autoColorFor(profile))}`);
		const choice = await ctx.ui.select(`Footer color for "${profile}"`, [...labels, CUSTOM]);
		if (!choice) return;

		let color: Color | undefined;
		if (choice === CUSTOM) {
			const input = (await ctx.ui.input("Hex color, or several for a gradient", "#30a46c   or   #ffc53d, #d6409f"))?.trim();
			if (!input) return;
			const parts = input.split(/[\s,]+/).filter(Boolean).map((p) => (p.startsWith("#") ? p : `#${p}`));
			if (!parts.every((p) => HEX.test(p))) {
				ctx.ui.notify(`agent-hopper: "${input}" isn't a hex color like #30a46c`, "error");
				return;
			}
			color = parts.length === 1 ? parts[0] : parts;
		} else {
			color = entries[labels.indexOf(choice)][1];
		}

		try {
			saveColor(profile, color);
		} catch (error) {
			ctx.ui.notify(`agent-hopper: couldn't save the color: ${(error as Error).message}`, "error");
			return;
		}
		loadFolder(ctx);
		showStatus(ctx);
	};

	const chooseProvider = async (ctx: ExtensionContext, title: string, ids: string[], label: (id: string) => string = providerName): Promise<string | undefined> => {
		const sorted = [...ids].sort((a, b) => Number(b === ctx.model?.provider) - Number(a === ctx.model?.provider));
		const labels = sorted.map(label);
		const choice = await ctx.ui.select(title, labels);
		return choice ? sorted[labels.indexOf(choice)] : undefined;
	};

	const login = async (ctx: ExtensionContext, account: string) => {
		const providerId = await chooseProvider(ctx, `Sign "${account}" in to which provider?`, [...providers.keys()], signInLabel);
		const provider = providerId && providers.get(providerId);
		if (!providerId || !provider) return;
		const { oauth, apiKey } = provider.auth;
		const SUBSCRIPTION = oauth?.loginLabel ?? "Subscription (browser sign-in)";
		const KEY = "API key";
		const method = oauth && apiKey ? await ctx.ui.select(`How should "${account}" sign in to ${shortName(providerId)}?`, [SUBSCRIPTION, KEY]) : oauth ? SUBSCRIPTION : KEY;
		if (!method) return;
		const controller = new AbortController();
		const interaction = loginInteraction(ctx, controller.signal);
		try {
			let credential: Credential;
			if (method === SUBSCRIPTION && oauth) {
				credential = await oauth.login(interaction, {
					getDeviceId: () => SettingsManager.create(ctx.cwd, getAgentDir()).getOrCreateDeviceId(),
				});
			} else if (apiKey?.login) {
				credential = await apiKey.login(interaction); // e.g. Bedrock: bearer token or AWS profile
			} else {
				const key = (await interaction.prompt({ type: "secret", message: `${shortName(providerId)} API key` })).trim();
				if (!key) return;
				credential = { type: "api_key", key } satisfies ApiKeyCredential;
			}
			let verified = "";
			if (credential.type === "api_key") {
				ctx.ui.notify(`agent-hopper: checking the ${provider.name} key with the provider`, "info");
				const check = await checkKey(ctx, account, provider, credential);
				if (!check.ok && check.rejected) {
					ctx.ui.notify(`agent-hopper: ${provider.name} rejected the key, so it wasn't saved (${check.message})`, "error");
					return;
				}
				if (!check.ok && !(await ctx.ui.confirm(`Couldn't verify the ${provider.name} key`, `${check.message}\n\nSave it anyway?`))) return;
				verified = check.ok ? ` (checked: ${check.how})` : " (unverified)";
			}
			await store.modify(account, async (data) => ({ ...data, [providerId]: credential }));
			const what = method === KEY ? `${provider.name} API key` : shortName(providerId);
			ctx.ui.notify(`agent-hopper: "${account}" now uses its ${what}${verified}`, "info");
		} catch (error) {
			if ((error as Error).message !== "Login cancelled") ctx.ui.notify(`agent-hopper: ${shortName(providerId)} login failed: ${(error as Error).message}`, "error");
		} finally {
			controller.abort();
		}
		showStatus(ctx);
	};

	const logout = async (ctx: ExtensionContext, account: string) => {
		const providerId = await chooseProvider(ctx, `Sign "${account}" out of which provider?`, Object.keys(store.read(account)));
		if (!providerId) return;
		await store.modify(account, async ({ [providerId]: _removed, ...rest }) => rest);
		ctx.ui.notify(`agent-hopper: "${account}" is signed out of ${providerName(providerId)}`, "info");
		showStatus(ctx);
	};

	pi.registerCommand("hop", {
		description: "Show, switch, or sign in to this session's profile",
		handler: async (_args, ctx) => {
			loadFolder(ctx);
			if (!ctx.hasUI) {
				ctx.ui.notify(configError ?? summary(ctx), "info");
				return;
			}
			if (configError) return;
			const { account, label, blocked } = selection();
			const SWITCH = "Switch profile";
			const COLOR = `Change "${label}" color`;
			const LOGIN = `Sign "${label}" into a provider`;
			const LOGOUT = `Sign "${label}" out of a provider`;
			const piSignedIn = !account && !blocked && [...providers.keys()].some((id) => piHasLogin(ctx, id));
			const RESET = "Back to folder mapping";
			const options = [
				SWITCH,
				...(blocked ? [] : [LOGIN]),
				...((account && Object.keys(store.read(account)).length) || piSignedIn ? [LOGOUT] : []),
				...(blocked ? [] : [COLOR]),
				...(override ? [RESET] : []),
			];
			const choice = await ctx.ui.select(summary(ctx), options);
			if (choice === SWITCH) {
				const next = await chooseAccount(ctx, "Use which profile for this session?");
				if (next !== undefined) setOverride(ctx, { account: next });
			} else if (choice === LOGIN && !account) {
				// Pi's own login is signed in with Pi's /login, which extensions can't call directly.
				ctx.ui.setEditorText("/login");
				ctx.ui.notify(`agent-hopper: "${label}" uses Pi's own login. Press Enter to run /login and pick the provider.`, "info");
			} else if (choice === LOGIN && account) {
				await login(ctx, account);
			} else if (choice === LOGOUT && account) {
				await logout(ctx, account);
			} else if (choice === LOGOUT) {
				// Likewise, Pi's own login is signed out with Pi's /logout.
				ctx.ui.setEditorText("/logout");
				ctx.ui.notify(`agent-hopper: "${label}" uses Pi's own login. Press Enter to run /logout and pick the provider.`, "info");
			} else if (choice === COLOR) {
				await pickColor(ctx, label);
			} else if (choice === RESET) {
				setOverride(ctx, undefined);
			}
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		for (const id of providers.keys()) pi.unregisterProvider(id);
		providers.clear();
		override = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
