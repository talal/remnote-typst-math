alias lint := check
alias fmt := check-fix

[private]
default:
    @just --list

# run the plugin test suite
test:
    npm run test

# benchmark save-path conversion cost against the pure TypeScript engine
bench:
    npm run bench

# fuzz the TypeScript conversion engine (time-boxed; FUZZ_TIME seconds, default 120)
fuzz:
    npm run fuzz -- --seconds=${FUZZ_TIME:-120}

# run static analysis, formatting, and type checks
check:
    npm run check

# fix formatting and lint issues across the repository
check-fix:
    npm run check:fix

# remove all build artifacts and generated outputs
clean:
    rm -rf node_modules dist
