# Lessons From Building and Operating HAOS Add-ons

> **Public-repository boundary:** real IP addresses, hostnames, usernames, credentials,
> package coordinates, tunnel identities, and fleet-specific values live in a **private
> repository**. This document uses placeholders and deliberately omits internal names.

These are operational lessons, not theoretical cautions. Each starts where an operator
actually arrives—the symptom—then identifies the cause and ends with a short rule worth
carrying to the next guest or add-on.

## Verification

### CI is green, but Supervisor cannot install the add-on

**Symptom:** The build workflow is green and the store URL is correct, yet Supervisor says
the add-on is missing or its image cannot be pulled.

**Cause:** CI proved that the producer workflow ran. It did not prove that the consumer can
clone the store or pull the image anonymously. This happened in a real release: the store
became public while its GHCR packages remained private, so anonymous pulls returned `401`.

**Rule:** **Verify artifacts from the consumer side.**

Use an anonymous registry request for every advertised architecture: `200` means reachable,
`401` means private, and `404` means missing. Do this before pointing an installed add-on at
the new tag.

### Every door returns 200, but requests reach different guests

**Symptom:** LAN, mesh, or public probes all return HTTP `200`, yet data appears to change
between requests or the response belongs to another instance.

**Cause:** A status code proves that something answered, not which guest answered. A real
tunnel-token reuse incident created multiple connectors behind one hostname, making healthy
responses alternate between machines.

**Rule:** **Verify identity, not status.**

Health responses should expose a safe, unique instance signature. Assert that identity over
every door rather than accepting the HTTP code alone.

### A command exits zero, but the requested state did not change

**Symptom:** A cleanup or detach command reports success, but the device remains attached and
the next build fails unexpectedly.

**Cause:** An exit code reports what the command believed it did, not the resulting system
state. In a real image-verification incident, an NBD attachment survived a nominally
successful disconnect and blocked later work.

**Rule:** **Verify state after success.**

Re-read the kernel or service state after detach, update, restart, or delete operations.
Success without a postcondition is only a claim.

### A tool says “success,” but the running version is unchanged

**Symptom:** Supervisor accepts an install or update and prints a successful result, while
the old application version continues serving requests.

**Cause:** The return described acceptance of the operation, not proof that the intended
artifact was pulled, started, and became live. This has happened with add-on updates where
the producer-side result was mistaken for runtime evidence.

**Rule:** **Check the running artifact.**

Read the live version or build identity from the service after every install or update.

## The wrong-layer failures

### The option is visible and saved, but the process uses its default

**Symptom:** Supervisor shows the configured value, yet the application behaves as if the
option is unset.

**Cause:** An add-on option crosses three independent layers: `config.yaml` stores and
validates it, `run.sh` reads it with `bashio::config` and exports it, and application code
reads the environment variable. In a real add-on failure, the first and third edits existed
but the bridge was missing, so Supervisor truth and process truth disagreed.

**Rule:** **One option, three edits.**

Generate or review all three surfaces together and test with a deliberately non-default
value. A default-value test cannot prove the bridge exists.

### A package is visible in the web UI, but its API returns 404

**Symptom:** The package visibility endpoint returns `404 Not Found` for a package that is
plainly visible in the browser.

**Cause:** Some package-management endpoints conceal insufficient token scope as `404`, while
others return `403`. A real visibility change was initially misdiagnosed as a missing package
until the token's absent package scopes were checked.

**Rule:** **Check permission before existence.**

Inspect the authenticated client's package scopes before investigating publishing or naming.
Authorization refresh is an interactive operator action; do not script it or embed tokens.

### Update was reported, but the old image still runs

**Symptom:** An update command completes, but the version or behavior does not change.

**Cause:** The failure may be one layer earlier than runtime: store metadata can advertise an
unpublished or anonymously unreachable image, or Supervisor may have accepted the request
without replacing the running container.

**Rule:** **Trace update: metadata -> image -> runtime.**

Verify the advertised tag anonymously, then verify the container's live version. Do not use
the update command's final line as evidence for either layer.

### The add-on log is empty because the container never existed

**Symptom:** Starting the add-on fails and its log is empty, so the Dockerfile or server looks
guilty without producing any evidence.

**Cause:** Supervisor can reject options against the schema before creating the container. A
real failure used an optional URL schema with an empty default; validation failed one layer
before the entrypoint and application.

**Rule:** **Empty container log: inspect Supervisor.**

Use `str` for strings that may be blank and validate URL syntax in application code only when
a non-empty value is supplied.

### JSON parsing fails even though the CLI command still works

**Symptom:** A pipe expecting JSON suddenly fails while the underlying Home Assistant CLI
command appears successful.

**Cause:** A deprecated command can write a warning to stdout before its JSON. That human
message corrupts the machine-readable stream even though the requested operation itself
still works.

**Rule:** **Warnings are data to a pipe.**

Use the current CLI namespace and its raw-JSON mode; never assume stdout contains only the
payload you requested.

## Build and packaging

### An OTA-updated guest depends on a base image nobody may touch

**Symptom:** Guest disks look small and convenient, but moving or replacing one shared base
risks corrupting multiple guests; backups are not independently restorable.

**Cause:** A qcow2 overlay stores only divergence and permanently resolves unchanged blocks
through its backing file. HAOS rewrites its A/B OS partitions during OTA updates, so each
guest diverges while retaining that fragile dependency.

**Rule:** **Copy HAOS; never overlay it.**

Use an independent sparse copy of a verified pristine image for every guest.

### The domain exists but never reaches DHCP or HAOS logs

**Symptom:** Virtual-machine creation succeeds, yet the guest appears dead before networking
or operating-system diagnostics exist.

**Cause:** HAOS requires UEFI but refuses Secure Boot. Some import interfaces silently enable
Secure Boot, so firmware rejects the boot before HAOS can explain anything. A real build
proved the safe definition by inspecting domain XML for Secure Boot explicitly disabled.

**Rule:** **UEFI on; Secure Boot off.**

Define firmware settings in the recipe and verify them in the resulting domain XML instead
of trusting importer defaults.

### Installation downloads build inputs on the Home Assistant host

**Symptom:** Installing an add-on is slow, consumes host resources, or fails while compiling
on the appliance.

**Cause:** `config.yaml` does not point to a pullable prebuilt image for the guest's
architecture. Supervisor falls back to building on the HA host, turning an appliance into an
unreliable CI worker.

**Rule:** **Build in CI; pull on HAOS.**

Publish every advertised architecture, declare the `{arch}` image pattern, and anonymously
probe each package before installation.

### The sidebar works, but API clients cannot connect

**Symptom:** A browser can open the add-on through Home Assistant while `curl`, MCP clients,
or another service cannot reach a stable endpoint.

**Cause:** Ingress is an authenticated browser tunnel, not a general-purpose exposed port.
External clients do not possess the browser session or rewritten ingress path.

**Rule:** **Ingress for humans; ports for APIs.**

Keep ingress and publish the service port explicitly when non-browser consumers need it.

### State survives restart, then disappears on update

**Symptom:** An add-on restarts normally but loses its database or generated files after an
update, reinstall, or restore.

**Cause:** Container image paths are ephemeral. Only the add-on's mapped data directory is
part of the durable Supervisor lifecycle and backups.

**Rule:** **Mutable state lives in `/data`.**

Point application storage—and `HOME` when libraries derive paths from it—at `/data`.

## The fleet layer

### One public hostname intermittently serves two different datasets

**Symptom:** The public service is healthy, but repeated requests alternate between instance
identities or apparently lose data.

**Cause:** The same Cloudflare tunnel token was installed on more than one guest. Two
connectors on one tunnel allow Cloudflare to load-balance a single hostname across both
machines. This occurred in a real fleet and looked like an application-state problem.

**Rule:** **One guest, one tunnel, one token.**

Create a distinct tunnel and routes for every guest; never clone another guest's token.

### A mesh peer joins successfully but remains unreachable

**Symptom:** The mesh dashboard shows the new peer as connected, while authorized clients
cannot reach it and its log shows no applicable rules.

**Cause:** Registration and authorization are separate. A setup key without an automatic ACL
group creates a peer successfully but grants it no usable policy. A real guest joined cleanly
and still had zero rules until it was grouped.

**Rule:** **A joined peer still needs a group.**

Mint a short-lived one-use key with `<authorized-acl-group>` attached, then verify the peer
from another authorized member.

### Port 8123 answers during boot, then appears to die

**Symptom:** The Home Assistant UI answers on port `8123` during initial setup, then that port
closes immediately after onboarding and monitoring declares the guest dead.

**Cause:** HAOS can move the UI from `8123` to `80` after onboarding. The port is runtime
state, not a universal constant. This transition caused healthy real guests to be diagnosed
as unavailable.

**Rule:** **Probe the HAOS port set.**

Check `80`, `8123`, `4357`, and `22222`; use the service signature to decide what is alive.

### `virsh domifaddr` stays empty for a healthy guest

**Symptom:** The guest is running and has a LAN address, but `virsh domifaddr` returns nothing
forever.

**Cause:** A bridged guest receives its lease from the physical LAN router, not libvirt's DHCP
service. Libvirt therefore has no lease record to report.

**Rule:** **Bridged lease? Find the MAC by ARP.**

Read the domain NIC's MAC and discover its address on `<libvirt-bridge>` with ARP.

### Two fresh guests acquire unstable names

**Symptom:** A newly booted guest appears under an unexpected suffixed name, and discovery
changes depending on which machine booted first.

**Cause:** Multiple stock HAOS images start with the same default hostname. Collision handling
renames one nondeterministically after first boot.

**Rule:** **Bake identity before first boot.**

Write `<guest-name>` into the copied disk before defining and starting the domain.
