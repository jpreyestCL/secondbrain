# second brain — orquestacion local multi-tenant (colima + docker compose)
# Uso: make up | down | logs | backup | restore BACKUP=<archivo> | status
#      make add-tenant NAME=<nombre> PORT=<puerto> | install-launchd

SHELL := /bin/bash
REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
COMPOSE_BASE := $(REPO_ROOT)/infra/docker-compose.yml
COMPOSE_TENANTS := $(REPO_ROOT)/infra/docker-compose.tenants.yml
ENV_FILE := $(REPO_ROOT)/.env
GEN := bash $(REPO_ROOT)/infra/scripts/gen-tenants-compose.sh
GEN_ACL := bash $(REPO_ROOT)/infra/scripts/gen-falkordb-acl.sh

# --env-file solo si existe .env (si no, se usan los defaults del compose)
ifneq ($(wildcard $(ENV_FILE)),)
COMPOSE := docker compose --env-file $(ENV_FILE) -f $(COMPOSE_BASE) -f $(COMPOSE_TENANTS)
else
COMPOSE := docker compose -f $(COMPOSE_BASE) -f $(COMPOSE_TENANTS)
endif

PLIST := com.jpreyest.brain-backup.plist
LAUNCH_AGENTS := $(HOME)/Library/LaunchAgents

.PHONY: up down logs backup restore status add-tenant install-launchd _check-docker _gen

_check-docker:
	@command -v docker >/dev/null 2>&1 || { echo "ERROR: docker CLI no encontrado (¿termino la instalacion de colima?)"; exit 1; }
	@docker ps >/dev/null 2>&1 || { echo "ERROR: el daemon docker no responde. Ejecuta: colima start"; exit 1; }

_gen:
	@$(GEN)
	@$(GEN_ACL)

up: _check-docker _gen
	@[ -f $(ENV_FILE) ] || echo "AVISO: no existe .env — usando valores por defecto (cp .env.example .env)"
	$(COMPOSE) up -d
	@$(COMPOSE) ps

down: _check-docker _gen
	$(COMPOSE) down

logs: _check-docker _gen
	$(COMPOSE) logs -f --tail=200

status: _gen
	@if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then \
		$(COMPOSE) ps; \
		echo ""; echo "Tenants:"; \
		for f in $(REPO_ROOT)/infra/tenants/*.env; do \
			[ -f "$$f" ] || continue; \
			case "$$f" in *tenant.env.example) continue;; esac; \
			name=$$(sed -n 's/^TENANT_NAME=//p' "$$f" | tail -1); \
			port=$$(sed -n 's/^MCP_PORT=//p' "$$f" | tail -1); \
			if curl -fsS -m 3 "http://127.0.0.1:$$port/health" >/dev/null 2>&1; then hc=OK; else hc=SIN-RESPUESTA; fi; \
			printf '  %-16s http://127.0.0.1:%s/mcp/   salud: %s\n' "$$name" "$$port" "$$hc"; \
		done; \
	else \
		echo "docker no disponible (colima detenido o instalandose)"; \
	fi

# make add-tenant NAME=maria PORT=8022
add-tenant:
	@[ -n "$(NAME)" ] && [ -n "$(PORT)" ] || { echo "Uso: make add-tenant NAME=<nombre> PORT=<puerto>"; exit 1; }
	bash $(REPO_ROOT)/infra/scripts/add-tenant.sh $(NAME) $(PORT)

backup:
	bash $(REPO_ROOT)/infra/scripts/backup.sh

# make restore BACKUP=backups/falkor-20260809-033000.tar.gz
# OJO: FalkorDB es compartido — el restore repone los grafos de TODOS los tenants.
restore: _check-docker _gen
	@[ -n "$(BACKUP)" ] || { echo "Uso: make restore BACKUP=backups/falkor-YYYYMMDD-HHMMSS.tar.gz"; exit 1; }
	@[ -f "$(BACKUP)" ] || { echo "ERROR: no existe $(BACKUP)"; exit 1; }
	@echo ">> Deteniendo stack"
	$(COMPOSE) down
	@echo ">> Guardando datos actuales en infra/data/falkordb.pre-restore"
	@rm -rf $(REPO_ROOT)/infra/data/falkordb.pre-restore
	@[ -d $(REPO_ROOT)/infra/data/falkordb ] && mv $(REPO_ROOT)/infra/data/falkordb $(REPO_ROOT)/infra/data/falkordb.pre-restore || true
	@echo ">> Extrayendo $(BACKUP)"
	@mkdir -p $(REPO_ROOT)/infra/data
	tar -xzf "$(BACKUP)" -C $(REPO_ROOT)/infra/data
	@echo ">> Levantando stack"
	$(COMPOSE) up -d
	@echo ">> Restaurado. Si todo esta bien, borra infra/data/falkordb.pre-restore"

install-launchd:
	@mkdir -p $(LAUNCH_AGENTS)
	@for p in com.jpreyest.brain-backup com.jpreyest.brain-gateway com.jpreyest.brain-ollama; do \
		cp $(REPO_ROOT)/infra/launchd/$$p.plist $(LAUNCH_AGENTS)/$$p.plist; \
		launchctl bootout gui/$$(id -u)/$$p 2>/dev/null || true; \
		launchctl bootstrap gui/$$(id -u) $(LAUNCH_AGENTS)/$$p.plist; \
		echo "Instalado: $$p"; \
	done
	@echo "Listo: backup diario 03:30, gateway OAuth (:8787) y ollama (:11434) al iniciar sesion."
