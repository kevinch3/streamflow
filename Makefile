COMPOSE      = docker compose
COMPOSE_PROD = docker compose -f docker-compose.yml -f docker-compose.prod.yml

.PHONY: setup up down logs restart ps status clean up-prod pull-prod watch-css

setup: ## First-time LAN setup: generate secrets, detect IP, configure firewall
	@bash scripts/setup.sh

up: ## Build + start all services (detached)
	$(COMPOSE) up --build -d

down: ## Stop all services
	$(COMPOSE) down

logs: ## Follow logs — filter with: make logs s=app
	$(COMPOSE) logs -f $(s)

restart: ## Restart one service: make restart s=app
	$(COMPOSE) restart $(s)

ps: ## Show container status and health
	$(COMPOSE) ps

status: ## Print container status + API token (for first dashboard login)
	@$(COMPOSE) ps
	@echo ""
	@$(COMPOSE) logs app 2>/dev/null | grep 'ephemeral token' | tail -1 || \
	  echo "(STREAM_API_TOKEN is set in .env — paste it into dashboard Settings)"

clean: ## Remove containers, volumes, and locally built images
	$(COMPOSE) down -v --rmi local

# ── Production (Phase 2) ───────────────────────────────────────────────────

up-prod: ## Start in production mode using pre-built GHCR image
	$(COMPOSE_PROD) up -d --no-build

pull-prod: ## Pull latest production image then restart
	$(COMPOSE_PROD) pull app
	$(COMPOSE_PROD) up -d --no-build

watch-css: ## Watch and rebuild Tailwind CSS on change
	cd frontend && npm run watch
