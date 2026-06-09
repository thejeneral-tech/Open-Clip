# OpenClip developer shortcuts (local, no Docker)
.DEFAULT_GOAL := help

PY      := python
LAUNCH  := $(PY) launch.py
# Virtualenv bin dir, relative to the backend/ directory (used after `cd backend`).
# Windows puts executables under Scripts/, everything else under bin/.
ifeq ($(OS),Windows_NT)
VBIN    := .venv/Scripts
else
VBIN    := .venv/bin
endif

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- local stack
.PHONY: setup
setup: ## Create venv, install deps, init the database
	$(LAUNCH) setup

.PHONY: up
up: ## Start the full stack
	$(LAUNCH) up

.PHONY: down
down: ## Stop the stack
	$(LAUNCH) down

.PHONY: restart
restart: ## Restart the stack
	$(LAUNCH) restart

.PHONY: status
status: ## Service & health overview
	$(LAUNCH) status

.PHONY: logs
logs: ## Tail all logs
	$(LAUNCH) logs

.PHONY: nuke
nuke: ## Delete the local database + media (DESTRUCTIVE)
	$(LAUNCH) nuke

# ---------------------------------------------------------------- database
.PHONY: initdb
initdb: ## Create the SQLite schema from the ORM models
	cd backend && $(VBIN)/python -m app.db_init

# ---------------------------------------------------------------- models
.PHONY: pull-models
pull-models: ## Pull the default Ollama models
	$(LAUNCH) pull

# ---------------------------------------------------------------- quality
.PHONY: test
test: ## Run backend tests
	cd backend && $(VBIN)/python -m pytest -q

.PHONY: lint
lint: ## Lint backend
	cd backend && $(VBIN)/ruff check app

.PHONY: fmt
fmt: ## Format backend
	cd backend && $(VBIN)/ruff format app
