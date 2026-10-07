import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiwcAuth, verifyIdToken } from "./auth.js";

const temporary: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("SiwcAuth", () => {
  it("clears an unusable rotating refresh token but retains the registered client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-siwc-test-")); temporary.push(dir);
    const credentialPath = join(dir, "auth.json");
    await writeFile(credentialPath, JSON.stringify({ hostId: "urn:uuid:test", profile: { clientId: "oaiapp_test", subject: "subject-1",
      accessToken: "expired-access", refreshToken: "expired-refresh", idToken: "id-token",
      scopes: ["chatgpt.tokens.use.direct"], expiresAt: 0 } }), { mode: 0o600 });
    const auth = new SiwcAuth({ credentialPath, fetch: vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch });
    await expect(auth.accessToken()).rejects.toThrow("session expired");
    const saved = JSON.parse(await readFile(credentialPath, "utf8"));
    expect(saved.registrationClientId).toBe("oaiapp_test");
    expect(saved.profile).toBeUndefined();
  });

  it("rejects a forged ID-token signature", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encoded({ alg: "RS256", kid: "key" })}.${encoded({ iss: "https://auth.openai.com", aud: "client", sub: "x", nonce: "n", exp: Math.floor(Date.now() / 1000) + 3600 })}.${Buffer.from("forged").toString("base64url")}`;
    await expect(verifyIdToken(token, "client", "n", vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "key" }] })) as typeof fetch))
      .rejects.toThrow("validation failed");
  });

  it("validates state, PKCE, signed identity, scope, and protects the saved credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-siwc-test-")); temporary.push(dir);
    const credentialPath = join(dir, "auth.json");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    let authorize!: URL;
    let refreshes = 0;
    let revokedToken: string | undefined;
    const http = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith("openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
      if (String(url).endsWith("oauth/revoke")) {
        revokedToken = (init!.body as URLSearchParams).get("token") ?? undefined;
        return new Response(null, { status: 200 });
      }
      if (String(url).endsWith("jwks.json")) return Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
      if (String(url).endsWith("oauth/token")) {
        const body = init!.body as URLSearchParams;
        if (body.get("grant_type") === "refresh_token") {
          refreshes++;
          expect(body.get("refresh_token")).toBe("private-refresh");
          return Response.json({ access_token: "renewed-access", refresh_token: "renewed-refresh", token_type: "Bearer",
            scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct", expires_in: 3600 });
        }
        expect(body.get("code_verifier")).toBeTruthy();
        expect(body.get("client_id")).toBe("oaiapp_test");
        expect(body.get("redirect_uri")).toBe(authorize.searchParams.get("redirect_uri"));
        const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const header = encoded({ alg: "RS256", kid: "test-key" });
        const payload = encoded({ iss: "https://auth.openai.com", aud: "oaiapp_test", sub: "subject-1",
          email: "a@example.com", nonce: authorize.searchParams.get("nonce"), exp: Math.floor(Date.now() / 1000) + 3600 });
        const jwt = `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" }))).toString("base64url")}`;
        return Response.json({ access_token: "private-access", refresh_token: "private-refresh", id_token: jwt,
          token_type: "Bearer", scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct", expires_in: 3600 });
      }
      throw new Error("unexpected URL");
    });
    const auth = new SiwcAuth({ credentialPath, fetch: http as typeof fetch });
    const status = await auth.login({ openUrl: async (url) => {
      authorize = new URL(url);
      expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", "incorrect");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      callback.searchParams.set("code", "one-use-code");
      callback.searchParams.set("client_id", "oaiapp_test");
      expect((await fetch(callback)).status).toBe(200);
    } });
    expect(status).toMatchObject({ connected: true, sharing: true, email: "a@example.com" });
    expect(await auth.accessToken()).toBe("private-access");
    const saved = JSON.parse(await readFile(credentialPath, "utf8"));
    expect(saved.profile.refreshToken).toBe("private-refresh");
    expect(saved.hostId).toMatch(/^urn:uuid:/);
    if (process.platform !== "win32") expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    saved.profile.expiresAt = Date.now() - 1;
    await writeFile(credentialPath, JSON.stringify(saved));
    const secondProcess = new SiwcAuth({ credentialPath, fetch: http as typeof fetch });
    expect(await Promise.all([auth.accessToken(), secondProcess.accessToken()])).toEqual(["renewed-access", "renewed-access"]);
    expect(refreshes).toBe(1);
    expect(await auth.logout()).toEqual({ remoteRevocationConfirmed: true });
    expect(revokedToken).toBe("renewed-refresh");
    await expect(auth.accessToken()).rejects.toThrow("Continue with ChatGPT");
  });
});
