# Web Bot Auth signing v1

Opt-in request signing for agent-browser pages, following
`draft-meunier-web-bot-auth-architecture-02` (profiled on RFC 9421) and the
key-directory draft `draft-meunier-http-message-signatures-directory-03`. A site
that verifies the standard — Cloudflare's verified agents/`Challenge Agent`
path is the reference — can recognize the declared agent and apply its agent
policy instead of treating the traffic as an unknown bot.

It never solves, bypasses or spoofs a human check. The agent browser also does
not self-advertise automation: with the halo-branch patch (`--halo-identity`)
its user agent and client hints are the stock Chromium ones and
`navigator.webdriver` stays off, so a page on a site that does not verify
signatures sees an ordinary Chromium request plus three headers — recognizing
the declared agent, where a site verifies the signature, is the point. It is
off by default.

## Wire format

The signer emits exactly what Cloudflare's reference implementation emits
(tests pin the module to that project's published test vectors):

- `Signature-Agent: "<https key directory URL>"` — bare structured string.
- Components `("@authority" "signature-agent")`; params in the order
  `created;keyid;alg;expires;nonce;tag`, `tag="web-bot-auth"`,
  `alg="ed25519"`.
- `keyid` is the RFC 7638 JWK thumbprint (RFC 8037 A.3) of the install's
  public key. Each install holds its own Ed25519 key; only the public half is
  published.
- `nonce` is 64 random bytes, canonical base64. `expires` defaults to
  `created + 60s`, which is the replay bound (Cloudflare does not track
  nonces; anything longer is not sent to other networks by default).
- Only `http(s)` targets are signed; nothing is added to `data:`/`blob:`
  requests. Failures fall back to an unsigned request — signing must never
  block a page load.
- The directory response is signed with `("@authority";req "content-digest")`
  and `tag="http-message-signatures-directory"` (draft section 5.2), one
  signature per key.

Components beyond `@authority` are deliberately not added (Cloudflare's
support list excludes several RFC 9421 parameters). Ed25519 is deterministic,
so two requests to the same authority in the same second carry identical
`Signature` bytes; the short `expires` bounds any replay window.

## Enablement

Settings (host settings file, also exposed in Settings > "Agent identity"):

- `webBotAuth: true` — off when unset.
- `webBotAuthDirectory: "https://…"` — the key-directory URL used as
  `Signature-Agent`. An empty string clears it; both fields are optional and
  old settings files keep loading.

The host loads or creates the key at
`<userData>/harness-data/web-bot-auth-key.pem` (0600, no symlinks) and mirrors
the public JWKS to `web-bot-auth-public.jwks.json`. The Chromium engine adds
the headers in `CdpWebContents.onRequestPaused` (`Fetch.continueRequest` with
the full merged header set, so existing headers and the cookie jar are
untouched). Signing requires the Chromium engine; the legacy Electron path is
out of scope. Turning the setting off takes effect immediately, including for
already-open pages.

## Publishing the key directory

The directory must be served over https at
`/.well-known/http-message-signatures-directory` with media type
`application/http-message-signatures-directory+json` and a signed response.
Both published directory profiles verify: the draft/library form that also
signs a `content-digest` (what this tool serves) and the authority-only
`("@authority";req)` form Cloudflare's reference server emits. The directory
response is signed fresh per request with the same key that signs requests.

```sh
npm --prefix apps/computer-browser run build:runtime
node apps/computer-browser/tools/web-bot-auth.js directory \
  --key "<userData>/harness-data/web-bot-auth-key.pem" --port 8787
# expose https, e.g.: cloudflared tunnel --url http://127.0.0.1:8787
```

Before registering, prove the public endpoint: `check` fetches the directory
over https, validates the media type and JWKS shape, and verifies the signed
response against every Ed25519 key published in it — the same trust binding a
verifier performs.

```sh
node apps/computer-browser/tools/web-bot-auth.js check \
  --directory "https://<your-directory-host>"
# key <keyid>: signature verifies
# ok: 1/1 key(s) verify the signed directory response
```

### Registration with Cloudflare

1. Publish the directory (above) on a stable https host. A quick tunnel URL
   changes on restart; use a named tunnel or your own domain for a
   registration you intend to keep. Keep the key file safe and backed up.
2. Prepare the signed-agent policy evidence: a publicly documented purpose and
   expected behavior (this contract or an equivalent public page), a contact,
   and the user agent Halo sends (hosted builds send the stock Chromium UA and
   keep `navigator.webdriver` off via `--halo-identity`; a build without the
   halo patches sends `HeadlessChrome`).
3. Cloudflare dashboard > Manage Account > Configurations > Bot Submission
   Form > Verification Method: Request Signature; enter the key directory URL
   (and optional UA patterns), then submit. Cloudflare fetches the directory,
   validates the signed response, and accepts the Ed25519 keys it finds.
4. After approval, confirm the request wire end to end:

```sh
node apps/computer-browser/tools/web-bot-auth.js selftest \
  --key "<userData>/harness-data/web-bot-auth-key.pem" \
  --directory "https://<your-directory-host>"
```

`401` from `crawltest.com/cdn-cgi/web-bot-auth` means the message is well
formed but the key is not known yet (expected before approval); `200` means the
key is known and the message verified; `400` means malformed.

Listing is reviewed per operator, not per install: a single-user browser is
unlikely to be listed on its own, while per-zone verifiers and self-hosted
implementations can fetch and verify the directory directly. Treat the listing
as an application the operator may make, never as a guarantee — the signing
path does not depend on it.

## Limits

- The halo build does not send `HeadlessChrome` or set `navigator.webdriver`
  (`--halo-identity`, patch 3 on the `halo` branch): the cheapest mechanical
  challenge triggers are gone, but that is presentation, not a claim to be a
  person, and it promises nothing about a given site's bot scoring. The
  challenge policy is untouched — detect, pause, hand off, never solve.
- v1 supports one key per install; rotation is manual: add the new key to the
  directory, keep the old until clients update, then remove it. The module can
  sign with any key file but the app does not manage rotation.
- No `Forwarded` / transitive-trust headers (experimental in the drafts).
- The verifier helper accepts only this profile (authority, signature-agent,
  directory response); it exists for self-tests, not as a general RFC 9421
  verifier.
- Signing identifies this install to any site that verifies it. The signature
  covers the request authority, not the URL path; sites that require
  path-bound proofs or additional components are not covered.
- Verification is the site's choice; most of the web still only sees the
  additional headers.

## Verification

From `apps/computer-browser/`:

```sh
npm run build:runtime
node --test test/web-bot-auth.test.js        # vectors, key handling, roundtrip
node --test test/host-settings.test.js       # settings field validation
node --test test/cdp-web-contents.test.js    # real Chromium: headers reach a local server and verify
```
