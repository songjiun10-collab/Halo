"use strict";

// Web Bot Auth primitives. The first vectors are the reference implementation's
// own test data (cloudflare/web-bot-auth, packages/web-bot-auth/test/test_data),
// so the wire format is pinned to an independent implementation, not to ours.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPrivateKey, sign } = require("node:crypto");
const {
  buildDirectoryResponseHeaders,
  buildWebBotAuthHeaders,
  createRequestSigner,
  jwkThumbprint,
  verifyDirectoryResponse,
  verifyWebBotAuthHeaders,
} = require("../main/harness/web-bot-auth");

const VECTOR_KEY = {
  kty: "OKP",
  crv: "Ed25519",
  d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};
const VECTOR_KEY_ID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const VECTOR_KEY_PEM = createPrivateKey({ key: VECTOR_KEY, format: "jwk" }).export({ type: "pkcs8", format: "pem" }).toString();

test("jwkThumbprint matches the reference Ed25519 thumbprint", () => {
  assert.equal(jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: VECTOR_KEY.x }), VECTOR_KEY_ID);
});

test("the reference Ed25519 request vector signs byte-for-byte", () => {
  const headers = buildWebBotAuthHeaders({
    url: "https://example.com/path/to/resource",
    directoryUrl: "https://signature-agent.test",
    keyId: VECTOR_KEY_ID,
    privateKeyPem: VECTOR_KEY_PEM,
    includeSignatureAgent: false,
    created: 1735689600,
    expires: 4889289600,
    nonce: "zIW8+cdmA3vdYagbxojpONwa/l0EKJ/O3/wD486VvsQjO/RxPaSt6ZxvQaMcQzNnqKN/mQ6hpGiFro2L2qkz5A==",
  });
  assert.equal(
    headers["Signature-Input"],
    `sig1=("@authority");created=1735689600;keyid="${VECTOR_KEY_ID}";alg="ed25519";expires=4889289600;nonce="zIW8+cdmA3vdYagbxojpONwa/l0EKJ/O3/wD486VvsQjO/RxPaSt6ZxvQaMcQzNnqKN/mQ6hpGiFro2L2qkz5A==";tag="web-bot-auth"`,
  );
  assert.equal(headers.Signature, "sig1=:QKN4fTdIYfh82fvoZCQiQA1weuozfCS/Led2zTMbewMMqH8PI2Wsy/5c4ao6B6D09nraNQdBNOADg8aM1MqfCg==:");
  assert.equal(headers["Signature-Agent"], undefined);
});

test("the reference directory response vector signs byte-for-byte", () => {
  const body = `{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"${VECTOR_KEY_ID}","x":"${VECTOR_KEY.x}","use":"sig"}]}`;
  const headers = buildDirectoryResponseHeaders({
    authority: "signature-agent.test",
    keyId: VECTOR_KEY_ID,
    privateKeyPem: VECTOR_KEY_PEM,
    body,
    created: 1735689600,
    expires: 4889289600,
  });
  assert.equal(headers["Content-Digest"], "sha-256=:CADMT2aBdV/rqQr/NIru64ERQkCobVvllA4V0fLFDu0=:");
  assert.equal(
    headers["Signature-Input"],
    `binding0=("@authority";req "content-digest");created=1735689600;keyid="${VECTOR_KEY_ID}";alg="ed25519";expires=4889289600;tag="http-message-signatures-directory"`,
  );
  assert.equal(headers.Signature, "binding0=:yiHq0TXrbpzbmlttAQMpYoAufitFJUWuNsakB7QQMoN0EHbo5o51bZRVR8az/ptTWCwllix9clrKXfGKwdPzBg==:");
});

test("a directory response verifies against its own key, and tampering fails", () => {
  const body = `{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"${VECTOR_KEY_ID}","x":"${VECTOR_KEY.x}","use":"sig"}]}`;
  const directoryUrl = "https://signature-agent.test/.well-known/http-message-signatures-directory";
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: VECTOR_KEY.x };
  const built = buildDirectoryResponseHeaders({
    authority: "signature-agent.test",
    keyId: VECTOR_KEY_ID,
    privateKeyPem: VECTOR_KEY_PEM,
    body,
    created: 1735689600,
    expires: 4889289600,
  });
  const at = 1735689700 * 1000;
  assert.ok(verifyDirectoryResponse({ directoryUrl, headers: built, body, publicJwk, now: at }));
  assert.equal(verifyDirectoryResponse({ directoryUrl, headers: built, body: `${body} `, publicJwk, now: at }), false, "a changed body fails the digest");
  assert.equal(verifyDirectoryResponse({ directoryUrl: "https://other.test/x", headers: built, body, publicJwk, now: at }), false, "the authority is covered");
  assert.equal(verifyDirectoryResponse({ directoryUrl, headers: { ...built, Signature: built.Signature.replace("binding0=:", "binding0=:A") }, body, publicJwk, now: at }), false, "a changed signature fails");
  assert.equal(verifyDirectoryResponse({ directoryUrl, headers: built, body, publicJwk, now: 4890000000 * 1000 }), false, "an expired response fails");
});

test("an authority-only directory response (Cloudflare reference server format) verifies", () => {
  const authority = "signature-agent.test";
  const created = 1735689600;
  const expires = 4889289600;
  const params = `("@authority";req);created=${created};keyid="${VECTOR_KEY_ID}";alg="ed25519";expires=${expires};tag="http-message-signatures-directory"`;
  const base = `"@authority";req: ${authority}\n"@signature-params": ${params}`;
  const signature = sign(null, Buffer.from(base, "utf8"), createPrivateKey({ key: VECTOR_KEY, format: "jwk" })).toString("base64");
  const headers = { "Signature-Input": `binding0=${params}`, Signature: `binding0=:${signature}:` };
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: VECTOR_KEY.x };
  assert.ok(verifyDirectoryResponse({ authority, headers, body: "{}", publicJwk, now: created * 1000 }));
  assert.equal(verifyDirectoryResponse({ authority: "other.test", headers, body: "{}", publicJwk, now: created * 1000 }), false);
});

test("createRequestSigner loads a stable key and round-trips through verification", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-wba-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "web-bot-auth-key.pem");
  const signer = await createRequestSigner({ keyFile, directoryUrl: "https://agent.example.org" });
  assert.match(signer.keyId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, "the key file is private");
  assert.equal(JSON.parse(signer.directoryJson).keys[0].kid, signer.keyId);

  const reloaded = await createRequestSigner({ keyFile, directoryUrl: "https://agent.example.org" });
  assert.equal(reloaded.keyId, signer.keyId, "the same key is reused on later runs");
  await assert.rejects(
    createRequestSigner({ keyFile: path.join(dir, "other-key.pem"), directoryUrl: "http://agent.example.org" }),
    /web_bot_auth_directory_must_be_https/,
  );

  const now = Date.now();
  const headers = signer.sign("https://news.example.com/article/42", { now });
  assert.equal(headers["Signature-Agent"], '"https://agent.example.org"');
  assert.match(headers["Signature-Input"], /^sig1=\("@authority" "signature-agent"\);created=\d+;keyid="[A-Za-z0-9_-]+";alg="ed25519";expires=\d+;nonce="[^"]+";tag="web-bot-auth"$/);
  assert.ok(verifyWebBotAuthHeaders({ url: "https://news.example.com/article/42", headers, publicJwk: signer.publicJwk, now }));

  assert.equal(verifyWebBotAuthHeaders({ url: "https://other.example.com/article/42", headers, publicJwk: signer.publicJwk, now }), false, "authority is covered by the signature");
  const tampered = { ...headers, Signature: headers.Signature.replace("sig1=:", "sig1=:A") };
  assert.equal(verifyWebBotAuthHeaders({ url: "https://news.example.com/article/42", headers: tampered, publicJwk: signer.publicJwk, now }), false, "a changed signature fails");
  assert.equal(verifyWebBotAuthHeaders({ url: "https://news.example.com/article/42", headers, publicJwk: signer.publicJwk, now: now + 10 * 60 * 1000 }), false, "an expired signature fails");
  assert.equal(verifyWebBotAuthHeaders({ url: "https://news.example.com/article/42", headers, publicJwk: { kty: "OKP", crv: "Ed25519", x: VECTOR_KEY.x }, now }), false, "a different key fails");

  assert.equal(signer.sign("ftp://files.example.com/x"), null, "non-http requests are unsigned");
  assert.equal(signer.sign("not a url"), null);
  assert.ok(signer.sign("http://127.0.0.1:8080/page"), "plain http targets can be signed (local testing)");
});
