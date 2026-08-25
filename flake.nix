{
  description = "Development shell for RemNote plugin";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    nixpkgs,
    rust-overlay,
    ...
  }: let
    overlays = [(import rust-overlay)];
    pkgs = import nixpkgs {
      system = "x86_64-linux";
      inherit overlays;
    };

    rustToolchain = pkgs.rust-bin.nightly.latest.default.override {
      extensions = ["rust-src" "rust-analyzer" "llvm-tools-preview"];
      targets = ["wasm32-unknown-unknown"];
    };
  in {
    devShells.x86_64-linux.default = pkgs.mkShell {
      packages = with pkgs; [
        # TypeScript
        nodejs_24
        typescript-language-server

        # Rust + WASM
        rustToolchain
        wasm-pack
        cargo-fuzz

        # Tools
        ast-grep
        bun
        codegraph
        playwright-driver.browsers
        python314
        ripgrep
        skills
      ];

      shellHook = ''
        # Add the local Node executable directory to PATH
        export PATH="$PWD/node_modules/.bin:$PATH"

        # Skip checking whether the OS is a supported Ubuntu/Debian version
        export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
        # Point Playwright to the Nix-provided browsers
        export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
      '';
    };
  };
}
