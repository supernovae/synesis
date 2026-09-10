.PHONY: build test quality quality-full install-hooks

build:
	npm run build

test: build
	npm test

quality:
	./scripts/quality-check.sh --quick

quality-full:
	./scripts/quality-check.sh --full

install-hooks:
	git config core.hooksPath .githooks
