# HA sidebar auto-login lessons

This note records the measured patterns used for `discord_pb` v0.1.2. Sources
were read-only: Thor memory, the factory add-ons, Petkeeper's PocketBase hook,
and Home Assistant Supervisor's current ingress implementation. The requested
Arra-memory recall connector was not available in this worker's tool surface;
Thor keyword recall was used (semantic fallback was unavailable), so the local
source audit is the primary evidence.

## What worked

### Preserve the ingress prefix everywhere

Home Assistant serves an add-on below
`/api/hassio_ingress/<session-token>/`, not at the origin root. Digger Node
fixed its UI by treating `X-Ingress-Path` as a base path for client fetches,
form actions, and redirects. Do not strip the prefix and do not emit root-relative
`/api/...` or `/_/` URLs. Discord's landing page uses only relative
`./api/...` and `./_/` URLs, so both the token request and PocketBase admin
stay inside the sidebar prefix.

References:

- `07-digger_node` in this factory, especially its ingress-base handling.
- Thor memory `8ada7bfa-a5f8-4252-b57d-15037ffa7f7b` (“App over Home
  Assistant OS — ralph-dig #203”).

### Mint a real PocketBase superuser token

Petkeeper's `310_petkeeper_autologin.pb.js` proved the working PocketBase
0.29.3 shape: find the configured `_superusers` record and return
`su.newAuthToken()` plus a record serialized through `getString(...)`.
The browser writes exactly the object PocketBase's admin SPA expects:

```json
{"token":"<token>","record":{"id":"...","email":"...","collectionName":"_superusers"}}
```

A hand-made/static token is not equivalent: Discord's earlier experiment could
not access protected APIs. A normal minted auth token can be refreshed by the
real admin SPA and was proven with `auth-refresh` plus a private collection
request, both HTTP 200.

### Gate minting on actual ingress identity

Supervisor authenticates the ingress session and injects
`X-Remote-User-Id`, `X-Remote-User-Name`, and display name. It does **not**
inject an “is admin” header. Discord therefore requires all of:

1. `auto_login: true`;
2. the actual ingress TCP peer, never `X-Forwarded-For`;
3. a valid `X-Ingress-Path`;
4. a non-empty `X-Remote-User-Id`; and
5. either an explicit ID in `auto_login_ha_user_ids` or the opt-in
   `auto_login_ha_admins: true` policy.

`auto_login_ha_admins` relies on the add-on's `panel_admin: true` setting:
HA admits only administrators to that panel. It remains false by default
because the add-on cannot independently verify admin status from ingress
headers.

Official references:

- [Home Assistant app security / ingress identity](https://developers.home-assistant.io/docs/apps/security/)
- [Supervisor ingress implementation](https://github.com/home-assistant/supervisor/blob/main/supervisor/api/ingress.py)

### Make denial actionable

A bare “HA user not allowed” is a dead end because HA user IDs are opaque.
The denied JSON response now includes the received ID/name and the literal
option name `auto_login_ha_user_ids`. The panel renders those values with
`textContent` (not HTML), offers a copy button, and tells the administrator
where to paste the ID. No auth token is returned on denial.

### Isolate every PocketBase browser storage key

HA ingress add-ons share the Home Assistant origin. Browser `localStorage` is
origin-scoped, not path-scoped, so two PocketBase admin SPAs using
`__pb_superuser_auth__` overwrite each other. Changing only the landing-page
write is insufficient because the compiled PocketBase SPA still reads its
original key.

Discord checksum-pins PocketBase 0.29.3 and fail-closed patches both compiled
keys with equal-length names:

| PocketBase | Discord |
|---|---|
| `__pb_superuser_auth__` | `__dc_superuser_auth__` |
| `pb_superuser_file_token` | `dc_superuser_file_token` |

The browser proof keeps Petkeeper sentinel values under both original keys,
opens Discord admin, refreshes its token, reads protected records, and asserts
the Petkeeper sentinels are unchanged.

## What broke before

- Petkeeper's original token endpoint minted a full superuser token for anyone
  who could reach its mapped port. It was hardened by leaving auto-login off.
  Thor memory: `c246d850-8e04-40e3-9170-b19931036538`.
- Trusting `X-Ingress-Path` alone is not authorization. Co-resident add-ons
  share the Supervisor bridge and can forge headers; validate the real TCP peer
  too. “No published port” is helpful but is not container isolation.
- Root-relative URLs escape the ingress prefix and land on Home Assistant
  routes, producing broken API calls or redirects out of the iframe.
- A custom/static token looked plausible but failed PocketBase protected API
  validation. Use the auth record's normal token.
- Writing a new localStorage key only in the wrapper page left the compiled SPA
  on the old key, causing cross-add-on login/file-token collisions.
- PocketBase JSVM record properties can expose Go methods rather than JSON
  strings. Serialize auth record fields with `getString`.
- A changed hook is baked into the image: restart alone cannot load it. Rebuild
  or update the add-on image.
- Supervisor caches add-on metadata by version. Adding an option requires a
  version bump; reload/rebuild alone may silently retain the old schema.
- Supervisor option writes replace the whole options object. Preserve every
  existing value, especially secrets; do not print the options/schema while
  collecting proof.

## Trap checklist

1. Keep `auto_login` false by default.
2. Keep `auto_login_ha_admins` false by default.
3. Never mint on a directly mapped LAN/VPN request.
4. Never trust `X-Forwarded-For` or `X-Ingress-Path` by itself.
5. Require a non-empty HA user ID even on the panel-admin policy.
6. Use relative sidebar URLs; test the final pathname retains the ingress base.
7. Return `Cache-Control: no-store` on every token response.
8. Do not log tokens, passwords, options, or first-run auth URLs.
9. Namespace both the auth and file-token keys in the compiled SPA.
10. Prove the token by refreshing it and reading a protected collection.
11. Prove neighboring add-on storage sentinels remain unchanged.
12. Bump the add-on version for schema changes and rebuild for hook changes.

