import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectRepository } from "../cli/src/repository-detection.mjs";

async function withTempRepo(setup, assertion) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-"));
  try {
    await setup(tempDir);
    await assertion(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeRepoFiles(repoRoot, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents);
  }
}

test("detectRepository keeps TypeScript separate from JavaScript", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "package.json": JSON.stringify({
        name: "@demo/ts-service",
        packageManager: "pnpm@9.1.0",
        engines: {
          node: "22.x",
        },
        devDependencies: {
          typescript: "^5.8.0",
        },
      }, null, 2),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
        },
      }, null, 2),
      "src/index.ts": "export const value: number = 1;\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "ts-service");
    assert.deepEqual(detection.toolingProfiles, ["node22"]);
    assert.deepEqual(detection.stack.languages, ["typescript"]);
    assert.deepEqual(detection.stack.tools, ["pnpm"]);
  });
});

test("detectRepository aggregates JavaScript and TypeScript across package workspaces", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "package.json": JSON.stringify({
        name: "platform-monorepo",
        packageManager: "pnpm@9.1.0",
        engines: {
          node: "20.11.1",
        },
        workspaces: ["packages/*"],
      }, null, 2),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "packages/web/package.json": JSON.stringify({
        name: "@demo/web",
        devDependencies: {
          typescript: "^5.8.0",
        },
      }, null, 2),
      "packages/web/tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "esnext",
        },
      }, null, 2),
      "packages/web/src/index.tsx": "export const App = () => null;\n",
      "packages/scripts/package.json": JSON.stringify({
        name: "@demo/scripts",
      }, null, 2),
      "packages/scripts/scripts/build.js": "console.log('build');\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "platform-monorepo");
    assert.deepEqual(detection.toolingProfiles, ["node20"]);
    assert.deepEqual(detection.stack.languages, ["javascript", "typescript"]);
    assert.deepEqual(detection.stack.tools, ["pnpm"]);
  });
});

test("detectRepository keeps languages when a Node version is not discoverable", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "package.json": JSON.stringify({
        name: "versionless-ts",
        devDependencies: {
          typescript: "^5.8.0",
        },
      }, null, 2),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "commonjs",
        },
      }, null, 2),
      "src/index.ts": "export {};\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.deepEqual(detection.toolingProfiles, []);
    assert.deepEqual(detection.stack.languages, ["typescript"]);
    assert.deepEqual(detection.stack.tools, ["npm"]);
  });
});

test("detectRepository derives Python tooling from pyproject metadata", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "pyproject.toml": `
[project]
name = "service-worker"
requires-python = ">=3.11"

[tool.uv]
package = true
`,
      "uv.lock": "version = 1\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "service-worker");
    assert.deepEqual(detection.toolingProfiles, ["python311"]);
    assert.deepEqual(detection.stack.languages, ["python"]);
    assert.deepEqual(detection.stack.tools, ["uv"]);
  });
});

test("detectRepository derives JVM languages from Gradle source and plugins", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "settings.gradle.kts": "rootProject.name = \"jvm-suite\"\n",
      "build.gradle.kts": `
plugins {
  java
  kotlin("jvm") version "2.1.0"
  scala
}

java {
  toolchain {
    languageVersion = JavaLanguageVersion.of(21)
  }
}
`,
      "src/main/java/App.java": "class App {}\n",
      "src/main/kotlin/App.kt": "fun main() = Unit\n",
      "src/main/scala/App.scala": "object App\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "jvm-suite");
    assert.deepEqual(detection.toolingProfiles, ["java21"]);
    assert.deepEqual(detection.stack.languages, ["java", "kotlin", "scala"]);
    assert.deepEqual(detection.stack.tools, ["gradle"]);
  });
});

test("detectRepository derives Go tooling from go.mod", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "go.mod": "module github.com/demo/go-service\n\ngo 1.22\n",
      "cmd/service/main.go": "package main\nfunc main() {}\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "go-service");
    assert.deepEqual(detection.toolingProfiles, ["go122"]);
    assert.deepEqual(detection.stack.languages, ["go"]);
    assert.deepEqual(detection.stack.tools, ["go"]);
  });
});

test("detectRepository derives Rust tooling from rust-toolchain metadata", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "Cargo.toml": `
[package]
name = "core-rs"
version = "0.1.0"
`,
      "rust-toolchain.toml": `
[toolchain]
channel = "1.76"
`,
      "src/lib.rs": "pub fn value() -> u32 { 1 }\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "core-rs");
    assert.deepEqual(detection.toolingProfiles, ["rust176"]);
    assert.deepEqual(detection.stack.languages, ["rust"]);
    assert.deepEqual(detection.stack.tools, ["cargo"]);
  });
});

test("detectRepository derives PHP tooling from composer metadata", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "composer.json": JSON.stringify({
        name: "demo/php-service",
        config: {
          platform: {
            php: "8.3.2",
          },
        },
      }, null, 2),
      "src/Service.php": "<?php\nfinal class Service {}\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "php-service");
    assert.deepEqual(detection.toolingProfiles, ["php83"]);
    assert.deepEqual(detection.stack.languages, ["php"]);
    assert.deepEqual(detection.stack.tools, ["composer"]);
  });
});

test("detectRepository derives Ruby tooling from Gemfile metadata", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "Gemfile": "source 'https://rubygems.org'\nruby '3.3.1'\n",
      "app.rb": "puts 'hi'\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.deepEqual(detection.toolingProfiles, ["ruby33"]);
    assert.deepEqual(detection.stack.languages, ["ruby"]);
    assert.deepEqual(detection.stack.tools, ["bundler"]);
  });
});

test("detectRepository distinguishes .NET language families and SDK version", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "global.json": JSON.stringify({
        sdk: {
          version: "8.0.100",
        },
      }, null, 2),
      "src/App/App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n",
      "src/App/Program.cs": "class Program {}\n",
      "src/Lib/Lib.fsproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n",
      "src/Lib/Library.fs": "module Library\n",
      "src/Vb/App.vbproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n",
      "src/Vb/Module.vb": "Module App\nEnd Module\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.deepEqual(detection.toolingProfiles, ["dotnet8"]);
    assert.deepEqual(detection.stack.languages, ["csharp", "fsharp", "vbnet"]);
    assert.deepEqual(detection.stack.tools, ["dotnet"]);
  });
});

test("detectRepository derives C and C++ standards from CMake metadata", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "CMakeLists.txt": `
cmake_minimum_required(VERSION 3.28)
project(native-suite LANGUAGES C CXX)
set(CMAKE_C_STANDARD 17)
set(CMAKE_CXX_STANDARD 20)
`,
      "src/main.c": "int main(void) { return 0; }\n",
      "src/main.cpp": "int main() { return 0; }\n",
      "Makefile": "all:\n\t@echo native\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.deepEqual(detection.toolingProfiles, ["c17", "cpp20"]);
    assert.deepEqual(detection.stack.languages, ["c", "cpp"]);
    assert.deepEqual(detection.stack.tools, ["cmake", "make"]);
  });
});

test("detectRepository derives Swift tooling from SwiftPM manifests", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "Package.swift": `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "swift-demo",
  targets: [
    .executableTarget(name: "swift-demo")
  ]
)
`,
      "Sources/swift-demo/main.swift": "print(\"hi\")\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "swift-demo");
    assert.deepEqual(detection.toolingProfiles, ["swift59"]);
    assert.deepEqual(detection.stack.languages, ["swift"]);
    assert.deepEqual(detection.stack.tools, ["swiftpm"]);
  });
});

test("detectRepository derives Dart tooling from pubspec SDK constraints", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "pubspec.yaml": `
name: dart_demo
environment:
  sdk: ">=3.4.0 <4.0.0"
`,
      "lib/main.dart": "void main() {}\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "dart_demo");
    assert.deepEqual(detection.toolingProfiles, ["dart3"]);
    assert.deepEqual(detection.stack.languages, ["dart"]);
    assert.deepEqual(detection.stack.tools, ["dart"]);
  });
});

test("detectRepository returns an empty stack for repos without supported markers", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeRepoFiles(repoRoot, {
      "README.md": "# Empty\n",
    });
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, path.basename(repoRoot));
    assert.deepEqual(detection.toolingProfiles, []);
    assert.deepEqual(detection.stack, {
      languages: [],
      tools: [],
    });
  });
});
