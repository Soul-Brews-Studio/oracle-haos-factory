#!/usr/bin/env bun
// This scaffold exists to make Trap 6 structurally impossible, not to save
// typing: every option is parsed once into one internal definition, then that
// same object generates config.yaml, the run.sh bashio bridge, and the server.ts
// environment read together. Coverage is asserted before any directory exists.

import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const FACTORY_URL = "https://github.com/Soul-Brews-Studio/oracle-haos-factory";
const REGISTRY_OWNER = "soul-brews-studio";
const IMAGE_ROOT = `ghcr.io/${REGISTRY_OWNER}`;
const SUPPORTED_TYPES = ["str", "bool", "int"] as const;

type OptionType = (typeof SUPPORTED_TYPES)[number];

export interface OptionDefinition {
  name: string;
  envName: string;
  type: OptionType;
  defaultValue: string | boolean | number;
}

export interface ScaffoldDefinition {
  slug: string;
  title: string;
  port: number;
  directory: string;
  options: OptionDefinition[];
}

export interface GeneratedFiles {
  "config.yaml": string;
  "build.yaml": string;
  Dockerfile: string;
  "run.sh": string;
  "server.ts": string;
}

function usage(): string {
  return [
    "Usage:",
    "  bun bin/new-addon.ts <slug> --port 8099 \\",
    "    --option greeting:str=hello --option debug:bool=false",
    "  bun bin/new-addon.ts <slug> --check",
    "",
    "Option types: str, bool, int",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(`${message}\n\n${usage()}`);
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export function validateSlug(slug: string): string {
  if (!/^[a-z0-9_]+$/.test(slug)) {
    fail(
      `Invalid slug '${slug}'; expected [a-z0-9_]+ because the slug becomes ` +
        "the container name and Supervisor API id",
    );
  }
  return slug;
}

export function parseOption(spec: string): OptionDefinition {
  const colon = spec.indexOf(":");
  const equals = spec.indexOf("=", colon + 1);
  if (colon < 1 || equals < colon + 2) {
    fail(`Invalid option '${spec}'; expected name:type=default`);
  }

  const name = spec.slice(0, colon);
  const type = spec.slice(colon + 1, equals) as OptionType;
  const rawDefault = spec.slice(equals + 1);

  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    fail(`Invalid option name '${name}'; use lower_snake_case`);
  }
  if (name === "port") {
    fail("Option name 'port' is reserved for the server listener");
  }
  if (!SUPPORTED_TYPES.includes(type)) {
    fail(`Invalid type '${type}' for '${name}'`);
  }

  let defaultValue: string | boolean | number;
  if (type === "bool") {
    if (rawDefault !== "true" && rawDefault !== "false") {
      fail(`Boolean option '${name}' must default to true or false`);
    }
    defaultValue = rawDefault === "true";
  } else if (type === "int") {
    if (!/^-?\d+$/.test(rawDefault)) {
      fail(`Integer option '${name}' must have an integer default`);
    }
    defaultValue = Number(rawDefault);
    if (!Number.isSafeInteger(defaultValue)) {
      fail(`Integer option '${name}' is outside JavaScript's safe range`);
    }
  } else {
    defaultValue = rawDefault;
  }

  return { name, envName: name.toUpperCase(), type, defaultValue };
}

export function parseArguments(args: string[]): Omit<ScaffoldDefinition, "directory"> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    if (args.length === 0) fail("Missing add-on slug");
    console.log(usage());
    process.exit(0);
  }

  const slug = validateSlug(args[0]!);

  let port = 8099;
  const options: OptionDefinition[] = [];

  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--port" && flag !== "--option") {
      fail(`Unknown argument '${flag}'`);
    }
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value after '${flag}'`);
    }

    if (flag === "--port") {
      if (!/^\d+$/.test(value)) fail(`Invalid port '${value}'`);
      port = Number(value);
      if (port < 1 || port > 65535) fail(`Port '${value}' is outside 1..65535`);
    } else {
      options.push(parseOption(value));
    }
    index += 1;
  }

  const names = new Set<string>();
  for (const option of options) {
    if (names.has(option.name)) fail(`Duplicate option '${option.name}'`);
    names.add(option.name);
  }

  return { slug, title: titleFromSlug(slug), port, options };
}

export function nextDirectoryName(entries: string[], slug: string): string {
  const highest = entries.reduce((max, entry) => {
    const match = /^(\d+)-/.exec(entry);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${String(highest + 1).padStart(2, "0")}-${slug}`;
}

export function probeMeaning(status: string): string {
  if (status === "200") return "installable";
  if (status === "401") return "private";
  if (status === "404") return "missing";
  return "unexpected";
}

type ImageProbeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function probePublishedImage(
  image: string,
  fetcher: ImageProbeFetch = (url, init) => fetch(url, init),
): Promise<string> {
  const scope = `repository:${REGISTRY_OWNER}/${image}:pull`;
  const tokenUrl = new URL("https://ghcr.io/token");
  tokenUrl.searchParams.set("service", "ghcr.io");
  tokenUrl.searchParams.set("scope", scope);

  // GHCR challenges even anonymous public pulls with 401. Exchange that
  // challenge for an anonymous scoped token before deciding package visibility.
  const tokenResponse = await fetcher(tokenUrl.toString());
  if (!tokenResponse.ok) return String(tokenResponse.status);
  const payload = (await tokenResponse.json()) as { token?: unknown };
  if (typeof payload.token !== "string" || payload.token.length === 0) return "500";

  const tagsUrl = `https://ghcr.io/v2/${REGISTRY_OWNER}/${image}/tags/list`;
  const tagsResponse = await fetcher(tagsUrl, {
    headers: { authorization: `Bearer ${payload.token}` },
  });
  return String(tagsResponse.status);
}

export async function checkPublishedImages(slug: string): Promise<boolean> {
  validateSlug(slug);
  let installable = true;

  for (const arch of ["amd64", "aarch64"] as const) {
    const image = `${arch}-addon-${slug}`;
    let status: string;
    try {
      status = await probePublishedImage(image);
    } catch (error) {
      console.log(`${arch}: probe-error ${error instanceof Error ? error.message : String(error)}`);
      installable = false;
      continue;
    }

    const meaning = probeMeaning(status);
    console.log(`${arch}: ${status} ${meaning}`);
    if (status !== "200") installable = false;
  }

  return installable;
}

function yamlValue(option: OptionDefinition): string {
  return option.type === "str"
    ? JSON.stringify(option.defaultValue)
    : String(option.defaultValue);
}

function shellSingleQuote(value: string | boolean | number): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function typescriptValue(option: OptionDefinition): string {
  return option.type === "str"
    ? JSON.stringify(option.defaultValue)
    : String(option.defaultValue);
}

function renderConfig(definition: ScaffoldDefinition): string {
  const optionDefaults = definition.options.length
    ? definition.options.map((option) => `  ${option.name}: ${yamlValue(option)}`).join("\n")
    : "  {}";
  const optionSchema = definition.options.length
    ? definition.options.map((option) => `  ${option.name}: ${option.type}`).join("\n")
    : "  {}";

  return `name: ${JSON.stringify(definition.title)}
version: "0.1.0"
slug: ${JSON.stringify(definition.slug)}
description: >-
  A generated Oracle HAOS Factory example with its configuration bridge kept
  consistent by construction.
url: ${JSON.stringify(`${FACTORY_URL}/tree/main/${definition.directory}`)}

# A published image makes installation a pull instead of building on the HAOS
# machine. It also moves failures into CI, where they cannot masquerade as a
# successful update that quietly leaves an old image running.
image: ${JSON.stringify(`${IMAGE_ROOT}/{arch}-addon-${definition.slug}`)}
arch:
  - amd64
  - aarch64
startup: application
# Reboots must restore the service without a human reopening the add-on page.
boot: auto
# Home Assistant base images already own PID 1 through s6-overlay.
init: false
hassio_api: false
homeassistant_api: false
host_network: false

# Ingress serves a browser with an HA session; API consumers need a stable port
# because they cannot authenticate to or address an ingress URL.
ingress: true
ingress_port: ${definition.port}
panel_icon: mdi:school
panel_title: ${JSON.stringify(definition.title)}
panel_admin: false
ports:
  ${definition.port}/tcp: ${definition.port}
ports_description:
  ${definition.port}/tcp: "Web endpoint and health API"

# /data is the only add-on path Supervisor persists across updates and includes
# in Home Assistant backups, even when this first scaffold stores nothing yet.
map:
  - data:rw
stage: experimental

# Generated from the same option definitions as run.sh and server.ts. Adding an
# option to only this surface recreates Trap 6 and is intentionally unsupported.
options:
${optionDefaults}
schema:
  # String options use str. An empty default under url? fails validation before
  # the container exists, so the add-on log is empty and points at the wrong layer.
${optionSchema}
`;
}

function renderBuild(definition: ScaffoldDefinition): string {
  return `# The official builder supplies BUILD_FROM per architecture. These tags
# match the Dockerfile's pinned 3.22 default so local and CI builds do not prove
# different base generations.
build_from:
  amd64: ghcr.io/home-assistant/amd64-base:3.22
  aarch64: ghcr.io/home-assistant/aarch64-base:3.22

# BUILD_ARCH comes from the builder. Overriding it with "{arch}" passes that
# literal text and makes the Dockerfile reject an apparently unsupported arch.
labels:
  org.opencontainers.image.source: ${FACTORY_URL}
  org.opencontainers.image.licenses: MIT
`;
}

function renderDockerfile(definition: ScaffoldDefinition): string {
  return `# A digest-pinned default keeps plain local builds reproducible; the HA
# builder overrides BUILD_FROM with the matching per-arch base in build.yaml.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.22@sha256:0eda502b4d16e0433ace512d857ec3e86497d4214091ee459078ee4df6373f63
FROM \${BUILD_FROM}

ARG BUILD_VERSION="dev"
ARG BUILD_ARCH="amd64"

LABEL \\
    io.hass.version="\${BUILD_VERSION}" \\
    io.hass.type="addon" \\
    io.hass.arch="\${BUILD_ARCH}"

# HA's Alpine base requires Bun's musl build; the glibc binary fails with a
# misleading "not found" even when the executable is present.
RUN apk add --no-cache libstdc++ unzip curl \\
 && case "\${BUILD_ARCH}" in \\
      amd64)   BUN_TARGET="bun-linux-x64-musl" ;; \\
      aarch64) BUN_TARGET="bun-linux-aarch64-musl" ;; \\
      *)       echo "unsupported arch: \${BUILD_ARCH}" >&2; exit 1 ;; \\
    esac \\
 && curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/\${BUN_TARGET}.zip" -o /tmp/bun.zip \\
 && unzip -q /tmp/bun.zip -d /tmp \\
 && mv "/tmp/\${BUN_TARGET}/bun" /usr/local/bin/bun \\
 && chmod 0755 /usr/local/bin/bun \\
 && rm -rf /tmp/bun.zip "/tmp/\${BUN_TARGET}" \\
 && bun --version

# Future home-derived state belongs below the only persisted and backed-up path.
ENV HOME=/data \\
    PORT=${definition.port}
WORKDIR /app

COPY server.ts /app/server.ts
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

CMD ["/run.sh"]
`;
}

function renderRun(definition: ScaffoldDefinition): string {
  const bridge = definition.options
    .map(
      (option) => `${option.envName}="$(bashio::config '${option.name}')"
# bashio can represent an unset option as the literal text null; normalize it
# before export so the process receives the declared default, not a false value.
[ "\${${option.envName}}" = "null" ] && ${option.envName}=${shellSingleQuote(option.defaultValue)}
export ${option.envName}`,
    )
    .join("\n\n");

  return `#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Generated from the same option definitions as config.yaml and server.ts. This
# bridge is not boilerplate: omitting it stores values in Supervisor while the
# running process silently keeps defaults—the failure shape documented as Trap 6.

set -eu

${bridge}${bridge ? "\n\n" : ""}export PORT=${definition.port}

bashio::log.info ${JSON.stringify(`${definition.title} starting on port ${definition.port}`)}
# exec lets the server receive s6 stop signals directly instead of waiting for a
# shell parent to time out during restart.
exec bun /app/server.ts
`;
}

function renderServer(definition: ScaffoldDefinition): string {
  const reads = definition.options
    .map((option) => {
      const fallback = typescriptValue(option);
      if (option.type === "bool") {
        return `const ${option.name} = (process.env.${option.envName} ?? ${JSON.stringify(String(option.defaultValue))}) === "true";`;
      }
      if (option.type === "int") {
        return `const ${option.name} = Number.parseInt(process.env.${option.envName} ?? ${JSON.stringify(String(option.defaultValue))}, 10);`;
      }
      return `const ${option.name} = process.env.${option.envName} ?? ${fallback};`;
    })
    .join("\n");
  const optionObject = definition.options.map((option) => option.name).join(", ");
  const rootResponse = definition.options.some(
    (option) => option.name === "greeting" && option.type === "str",
  )
    ? "greeting"
    : JSON.stringify(`hello from ${definition.slug}`);

  return `const port = Number(process.env.PORT ?? ${JSON.stringify(String(definition.port))});
// These reads are generated from the same definitions that produced config.yaml
// and run.sh. The generator asserts all three surfaces before writing anything.
${reads}${reads ? "\n" : ""}const runtimeOptions = { ${optionObject} };

Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(${rootResponse}, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "GET" && pathname === "/api/health") {
      return Response.json({ status: "ok", slug: ${JSON.stringify(definition.slug)}, options: runtimeOptions });
    }

    return new Response("Not found", { status: 404 });
  },
});
`;
}

export function assertOptionCoverage(
  files: GeneratedFiles,
  options: OptionDefinition[],
): void {
  for (const option of options) {
    const checks: Array<[string, string, string]> = [
      ["config.yaml options", files["config.yaml"], `  ${option.name}: ${yamlValue(option)}`],
      ["config.yaml schema", files["config.yaml"], `  ${option.name}: ${option.type}`],
      ["run.sh bashio read", files["run.sh"], `bashio::config '${option.name}'`],
      ["run.sh null guard", files["run.sh"], `[ "\${${option.envName}}" = "null" ]`],
      ["run.sh export", files["run.sh"], `export ${option.envName}`],
      ["server.ts env read", files["server.ts"], `process.env.${option.envName}`],
    ];
    for (const [surface, content, needle] of checks) {
      if (!content.includes(needle)) {
        throw new Error(`Generator invariant failed: '${option.name}' missing from ${surface}`);
      }
    }
  }
}

export function assertNonNegotiables(
  files: GeneratedFiles,
  definition: ScaffoldDefinition,
): void {
  const config = files["config.yaml"];
  const required = [
    `${IMAGE_ROOT}/{arch}-addon-${definition.slug}`,
    "arch:\n  - amd64\n  - aarch64",
    "boot: auto",
    "init: false",
    "ingress: true",
    `ingress_port: ${definition.port}`,
    `ports:\n  ${definition.port}/tcp: ${definition.port}`,
    "map:\n  - data:rw",
  ];
  for (const invariant of required) {
    if (!config.includes(invariant)) {
      throw new Error(`Generator non-negotiable missing from config.yaml: ${invariant}`);
    }
  }
  for (const option of definition.options.filter((item) => item.type === "str")) {
    if (!config.includes(`  ${option.name}: str`)) {
      throw new Error(`String option '${option.name}' must use schema type str, never url?`);
    }
  }
}

export function generateFiles(definition: ScaffoldDefinition): GeneratedFiles {
  const files: GeneratedFiles = {
    "config.yaml": renderConfig(definition),
    "build.yaml": renderBuild(definition),
    Dockerfile: renderDockerfile(definition),
    "run.sh": renderRun(definition),
    "server.ts": renderServer(definition),
  };
  assertOptionCoverage(files, definition.options);
  assertNonNegotiables(files, definition);
  return files;
}

export async function scaffold(args: string[], root = process.cwd()): Promise<string> {
  const parsed = parseArguments(args);
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (!rootEntries.some((entry) => entry.isFile() && entry.name === "repository.yaml")) {
    fail(`Refusing to scaffold outside an add-on store: ${root}/repository.yaml is missing`);
  }

  const directory = nextDirectoryName(
    rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    parsed.slug,
  );
  const target = join(root, directory);
  if (rootEntries.some((entry) => entry.name === directory)) {
    fail(`Target already exists: ${target}`);
  }

  const definition: ScaffoldDefinition = { ...parsed, directory };
  const files = generateFiles(definition);
  const staging = join(root, `.new-addon-${process.pid}-${Date.now()}`);

  await mkdir(staging);
  try {
    await Promise.all(
      Object.entries(files).map(([name, content]) => Bun.write(join(staging, name), content)),
    );
    await chmod(join(staging, "run.sh"), 0o755);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  console.log(`Created ${directory}`);
  for (const name of Object.keys(files)) console.log(`  ${directory}/${name}`);
  console.log("\nAfter CI publishes both images and both packages are public, run:");
  console.log(`  bun bin/new-addon.ts ${parsed.slug} --check`);
  return target;
}

if (import.meta.main && process.env.NODE_ENV !== "test") {
  const args = Bun.argv.slice(2);
  const action = async () => {
    if (args.includes("--check")) {
      if (args.length !== 2 || args[1] !== "--check") {
        fail("--check accepts exactly one slug and cannot be mixed with scaffold options");
      }
      const ok = await checkPublishedImages(args[0]!);
      if (!ok) process.exitCode = 1;
      return;
    }
    await scaffold(args);
  };

  action().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
