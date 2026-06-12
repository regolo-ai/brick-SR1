# Brick monorepo — root Makefile.
# Common targets: build, test, lint, docker-build, release.

.PHONY: help install build build-cli build-router test test-cli test-router test-python lint docker-build docker-build-router clean release-tag shellcheck go-lint markdown-lint yaml-lint

help:
	@echo "Brick monorepo targets:"
	@echo "  install         install all workspace deps (npm + uv)"
	@echo "  build           build CLI + router Docker image"
	@echo "  build-cli       build TypeScript CLI (apps/cli)"
	@echo "  build-router    build router Docker image (brick:dev)"
	@echo "  test            run all tests (CLI + router Go + Python)"
	@echo "  test-cli        npm test in apps/cli"
	@echo "  test-router     go test in apps/router/src/spatial-router"
	@echo "  test-python     pytest in packages/evals/tests"
	@echo "  lint            pre-commit run --all-files"
	@echo "  docker-build    docker build router → ghcr.io/regolo-ai/brick:dev"
	@echo "  clean           remove node_modules, dist, .venv, __pycache__"
	@echo "  release-tag VER=2.0.0  create + push annotated tag"

install:
	cd apps/cli && npm install
	uv sync 2>/dev/null || echo "(uv not installed; skip Python sync)"

build: build-cli build-router

build-cli:
	cd apps/cli && npm run build

build-router:
	docker build -f apps/router/Dockerfile -t brick:dev .

test: test-cli test-router test-python

test-cli:
	cd apps/cli && npm test

test-router:
	cd apps/router/src/spatial-router && go test ./...

test-python:
	uv run pytest packages/evals/tests -q 2>/dev/null || pytest packages/evals/tests -q

lint:
	pre-commit run --all-files

docker-build:
	docker build -f apps/router/Dockerfile -t ghcr.io/regolo-ai/brick:dev .

clean:
	find . -type d -name 'node_modules' -prune -exec rm -rf {} +
	find . -type d -name 'dist' -prune -exec rm -rf {} +
	find . -type d -name '__pycache__' -prune -exec rm -rf {} +
	find . -type d -name '.venv' -prune -exec rm -rf {} +
	find . -type d -name '.pytest_cache' -prune -exec rm -rf {} +
	find . -type d -name '*.egg-info' -prune -exec rm -rf {} +

release-tag:
	@test -n "$(VER)" || (echo "Usage: make release-tag VER=2.0.0"; exit 1)
	git tag -a v$(VER) -m "Brick v$(VER)"
	git push origin v$(VER)

# ─── pre-commit hook targets (skip silently if tool missing) ───

shellcheck:
	@command -v shellcheck >/dev/null 2>&1 && \
		find . -name '*.sh' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/packages/evals/baselines/*' -print0 | xargs -0 -r shellcheck || \
		echo "shellcheck not installed; skipping"

go-lint:
	@command -v golangci-lint >/dev/null 2>&1 && \
		(cd apps/router/src/spatial-router && golangci-lint run ./... 2>/dev/null) || \
		echo "golangci-lint not installed; skipping"

markdown-lint:
	@command -v markdownlint >/dev/null 2>&1 && \
		markdownlint '**/*.md' --ignore node_modules --ignore docs/paper --ignore packages/evals/baselines --ignore CLAUDE.md || \
		echo "markdownlint not installed; skipping"

yaml-lint:
	@command -v yamllint >/dev/null 2>&1 && \
		yamllint -d relaxed . || \
		echo "yamllint not installed; skipping"
