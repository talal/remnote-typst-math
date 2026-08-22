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
        cargo-fuzz

        # Tools
        ast-grep
        codegraph
        just
        ripgrep
        skills
      ];

      shellHook = ''
        # Add the local Node executable directory to PATH
        export PATH="$PWD/node_modules/.bin:$PATH"
      '';
    };
  };
}
