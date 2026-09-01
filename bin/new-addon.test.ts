import { describe, expect, test } from "bun:test";
import {
  assertNonNegotiables,
  assertOptionCoverage,
  generateFiles,
  nextDirectoryName,
  parseArguments,
  parseOption,
  probePublishedImage,
  probeMeaning,
  validateSlug,
  type ScaffoldDefinition,
} from "./new-addon";

const definition: ScaffoldDefinition = {
  slug: "lesson",
  title: "Lesson",
  port: 8099,
  directory: "02-lesson",
  options: [parseOption("greeting:str=hello"), parseOption("debug:bool=false")],
};

describe("new-addon", () => {
  test("auto-numbers after existing examples", () => {
    expect(nextDirectoryName(["01-hello", "docs", ".github"], "lesson")).toBe(
      "02-lesson",
    );
    expect(nextDirectoryName(["09-nine", "100-hundred"], "next")).toBe("101-next");
  });

  test("parses the documented command shape", () => {
    expect(
      parseArguments([
        "lesson",
        "--port",
        "8099",
        "--option",
        "greeting:str=hello",
        "--option",
        "debug:bool=false",
      ]),
    ).toEqual({
      slug: "lesson",
      title: "Lesson",
      port: 8099,
      options: definition.options,
    });
  });

  test("one option definition generates all three surfaces", () => {
    const files = generateFiles(definition);

    for (const option of definition.options) {
      expect(files["config.yaml"]).toContain(`  ${option.name}:`);
      expect(files["run.sh"]).toContain(`bashio::config '${option.name}'`);
      expect(files["run.sh"]).toContain(`export ${option.envName}`);
      expect(files["server.ts"]).toContain(`process.env.${option.envName}`);
    }

    expect(files["config.yaml"]).toContain("greeting: str");
    expect(files["config.yaml"]).toContain("debug: bool");
    expect(files["run.sh"]).toContain('[ "${DEBUG}" = "null" ] && DEBUG=\'false\'');
    expect(files["server.ts"]).toContain(
      'const debug = (process.env.DEBUG ?? "false") === "true";',
    );
  });

  test("coverage assertion fails if any generated layer loses an option", () => {
    const files = generateFiles(definition);
    const broken = {
      ...files,
      "run.sh": files["run.sh"].replace("export GREETING", "# bridge accidentally removed"),
    };

    expect(() => assertOptionCoverage(broken, definition.options)).toThrow(
      "'greeting' missing from run.sh export",
    );
  });

  test("rejects invalid typed defaults", () => {
    expect(() => parseOption("debug:bool=maybe")).toThrow("must default to true or false");
    expect(() => parseOption("retries:int=three")).toThrow("must have an integer default");
  });

  test("slug is the exact container and API-safe alphabet", () => {
    expect(validateSlug("hello_2")).toBe("hello_2");
    expect(() => validateSlug("hello-world")).toThrow("expected [a-z0-9_]+");
    expect(() => validateSlug("Hello")).toThrow("container name and Supervisor API id");
  });

  test("hard-codes every non-negotiable", () => {
    const files = generateFiles(definition);
    expect(() => assertNonNegotiables(files, definition)).not.toThrow();
    expect(files["config.yaml"]).toContain(
      'image: "ghcr.io/soul-brews-studio/{arch}-addon-lesson"',
    );
    expect(files["config.yaml"]).toContain("arch:\n  - amd64\n  - aarch64");
    expect(files["config.yaml"]).toContain("boot: auto");
    expect(files["config.yaml"]).toContain("init: false");
    expect(files["config.yaml"]).toContain("ingress: true");
    expect(files["config.yaml"]).toContain("ports:\n  8099/tcp: 8099");
    expect(files["config.yaml"]).toContain("map:\n  - data:rw");
    expect(files["config.yaml"]).toContain("greeting: str");
  });

  test("labels anonymous consumer probe results", () => {
    expect(probeMeaning("200")).toBe("installable");
    expect(probeMeaning("401")).toBe("private");
    expect(probeMeaning("404")).toBe("missing");
    expect(probeMeaning("500")).toBe("unexpected");
  });

  test("exchanges a GHCR anonymous token before probing public tags", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const status = await probePublishedImage("amd64-addon-lesson", async (url, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization });
      if (url.startsWith("https://ghcr.io/token?")) {
        const tokenUrl = new URL(url);
        expect(tokenUrl.searchParams.get("service")).toBe("ghcr.io");
        expect(tokenUrl.searchParams.get("scope")).toBe(
          "repository:soul-brews-studio/amd64-addon-lesson:pull",
        );
        return Response.json({ token: "anonymous-token" });
      }
      return Response.json({ tags: ["latest"] }, { status: 200 });
    });

    expect(status).toBe("200");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.authorization).toBe("Bearer anonymous-token");
  });
});
