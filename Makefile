# Brick monorepo — root Makefile.
# Common targets: build, test, lint, release.

.PHONY: help install build build-cli build-router test test-cli test-router test-python lint clean release-tag shellcheck go-lint markdown-lint yaml-lint

help:
	@echo "Brick monorepo targets:"
	@echo "  install         install all workspace deps (npm + uv)"
	@echo "  build           build CLI + native CPU runtime"
	@echo "  build-cli       build TypeScript CLI (apps/cli)"
	@echo "  build-router    build native CPU runtime bundle"
	@echo "  test            run all tests (CLI + router Go + Python)"
	@echo "  test-cli        npm test in apps/cli"
	@echo "  test-router     go test in apps/router/src/spatial-router"
	@echo "  test-python     pytest in packages/evals/tests"
	@echo "  lint            pre-commit run --all-files"
	@echo "  clean           remove node_modules, dist, .venv, __pycache__"
	@echo "  release-tag VER=2.0.0  create + push annotated tag"

install:
	npm ci --ignore-scripts
	uv sync --frozen --all-packages
	python3 scripts/bootstrap_eval_sources.py

build: build-cli build-router

build-cli:
	cd apps/cli && npm run build

build-router:
	python3 scripts/build_runtime.py

test: test-cli test-router test-python test-rust

test-cli:
	cd apps/cli && npm test

test-router:
	cd apps/router/candle-binding && cargo build --locked --release --no-default-features
	cd apps/router/src/spatial-router && LD_LIBRARY_PATH=$(CURDIR)/apps/router/candle-binding/target/release go test ./...

test-rust:
	cd apps/router/candle-binding && cargo test --locked --no-default-features

test-python:
	uv run --frozen python -m pytest packages/evals/tests packages/training/tests scripts/test_fetch_pricing.py scripts/test_check_npm_package.py -q

test-python-data:
	uv run --frozen python -m pytest packages/evals/tests -m generated_data -q

lint:
	pre-commit run --all-files

clean:
	find . -type d -name 'node_modules' -prune -exec rm -rf {} +
	find . -type d -name 'dist' -prune -exec rm -rf {} +
	find . -type d -name '__pycache__' -prune -exec rm -rf {} +
	find . -type d -name '.venv' -prune -exec rm -rf {} +
	find . -type d -name '.pytest_cache' -prune -exec rm -rf {} +
	find . -type d -name '*.egg-info' -prune -exec rm -rf {} +

release-tag:
	@test "$$(git branch --show-current)" = main
	git merge-base --is-ancestor HEAD origin/main
	git diff --quiet
	git diff --cached --quiet
	@test -n "$(VER)" || (echo "Usage: make release-tag VER=2.0.0"; exit 1)
	git tag -a v$(VER) -m "Brick v$(VER)"
	git push origin v$(VER)

# Required lint tools must be installed; failures propagate to the caller.

shellcheck:
	@command -v shellcheck >/dev/null
	@git ls-files -z '*.sh' | xargs -0 -r shellcheck

go-lint:
	cd apps/router/src/spatial-router && go vet ./...

markdown-lint:
	@command -v markdownlint >/dev/null
	@git ls-files -z '*.md' ':!:docs/paper/**' ':!:CLAUDE.md' | xargs -0 -r markdownlint

yaml-lint:
	@command -v yamllint >/dev/null
	@git ls-files -z '*.yaml' '*.yml' | xargs -0 -r yamllint -d relaxed
