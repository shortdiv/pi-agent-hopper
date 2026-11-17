import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

// One file per account, shaped like Pi's auth.json: { [providerId]: Credential }.
// Writes and refreshes happen under a cross-process lock so concurrent Pi
// sessions on the same account never race a rotating refresh token.

export type AccountCredentials = Record<string, Credential>;

export const ACCOUNT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const RESERVED_ACCOUNT = "default";
export const BLOCK = "block";

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;
const REFRESH_TIMEOUT_MS = 15_000;
const MIN_VALIDITY_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AccountStore {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private path(account: string): string {
		if (!ACCOUNT_NAME.test(account) || account === RESERVED_ACCOUNT || account === BLOCK) {
			throw new Error(`Invalid account name "${account}"`);
		}
		return join(this.dir, `${account}.json`);
	}

	list(): string[] {
		try {
			return readdirSync(this.dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -5))
				.sort();
		} catch {
			return [];
		}
	}

	read(account: string): AccountCredentials {
		try {
			return JSON.parse(readFileSync(this.path(account), "utf8")) as AccountCredentials;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	async modify(
		account: string,
		fn: (data: AccountCredentials) => Promise<AccountCredentials | undefined>,
	): Promise<AccountCredentials> {
		const file = this.path(account);
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const release = await lock(`${file}.lock`);
		try {
			const current = this.read(account);
			const next = await fn(current);
			if (!next) return current;
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			renameSync(tmp, file);
			return next;
		} finally {
			release();
		}
	}

	// Returns the credential, with an OAuth one valid for at least five minutes: it's
	// refreshed under the lock (and re-checked there, so only one process refreshes).
	// API keys don't expire here and are returned as stored.
	async fresh(account: string, providerId: string, oauth: OAuthAuth | undefined): Promise<Credential | undefined> {
		const expiresSoon = (c: Credential | undefined): c is OAuthCredential =>
			c?.type === "oauth" && !!oauth && Date.now() + MIN_VALIDITY_MS >= c.expires;
		const stored = this.read(account)[providerId];
		if (!expiresSoon(stored)) return stored;
		const data = await this.modify(account, async (current) => {
			const credential = current[providerId];
			if (!expiresSoon(credential)) return undefined;
			return { ...current, [providerId]: await oauth!.refresh(credential, AbortSignal.timeout(REFRESH_TIMEOUT_MS)) };
		});
		return data[providerId];
	}
}

async function lock(path: string): Promise<() => void> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			mkdirSync(path);
			return () => rmSync(path, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { recursive: true, force: true });
			} catch {}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
			await sleep(50 + Math.random() * 100);
		}
	}
}
