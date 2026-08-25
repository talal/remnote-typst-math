alias lint := check
alias fmt := check-fix

[private]
default:
    @just --list

# run test suites for plugin and all crates
test:
    cargo test --workspace
    npm run test

# benchmark save-path conversion cost against the committed wasm engine
bench:
    npm run bench

# fuzz every wasm engine target sequentially (round_trip, typst_to_latex, latex_to_typst)
fuzz:
    cd crates/engine && for t in $(cargo fuzz list); do cargo fuzz run "$t" --release -- -max_total_time=${FUZZ_TIME:-120} -detect_leaks=0; done

# run static analysis, formatting, type checks, and cargo clippy checks
check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    npm run check

# fix formatting and lint issues across the repository
check-fix:
    cargo fmt --all
    cargo clippy --fix --workspace --allow-no-vcs
    npm run check:fix

# remove all build artifacts and generated outputs
clean:
    cargo clean
    rm -rf node_modules dist crates/*/pkg
