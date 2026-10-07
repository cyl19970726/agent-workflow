import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export interface SiwcProfile {
  clientId: string;
  subject: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scopes: string[];
  expiresAt: number;
}

type Stored = { hostId: string; registrationClientId?: string; profile?: SiwcProfile };
type TokenResult = { access_token?: string; refresh_token?: string; id_token?: string; scope?: string; token_type?: string; expires_in?: number; earliest_refresh_at?: number };
type Jwk = { kty: string; kid?: string; alg?: string; use?: string; n?: string; e?: string };
class SiwcTokenError extends Error { constructor(readonly code: string, status: number) { super(`ChatGPT token request failed (${status}; ${code})`); } }
const expiredRefreshCodes = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

/** Local owner-only credentials. Never include this object in workflow metadata or trace. */
export class SiwcAuth {
  private readonly path: string;
  constructor(options: { credentialPath?: string; fetch?: typeof fetch } = {}) {
    this.path = options.credentialPath ?? join(homedir(), ".config", "creator-lab", "workflow-siwc.json");
    this.http = options.fetch ?? fetch;
  }
  private readonly http: typeof fetch;

  async status(): Promise<{ connected: boolean; email?: string; clientId?: string; sharing: boolean; expiresAt?: number }> {
    const profile = (await this.load())?.profile;
    return { connected: !!profile, email: profile?.email, clientId: profile?.clientId,
      sharing: !!profile?.scopes.includes("chatgpt.tokens.use.direct"), expiresAt: profile?.expiresAt };
  }

  async logout(): Promise<{ remoteRevocationConfirmed: boolean }> {
    return this.withCredentialLock(async () => {
      const record = await this.load();
      if (!record) return { remoteRevocationConfirmed: true };
      let remoteRevocationConfirmed = !record.profile?.refreshToken;
      if (record.profile?.refreshToken) {
        try {
          const discovery = await this.http(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(30_000) });
          if (!discovery.ok) throw new Error("ChatGPT discovery unavailable");
          const endpoint = (await discovery.json() as { revocation_endpoint?: string }).revocation_endpoint;
          if (!endpoint || new URL(endpoint).origin !== ISSUER) throw new Error("Invalid ChatGPT revocation endpoint");
          const response = await this.http(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: record.profile.refreshToken, token_type_hint: "refresh_token", client_id: record.profile.clientId }) });
          remoteRevocationConfirmed = response.ok;
        } catch { remoteRevocationConfirmed = false; }
      }
      await this.save({ hostId: record.hostId, registrationClientId: record.profile?.clientId ?? record.registrationClientId });
      return { remoteRevocationConfirmed };
    });
  }

  async accessToken(): Promise<string> {
    const record = await this.load();
    const profile = record?.profile;
    if (!profile) throw new Error("Continue with ChatGPT is required. Run workflow-siwc login.");
    if (!profile.scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage was not granted; reconnect and enable it.");
    if (Date.now() + 90_000 < profile.expiresAt) return profile.accessToken;
    return this.withCredentialLock(async () => {
      const current = await this.load();
      const selected = current?.profile;
      if (!selected) throw new Error("Continue with ChatGPT is required. Run workflow-siwc login.");
      if (!selected.scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage is no longer authorized.");
      if (Date.now() + 90_000 < selected.expiresAt) return selected.accessToken;
      if (!selected.refreshToken) throw new Error("ChatGPT connection expired; run workflow-siwc login.");
      let tokens: TokenResult;
      try {
        tokens = await this.tokenRequest(new URLSearchParams({ grant_type: "refresh_token", client_id: selected.clientId,
          refresh_token: selected.refreshToken, resource: RESOURCE }));
      } catch (error) {
        if (error instanceof SiwcTokenError && expiredRefreshCodes.has(error.code)) {
          await this.save({ hostId: current!.hostId, registrationClientId: selected.clientId });
          throw new Error("ChatGPT session expired; run workflow-siwc login.");
        }
        throw error;
      }
      if (!tokens.access_token || !tokens.refresh_token || !tokens.scope || tokens.token_type?.toLowerCase() !== "bearer" || !tokens.expires_in) {
        throw new Error("Incomplete ChatGPT token refresh; credentials were preserved.");
      }
      const scopes = tokens.scope.split(/\s+/).filter(Boolean);
      const next = { ...selected, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        scopes, expiresAt: Date.now() + tokens.expires_in * 1000 };
      await this.save({ hostId: current!.hostId, profile: next });
      if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage is no longer authorized.");
      return next.accessToken;
    });
  }

  async login(options: { openUrl: (url: string) => Promise<void>; signal?: AbortSignal }): Promise<ReturnType<SiwcAuth["status"]> extends Promise<infer T> ? T : never> {
    const previous = await this.load();
    const hostId = previous?.hostId ?? `urn:uuid:${randomUUID()}`;
    if (!previous) await this.save({ hostId });
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const clientId = previous?.profile?.clientId ?? previous?.registrationClientId ?? "dynamic_agent_client";
    let resolved = false;
    let resolveCallback!: (value: URL) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<URL>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/auth/callback" || resolved) { response.writeHead(404).end(); return; }
      const returnedState = url.searchParams.get("state") ?? "";
      const a = Buffer.from(state); const b = Buffer.from(returnedState);
      if (a.length !== b.length || !timingSafeEqual(a, b)) { response.writeHead(400).end("Invalid authorization state"); return; }
      resolved = true;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ChatGPT authorization received. Return to the terminal.");
      resolveCallback(url);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate loopback callback");
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const authorize = new URL(`${ISSUER}/api/accounts/authorize`);
    authorize.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri,
      scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: challenge,
      ext_agent_host_id: hostId,
      ...(clientId === "dynamic_agent_client" ? { agent_name_hint: "Creator Lab" } : {}),
      ...(previous?.profile?.idToken ? { id_token_hint: previous.profile.idToken } : {}) }).toString();
    const timer = setTimeout(() => rejectCallback(new Error("ChatGPT sign-in timed out")), 10 * 60_000);
    const onAbort = () => rejectCallback(new Error("ChatGPT sign-in canceled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await options.openUrl(authorize.toString());
      const result = await callback;
      const error = result.searchParams.get("error");
      if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
      const code = result.searchParams.get("code");
      const issued = result.searchParams.get("client_id") ?? (clientId === "dynamic_agent_client" ? undefined : clientId);
      if (!code || !issued || issued === "dynamic_agent_client" || (clientId !== "dynamic_agent_client" && issued !== clientId)) {
        throw new Error("ChatGPT authorization returned an incomplete or mismatched registration");
      }
      if (!previous?.profile) await this.save({ hostId, registrationClientId: issued });
      const tokens = await this.tokenRequest(new URLSearchParams({ grant_type: "authorization_code", client_id: issued,
        code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }));
      if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token || !tokens.scope || !tokens.expires_in || tokens.token_type?.toLowerCase() !== "bearer") {
        throw new Error("ChatGPT token exchange returned incomplete credentials");
      }
      const identity = await verifyIdToken(tokens.id_token, issued, nonce, this.http);
      if (previous?.profile && previous.profile.subject !== identity.subject) throw new Error("Reconnected account identity did not match the saved account");
      const profile: SiwcProfile = { clientId: issued, subject: identity.subject, email: identity.email,
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
        scopes: tokens.scope.split(/\s+/).filter(Boolean), expiresAt: Date.now() + tokens.expires_in * 1000 };
      await this.save({ hostId, profile });
      return this.status();
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      server.close();
    }
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenResult> {
    const response = await this.http(TOKEN_URL, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { error?: string | { code?: string }; code?: string } | undefined;
      const code = typeof body?.error === "string" ? body.error : body?.error?.code ?? body?.code ?? "unknown";
      throw new SiwcTokenError(code, response.status);
    }
    return await response.json() as TokenResult;
  }

  private async load(): Promise<Stored | undefined> {
    let stat;
    try { stat = await lstat(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
      throw new Error("ChatGPT credential file must be an owner-only regular file");
    }
    return JSON.parse(await readFile(this.path, "utf8")) as Stored;
  }

  private async save(record: Stored): Promise<void> {
    const dir = dirname(this.path);
    await this.ensurePrivateDir(dir);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await rename(temp, this.path);
    } finally { await rm(temp, { force: true }); }
  }

  private async withCredentialLock<T>(work: () => Promise<T>): Promise<T> {
    const lock = `${this.path}.refresh-lock`;
    const deadline = Date.now() + 90_000;
    await this.ensurePrivateDir(dirname(lock));
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const entry = await lstat(lock).catch(() => undefined);
        if (entry?.isDirectory() && Date.now() - entry.mtimeMs > 65_000) {
          await rmdir(lock).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error("ChatGPT credential refresh is locked; retry shortly");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try { return await work(); }
    finally { await rmdir(lock); }
  }

  private async ensurePrivateDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const entry = await lstat(dir);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (process.platform !== "win32" &&
      ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()))) {
      throw new Error("ChatGPT credential directory must be an owner-only regular directory");
    }
  }
}

export async function verifyIdToken(token: string, audience: string, nonce: string, http: typeof fetch = fetch): Promise<{ subject: string; email?: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid ChatGPT ID token");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>;
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported ChatGPT ID token signature");
  const response = await http(JWKS_URL);
  if (!response.ok) throw new Error("Could not fetch ChatGPT signing keys");
  const keys = (await response.json() as { keys?: Jwk[] }).keys ?? [];
  const jwk = keys.find((item) => item.kid === header.kid && item.kty === "RSA" && (!item.alg || item.alg === "RS256") && (!item.use || item.use === "sig"));
  if (!jwk) throw new Error("ChatGPT ID token signing key was not found");
  const valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk as NodeJsonWebKey, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  const audienceValid = claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience) &&
    (claims.aud.length === 1 || claims.azp === audience));
  if (!valid || claims.iss !== ISSUER || !audienceValid ||
    typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() ||
    (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf * 1000 > Date.now())) ||
    (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat * 1000 > Date.now() + 60_000)) ||
    claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("ChatGPT ID token validation failed");
  }
  return { subject: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined };
}
