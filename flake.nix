{
  description = "advanced-homeassistant-mcp dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        runScript = name: body: pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [ pkgs.bun pkgs.nodejs_20 ];
          text = body;
        };

        # `nix run .#lint` and `nix run .#test`. They shell out to bun against the workspace's existing `node_modules`, so they're functionally identical to `bun run lint` / `bun test --preload …` from inside the dev shell — just available without entering it.
        lintApp = runScript "ha-mcp-lint" ''
          exec bun run lint "$@"
        '';
        testApp = runScript "ha-mcp-test" ''
          exec bun test --preload ./test/setup.ts "$@"
        '';

        # `nix run .#update-npm-deps-hash` recomputes npm-deps.hash from the current package-lock.json without doing a full build.
        updateNpmDepsHashApp = pkgs.writeShellApplication {
          name = "ha-mcp-update-npm-deps-hash";
          runtimeInputs = [ pkgs.prefetch-npm-deps ];
          text = ''
            repo_root=$(git rev-parse --show-toplevel)
            cd "$repo_root"
            prefetch-npm-deps package-lock.json > npm-deps.hash
            echo "Wrote $repo_root/npm-deps.hash:"
            cat npm-deps.hash
          '';
        };

        # Self-contained stdio server: `nix run .#stdio-server` (or `nix run github:owner/repo/branch#stdio-server`).
        # Uses nixpkgs' buildNpmPackage to produce a hermetic derivation containing dist/stdio-server.mjs plus the externalized prod-only node_modules. The wrapper invokes node against that bundle so consumers don't need bun, npm, or this repo's source on disk.
        stdioServerPkg = pkgs.buildNpmPackage {
          pname = "ha-mcp-stdio-server";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

          src = ./.;

          # Regenerate when package-lock.json changes via `nix run .#update-npm-deps-hash`.
          npmDepsHash = pkgs.lib.fileContents ./npm-deps.hash;

          # python3 is required by node-gyp when better-sqlite3's prebuilt binary isn't usable in the sandbox and it falls back to building from source.
          nativeBuildInputs = [ pkgs.python3 ];

          npmBuildScript = "build:stdio";

          installPhase = ''
            runHook preInstall

            # The default npmInstallHook prunes devDeps before copying; our custom installPhase replaces it, so prune explicitly here.
            npm prune --omit=dev --offline --no-audit --no-fund --no-update-notifier

            mkdir -p $out/lib/ha-mcp-stdio-server $out/bin
            cp -r dist node_modules package.json $out/lib/ha-mcp-stdio-server/

            cat > $out/bin/ha-mcp-stdio-server <<EOF
            #!${pkgs.runtimeShell}
            exec ${pkgs.nodejs_20}/bin/node $out/lib/ha-mcp-stdio-server/dist/stdio-server.mjs "\$@"
            EOF
            chmod +x $out/bin/ha-mcp-stdio-server

            runHook postInstall
          '';

          meta = {
            description = "MCP stdio server for advanced-homeassistant-mcp";
            mainProgram = "ha-mcp-stdio-server";
          };
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # Primary runtime: tests + scripts use `bun test --preload ...`, `bun run lint`, `bun x tsc --noEmit`. The repo's package.json scripts shell out to bun directly.
            bun

            # nodejs is required because several build scripts use `node dist/...` and the build itself runs esbuild via npm, which expects a node executable in PATH.
            nodejs_20

            # Dev/grep ergonomics. Most contributors will already have these via their shell environment, but pinning them here means a fresh checkout works the same on every machine.
            git
            jq
            ripgrep

            # ffmpeg is needed by src/speech/wakeWordDetector.ts when run against real audio input. The unit tests mock spawn so this isn't a hard requirement for `bun test`, but the wakeword E2E paths (and any manual development against the live detector) won't work without it.
            ffmpeg-headless

            # `killall` is used by wakeWordDetector.stopDetection() at runtime; same E2E-only caveat as ffmpeg above.
            psmisc
          ];

          shellHook = ''
            echo "advanced-homeassistant-mcp dev shell"
            echo "  bun:    $(bun --version)"
            echo "  node:   $(node --version)"
            echo ""
            echo "Common commands:"
            echo "  bun install                            # install npm deps"
            echo "  bun test --preload ./test/setup.ts     # run the test suite"
            echo "  bun run lint                           # eslint"
            echo "  bun x tsc --noEmit                     # type check"
            echo "  nix run .#lint                         # eslint via nix"
            echo "  nix run .#test                         # tests via nix"
          '';
        };

        packages = {
          stdio-server = stdioServerPkg;
          default = stdioServerPkg;
        };

        apps = {
          lint = {
            type = "app";
            program = "${lintApp}/bin/ha-mcp-lint";
          };
          test = {
            type = "app";
            program = "${testApp}/bin/ha-mcp-test";
          };
          stdio-server = {
            type = "app";
            program = "${stdioServerPkg}/bin/ha-mcp-stdio-server";
          };
          update-npm-deps-hash = {
            type = "app";
            program = "${updateNpmDepsHashApp}/bin/ha-mcp-update-npm-deps-hash";
          };
        };
      });
}
