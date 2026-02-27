# MyModel — CLI Interattiva: Specifica per Claude Code

## OVERVIEW

La CLI `mymodel` deve guidare l'utente nella creazione del suo modello virtuale con un'esperienza interattiva stile wizard. L'utente non deve mai scrivere YAML a mano.

La CLI è Python (estende `src/vllm-sr/cli/main.py` esistente). Usa `rich` per UI e `inquirer`/`questionary` per i prompt interattivi.

---

## DIPENDENZE DA AGGIUNGERE

```
# In src/vllm-sr/requirements.txt o pyproject.toml
rich>=13.0
questionary>=2.0
pyyaml>=6.0
click>=8.0        # già presente in vllm-sr
```

---

## COMANDI

```
mymodel init              # Wizard interattivo: crea config.yaml da zero
mymodel add provider      # Aggiunge un provider (Regolo, OpenAI, Anthropic, custom)
mymodel add route         # Aggiunge una rotta di testo
mymodel add modality      # Configura rotta per audio/immagine/multimodale
mymodel remove provider   # Rimuove un provider
mymodel remove route      # Rimuove una rotta
mymodel config show       # Mostra config attuale (pretty-printed)
mymodel config validate   # Valida il config
mymodel serve             # Avvia il server (esistente, da rinominare)
mymodel route "query"     # Testa il routing per una query senza avviare il server
mymodel status            # Stato dei servizi
mymodel stop              # Ferma i servizi
mymodel dashboard         # Avvia la dashboard web
```

---

## COMANDO: `mymodel init` — Wizard completo

### Flow interattivo

```
$ mymodel init

  ╔══════════════════════════════════════════════╗
  ║            🤖 MyModel Setup Wizard           ║
  ╚══════════════════════════════════════════════╝

  Step 1/5 — Your Model Identity
  ─────────────────────────────────

  ? What do you want to call your model?
  > Francesco

  ? Add a description (optional):
  > My personal AI assistant for coding and research

  Step 2/5 — Backend Providers
  ─────────────────────────────

  ? Which providers do you want to use?
    (Use space to select, enter to confirm)

    ◉ Regolo.ai
    ◯ OpenAI
    ◯ Anthropic
    ◯ Custom OpenAI-compatible endpoint
    ◯ Local vLLM instance

  ? Regolo API key (or env var name):
  > ${REGOLO_API_KEY}

  ? Regolo base URL [https://api.regolo.ai/v1]:
  >

  ✓ Provider 'regolo' configured

  ? Add another provider? (Y/n)
  > Y

  ? Which provider?
    ◉ OpenAI

  ? OpenAI API key (or env var name):
  > ${OPENAI_API_KEY}

  ✓ Provider 'openai' configured

  ? Add another provider? (Y/n)
  > n

  Step 3/5 — Text Routing
  ────────────────────────

  Now let's define how text queries get routed to different models.

  ? Add a text route?
  > Y

  ? Route name:
  > coding

  ? Which provider for this route?
    ◉ regolo
    ◯ openai

  ? Model name at the provider:
  > qwen3-coder

  ? Priority (0=lowest, 100=highest) [50]:
  > 90

  ? Add keyword triggers? (words that activate this route)
  > code, function, debug, python, script, bug

  ? Add domain triggers? (ML-classified categories)
    (Use space to select)

    ◉ computer_science
    ◯ mathematics
    ◯ physics
    ◯ biology
    ◯ chemistry
    ◯ business
    ◯ economics
    ◯ philosophy
    ◯ law
    ◯ history
    ◯ psychology
    ◯ health
    ◯ engineering
    ◯ other

  ? Signal operator?
    ◉ OR  (any signal matches → use this route)
    ◯ AND (all signals must match)

  ✓ Route 'coding' → regolo/qwen3-coder (priority 90)

  ? Add another route? (Y/n)
  > Y

  [... repeat for more routes ...]

  ? Add another route? (Y/n)
  > n

  ? Default model (when no route matches)?
    Provider:
    ◉ regolo
    Model name:
  > llama-3.1-70b

  ✓ Default route → regolo/llama-3.1-70b

  Step 4/5 — Multimodal Routing (optional)
  ─────────────────────────────────────────

  ? Configure audio routing? (y/N)
  > y
  ? Provider: regolo
  ? Model: whisper-large-v3
  ✓ Audio → regolo/whisper-large-v3

  ? Configure image routing? (y/N)
  > y
  ? Provider: regolo
  ? Model: llava-next-72b
  ✓ Image → regolo/llava-next-72b

  ? Configure multimodal routing (text+image)? (y/N)
  > y
  ? Provider: openai
  ? Model: gpt-4o
  ✓ Multimodal → openai/gpt-4o

  Step 5/5 — Security & Plugins (optional)
  ─────────────────────────────────────────

  ? Enable PII detection? (y/N)
  > y
  ? Action when PII is detected?
    ◉ redact (remove PII from query)
    ◯ mask (replace with ***)
    ◯ block (reject request)
  ✓ PII detection: ON (redact)

  ? Enable jailbreak guard? (y/N)
  > y
  ✓ Jailbreak guard: ON (block)

  ? Enable semantic cache? (y/N)
  > n

  ════════════════════════════════════════

  📋 Configuration Summary
  ────────────────────────

  Model:      Francesco
  Port:       8000
  Providers:  regolo, openai

  Text Routes:
    1. coding    → regolo/qwen3-coder     (priority 90)
    2. default   → regolo/llama-3.1-70b   (priority 0)

  Modality Routes:
    Audio       → regolo/whisper-large-v3
    Image       → regolo/llava-next-72b
    Multimodal  → openai/gpt-4o

  Plugins:
    PII detection:   ✓ (redact)
    Jailbreak guard: ✓ (block)
    Semantic cache:  ✗

  ? Save configuration? (Y/n)
  > Y

  ✓ Config saved to ./config.yaml
  ✓ .env template saved to ./.env.example

  To start your model:
    mymodel serve

  To test routing:
    mymodel route "write a python function to sort a list"
```

---

## COMANDO: `mymodel add provider`

```
$ mymodel add provider

  ? Which provider?
    ◉ Regolo.ai
    ◯ OpenAI
    ◯ Anthropic
    ◯ Google (Gemini)
    ◯ Custom OpenAI-compatible endpoint

  > Custom OpenAI-compatible endpoint

  ? Provider name (for referencing in routes):
  > local-vllm

  ? Base URL:
  > http://192.168.1.100:8080/v1

  ? API key (leave empty if none):
  >

  ✓ Provider 'local-vllm' added to config.yaml
```

---

## COMANDO: `mymodel add route`

```
$ mymodel add route

  ? Route name:
  > math-expert

  ? Provider:
    ◯ regolo
    ◯ openai
    ◉ local-vllm

  ? Model name:
  > qwen3-math-72b

  ? Priority (0-100) [50]:
  > 80

  ? Keyword triggers (comma-separated, leave empty to skip):
  > equation, calcola, derivata, integrale, math, algebra

  ? Domain triggers:
    ◉ mathematics
    ◉ physics
    ◯ computer_science
    [...]

  ? Operator: OR

  ✓ Route 'math-expert' → local-vllm/qwen3-math-72b (priority 80)
    Added to config.yaml
```

---

## COMANDO: `mymodel config show`

```
$ mymodel config show

  ┌─────────────────────────────────────────────────┐
  │                  MyModel: Francesco              │
  │           "My personal AI assistant"             │
  └─────────────────────────────────────────────────┘

  Server: http://0.0.0.0:8000

  ┌─ Providers ────────────────────────────────────┐
  │ regolo      openai-compatible  api.regolo.ai   │
  │ openai      openai-compatible  api.openai.com  │
  │ local-vllm  openai-compatible  192.168.1.100   │
  └────────────────────────────────────────────────┘

  ┌─ Text Routes (by priority) ────────────────────┐
  │ P90  coding      → regolo/qwen3-coder          │
  │      keywords: code, function, debug, python    │
  │      domains: computer_science                  │
  │                                                 │
  │ P80  math-expert → local-vllm/qwen3-math-72b   │
  │      keywords: equation, calcola, derivata      │
  │      domains: mathematics, physics              │
  │                                                 │
  │ P0   default     → regolo/llama-3.1-70b         │
  └────────────────────────────────────────────────┘

  ┌─ Modality Routes ──────────────────────────────┐
  │ Audio       → regolo/whisper-large-v3           │
  │ Image       → regolo/llava-next-72b             │
  │ Multimodal  → openai/gpt-4o                     │
  └────────────────────────────────────────────────┘

  ┌─ Plugins ──────────────────────────────────────┐
  │ PII Detection:   ✓ ON (redact)                 │
  │ Jailbreak Guard: ✓ ON (block)                  │
  │ Semantic Cache:  ✗ OFF                         │
  └────────────────────────────────────────────────┘
```

---

## COMANDO: `mymodel route "query"` — Test routing offline

```
$ mymodel route "scrivi una funzione python per ordinare una lista"

  ┌─ Routing Result ───────────────────────────────┐
  │                                                 │
  │  Query:    "scrivi una funzione python per..."  │
  │  Modality: text                                 │
  │                                                 │
  │  Signals detected:                              │
  │    ✓ keyword:coding  (matched: "funzione",      │
  │                        "python")                │
  │    ✓ domain:computer_science (0.94)             │
  │                                                 │
  │  Decision:                                      │
  │    Route:    coding (priority 90)               │
  │    Provider: regolo                             │
  │    Model:    qwen3-coder                        │
  │    Operator: OR (keyword match sufficient)      │
  │                                                 │
  │  Plugins:                                       │
  │    PII:       clean ✓                           │
  │    Jailbreak: clean ✓                           │
  │    Cache:     miss                              │
  │                                                 │
  │  Latency: 4ms                                   │
  └────────────────────────────────────────────────┘

$ mymodel route "qual è la derivata di x^3?"

  ┌─ Routing Result ───────────────────────────────┐
  │  Query:    "qual è la derivata di x^3?"         │
  │  Modality: text                                 │
  │                                                 │
  │  Signals:                                       │
  │    ✓ keyword:math-expert (matched: "derivata")  │
  │    ✓ domain:mathematics (0.97)                  │
  │                                                 │
  │  Decision:                                      │
  │    Route:    math-expert (priority 80)          │
  │    Provider: local-vllm                         │
  │    Model:    qwen3-math-72b                     │
  └────────────────────────────────────────────────┘
```

---

## COMANDO: `mymodel serve` — Startup migliorato

```
$ mymodel serve

  ╔══════════════════════════════════════════════╗
  ║              🤖 MyModel: Francesco           ║
  ╚══════════════════════════════════════════════╝

  Loading classification models... ████████████ done (2.1s)

  ┌─ Configuration ────────────────────────────────┐
  │ Providers:  3 (regolo, openai, local-vllm)     │
  │ Routes:     3 (coding, math-expert, default)   │
  │ Plugins:    PII ✓  Jailbreak ✓  Cache ✗       │
  └────────────────────────────────────────────────┘

  ✓ Server listening on http://0.0.0.0:8000
  ✓ Dashboard on http://0.0.0.0:8700

  Try it:
    curl http://localhost:8000/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"model":"Francesco","messages":[{"role":"user","content":"hello"}]}'

  Press Ctrl+C to stop.

  ─── Logs ────────────────────────────────────────
  [14:32:01] POST /v1/chat/completions → coding → regolo/qwen3-coder (6ms)
  [14:32:15] POST /v1/chat/completions → default → regolo/llama-3.1-70b (3ms)
  [14:32:22] POST /v1/chat/completions → math-expert → local-vllm/qwen3-math-72b (5ms)
  [14:32:30] POST /v1/chat/completions → [BLOCKED] jailbreak detected (2ms)
```

---

## IMPLEMENTAZIONE PYTHON

### Struttura file

```
src/vllm-sr/          →  src/mymodel-cli/
├── cli/
│   ├── main.py           # Click CLI entry point
│   ├── init_wizard.py    # `mymodel init` wizard
│   ├── add_commands.py   # `mymodel add provider/route/modality`
│   ├── remove_commands.py
│   ├── config_commands.py # `mymodel config show/validate`
│   ├── route_test.py     # `mymodel route "query"`
│   ├── serve.py          # `mymodel serve` (starts Docker/binary)
│   └── ui.py             # Rich console helpers, shared formatting
├── config/
│   ├── schema.py         # Pydantic models for config validation
│   ├── loader.py         # Load/save/merge config.yaml
│   └── env.py            # Environment variable resolution
├── pyproject.toml
└── README.md
```

### `cli/main.py` — Entry point

```python
import click
from rich.console import Console

console = Console()

@click.group()
@click.version_option(version="0.1.0", prog_name="mymodel")
def cli():
    """MyModel — Create your personal AI model from multiple LLMs."""
    pass

@cli.command()
@click.option("--config", "-c", default="config.yaml", help="Output config path")
def init(config):
    """Interactive wizard to create your MyModel configuration."""
    from mymodel.cli.init_wizard import run_wizard
    run_wizard(config)

@cli.group()
def add():
    """Add a provider, route, or modality to your config."""
    pass

@add.command("provider")
@click.option("--config", "-c", default="config.yaml")
def add_provider(config):
    """Add a backend provider (Regolo, OpenAI, Anthropic, custom)."""
    from mymodel.cli.add_commands import add_provider_interactive
    add_provider_interactive(config)

@add.command("route")
@click.option("--config", "-c", default="config.yaml")
def add_route(config):
    """Add a text routing rule."""
    from mymodel.cli.add_commands import add_route_interactive
    add_route_interactive(config)

@add.command("modality")
@click.option("--config", "-c", default="config.yaml")
def add_modality(config):
    """Configure audio/image/multimodal routing."""
    from mymodel.cli.add_commands import add_modality_interactive
    add_modality_interactive(config)

@cli.group()
def remove():
    """Remove a provider or route from your config."""
    pass

@remove.command("provider")
@click.option("--config", "-c", default="config.yaml")
def remove_provider(config):
    from mymodel.cli.remove_commands import remove_provider_interactive
    remove_provider_interactive(config)

@remove.command("route")
@click.option("--config", "-c", default="config.yaml")
def remove_route(config):
    from mymodel.cli.remove_commands import remove_route_interactive
    remove_route_interactive(config)

@cli.group("config")
def config_group():
    """View and validate your configuration."""
    pass

@config_group.command("show")
@click.option("--config", "-c", default="config.yaml")
def config_show(config):
    """Pretty-print current configuration."""
    from mymodel.cli.config_commands import show_config
    show_config(config)

@config_group.command("validate")
@click.option("--config", "-c", default="config.yaml")
def config_validate(config):
    """Validate configuration file."""
    from mymodel.cli.config_commands import validate_config
    validate_config(config)

@cli.command()
@click.argument("query")
@click.option("--config", "-c", default="config.yaml")
def route(query, config):
    """Test routing for a query without starting the server."""
    from mymodel.cli.route_test import test_route
    test_route(query, config)

@cli.command()
@click.option("--config", "-c", default="config.yaml")
@click.option("--port", "-p", default=8000)
def serve(config, port):
    """Start the MyModel server."""
    from mymodel.cli.serve import start_server
    start_server(config, port)

@cli.command()
def status():
    """Show status of MyModel services."""
    from mymodel.cli.serve import show_status
    show_status()

@cli.command()
def stop():
    """Stop MyModel services."""
    from mymodel.cli.serve import stop_services
    stop_services()

@cli.command()
@click.option("--port", default=8700)
def dashboard(port):
    """Launch the web dashboard."""
    from mymodel.cli.serve import start_dashboard
    start_dashboard(port)

def main():
    cli()

if __name__ == "__main__":
    main()
```

### `cli/init_wizard.py` — The main wizard

```python
import questionary
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich import print as rprint
import yaml
from pathlib import Path

console = Console()

# Available ML domain categories (from vLLM SR MMLU taxonomy)
DOMAIN_CATEGORIES = [
    "computer_science", "mathematics", "physics", "biology", "chemistry",
    "business", "economics", "philosophy", "law", "history",
    "psychology", "health", "engineering", "other"
]

PROVIDER_PRESETS = {
    "Regolo.ai": {
        "type": "openai-compatible",
        "base_url": "https://api.regolo.ai/v1",
        "env_var": "REGOLO_API_KEY",
    },
    "OpenAI": {
        "type": "openai-compatible",
        "base_url": "https://api.openai.com/v1",
        "env_var": "OPENAI_API_KEY",
    },
    "Anthropic": {
        "type": "anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "env_var": "ANTHROPIC_API_KEY",
    },
    "Google (Gemini)": {
        "type": "openai-compatible",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "env_var": "GOOGLE_API_KEY",
    },
    "Custom OpenAI-compatible endpoint": None,
    "Local vLLM instance": {
        "type": "openai-compatible",
        "base_url": "http://localhost:8080/v1",
        "env_var": None,
    },
}


def run_wizard(output_path: str):
    config = {}
    env_vars = {}

    console.print(Panel(
        "[bold cyan]🤖 MyModel Setup Wizard[/bold cyan]",
        style="cyan",
        expand=False,
    ))

    # ── Step 1: Model Identity ──
    console.print("\n[bold]Step 1/5 — Your Model Identity[/bold]")
    console.print("─" * 40)

    model_name = questionary.text(
        "What do you want to call your model?",
        default="MyModel",
    ).ask()

    model_desc = questionary.text(
        "Add a description (optional):",
        default="",
    ).ask()

    config["model"] = {"name": model_name, "description": model_desc}
    config["server_port"] = 8000

    # ── Step 2: Providers ──
    console.print("\n[bold]Step 2/5 — Backend Providers[/bold]")
    console.print("─" * 40)

    config["providers"] = {}
    while True:
        provider_choices = list(PROVIDER_PRESETS.keys())
        # Remove already-added providers
        for existing in config["providers"]:
            for choice_name, preset in PROVIDER_PRESETS.items():
                if preset and existing in choice_name.lower().replace(".", "").replace(" ", ""):
                    if choice_name in provider_choices:
                        provider_choices.remove(choice_name)

        selected = questionary.select(
            "Which provider do you want to add?",
            choices=provider_choices,
        ).ask()

        preset = PROVIDER_PRESETS[selected]

        if selected == "Custom OpenAI-compatible endpoint":
            provider_name = questionary.text("Provider name (short, for config):").ask()
            base_url = questionary.text("Base URL:").ask()
            api_key_input = questionary.text(
                "API key (or ${ENV_VAR}, leave empty if none):",
                default=""
            ).ask()
            config["providers"][provider_name] = {
                "type": "openai-compatible",
                "base_url": base_url,
                "api_key": api_key_input,
            }
        else:
            # Use preset
            provider_name = selected.lower().replace(".", "").replace(" ", "-").split("(")[0].strip("-")
            if provider_name == "local-vllm-instance":
                provider_name = "local-vllm"

            base_url = preset["base_url"]
            custom_url = questionary.text(
                f"Base URL [{base_url}]:",
                default=base_url,
            ).ask()

            api_key = ""
            if preset.get("env_var"):
                key_input = questionary.text(
                    f"API key (or env var) [${{{preset['env_var']}}}]:",
                    default=f"${{{preset['env_var']}}}",
                ).ask()
                api_key = key_input
                if key_input.startswith("${"):
                    var_name = key_input[2:-1]
                    env_vars[var_name] = ""

            config["providers"][provider_name] = {
                "type": preset["type"],
                "base_url": custom_url,
                "api_key": api_key,
            }

        rprint(f"  [green]✓[/green] Provider '{provider_name}' configured")

        if not questionary.confirm("Add another provider?", default=False).ask():
            break

    # ── Step 3: Text Routes ──
    console.print("\n[bold]Step 3/5 — Text Routing[/bold]")
    console.print("─" * 40)
    console.print("Define how text queries get routed to different models.\n")

    config["text_routes"] = []
    provider_names = list(config["providers"].keys())

    while True:
        if not questionary.confirm("Add a text route?", default=True).ask():
            break

        route_name = questionary.text("Route name:").ask()

        provider = questionary.select(
            "Which provider?",
            choices=provider_names,
        ).ask()

        model = questionary.text("Model name at the provider:").ask()

        priority = int(questionary.text(
            "Priority (0=lowest, 100=highest) [50]:",
            default="50",
        ).ask())

        keywords_input = questionary.text(
            "Keyword triggers (comma-separated, leave empty to skip):",
            default="",
        ).ask()
        keywords = [k.strip() for k in keywords_input.split(",") if k.strip()] if keywords_input else []

        domains = questionary.checkbox(
            "Domain triggers (space to select, enter to confirm):",
            choices=DOMAIN_CATEGORIES,
        ).ask()

        operator = questionary.select(
            "Signal operator?",
            choices=[
                questionary.Choice("OR  (any signal matches → use this route)", value="OR"),
                questionary.Choice("AND (all signals must match)", value="AND"),
            ],
        ).ask()

        route = {
            "name": route_name,
            "priority": priority,
            "signals": {},
            "operator": operator,
            "provider": provider,
            "model": model,
        }
        if keywords:
            route["signals"]["keywords"] = keywords
        if domains:
            route["signals"]["domains"] = domains

        config["text_routes"].append(route)
        rprint(f"  [green]✓[/green] Route '{route_name}' → {provider}/{model} (priority {priority})")

    # Default route
    console.print("\n  Default model (when no route matches):")
    def_provider = questionary.select("Provider:", choices=provider_names).ask()
    def_model = questionary.text("Model name:").ask()
    config["text_routes"].append({
        "name": "default",
        "priority": 0,
        "signals": {},
        "operator": "OR",
        "provider": def_provider,
        "model": def_model,
    })
    rprint(f"  [green]✓[/green] Default route → {def_provider}/{def_model}")

    # ── Step 4: Modality Routes ──
    console.print("\n[bold]Step 4/5 — Multimodal Routing (optional)[/bold]")
    console.print("─" * 40)

    config["modality_routes"] = {}

    for modality in ["audio", "image", "multimodal"]:
        if questionary.confirm(f"Configure {modality} routing?", default=False).ask():
            mod_provider = questionary.select(f"{modality.title()} provider:", choices=provider_names).ask()
            mod_model = questionary.text(f"{modality.title()} model:").ask()
            config["modality_routes"][modality] = {
                "provider": mod_provider,
                "model": mod_model,
            }
            rprint(f"  [green]✓[/green] {modality.title()} → {mod_provider}/{mod_model}")

    # ── Step 5: Plugins ──
    console.print("\n[bold]Step 5/5 — Security & Plugins (optional)[/bold]")
    console.print("─" * 40)

    config["plugins"] = {}

    if questionary.confirm("Enable PII detection?", default=False).ask():
        action = questionary.select("Action when PII detected:", choices=[
            questionary.Choice("redact (remove PII from query)", value="redact"),
            questionary.Choice("mask (replace with ***)", value="mask"),
            questionary.Choice("block (reject request)", value="block"),
        ]).ask()
        config["plugins"]["pii_detection"] = {"enabled": True, "action": action}
        rprint(f"  [green]✓[/green] PII detection: ON ({action})")
    else:
        config["plugins"]["pii_detection"] = {"enabled": False, "action": "redact"}

    if questionary.confirm("Enable jailbreak guard?", default=False).ask():
        config["plugins"]["jailbreak_guard"] = {"enabled": True, "action": "block"}
        rprint("  [green]✓[/green] Jailbreak guard: ON (block)")
    else:
        config["plugins"]["jailbreak_guard"] = {"enabled": False, "action": "block"}

    if questionary.confirm("Enable semantic cache?", default=False).ask():
        config["plugins"]["semantic_cache"] = {
            "enabled": True,
            "backend": "memory",
            "ttl": 3600,
            "similarity_threshold": 0.92,
        }
        rprint("  [green]✓[/green] Semantic cache: ON (in-memory)")
    else:
        config["plugins"]["semantic_cache"] = {"enabled": False}

    # ── Summary ──
    console.print("\n" + "═" * 44)
    print_summary(config)

    if questionary.confirm("\nSave configuration?", default=True).ask():
        # Save config.yaml
        with open(output_path, "w") as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        rprint(f"\n  [green]✓[/green] Config saved to {output_path}")

        # Save .env.example
        if env_vars:
            env_path = Path(output_path).parent / ".env.example"
            with open(env_path, "w") as f:
                for var, val in env_vars.items():
                    f.write(f"{var}=your-key-here\n")
            rprint(f"  [green]✓[/green] .env template saved to {env_path}")

        console.print(f"\n  To start your model:")
        console.print(f"    [bold cyan]mymodel serve[/bold cyan]")
        console.print(f"\n  To test routing:")
        console.print(f'    [bold cyan]mymodel route "your query here"[/bold cyan]')


def print_summary(config):
    console.print("\n[bold]📋 Configuration Summary[/bold]")
    console.print("─" * 30)
    console.print(f"  Model:      {config['model']['name']}")
    console.print(f"  Port:       {config.get('server_port', 8000)}")
    console.print(f"  Providers:  {', '.join(config['providers'].keys())}")

    console.print("\n  Text Routes:")
    for route in sorted(config["text_routes"], key=lambda r: r["priority"], reverse=True):
        kw = route.get("signals", {}).get("keywords", [])
        dm = route.get("signals", {}).get("domains", [])
        details = []
        if kw:
            details.append(f"keywords: {', '.join(kw[:4])}")
        if dm:
            details.append(f"domains: {', '.join(dm[:3])}")
        detail_str = f" ({'; '.join(details)})" if details else ""
        console.print(f"    P{route['priority']:<3} {route['name']:<15} → {route['provider']}/{route['model']}{detail_str}")

    if config.get("modality_routes"):
        console.print("\n  Modality Routes:")
        for mod, route in config["modality_routes"].items():
            console.print(f"    {mod.title():<12} → {route['provider']}/{route['model']}")

    console.print("\n  Plugins:")
    plugins = config.get("plugins", {})
    for name, conf in plugins.items():
        status = "[green]✓ ON[/green]" if conf.get("enabled") else "[dim]✗ OFF[/dim]"
        action = f" ({conf.get('action', '')})" if conf.get("enabled") and conf.get("action") else ""
        display_name = name.replace("_", " ").title()
        console.print(f"    {display_name:<20} {status}{action}")
```

### `cli/ui.py` — Shared helpers

```python
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

console = Console()

def print_routing_result(result: dict):
    """Pretty-print a routing test result."""
    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column(style="bold")
    table.add_column()

    table.add_row("Query:", result.get("query", ""))
    table.add_row("Modality:", result.get("modality", ""))
    table.add_row("", "")

    # Signals
    signals = result.get("signals", [])
    if signals:
        table.add_row("Signals:", "")
        for s in signals:
            table.add_row("", f"[green]✓[/green] {s}")
    else:
        table.add_row("Signals:", "[dim]none[/dim]")

    table.add_row("", "")

    # Decision
    table.add_row("Route:", result.get("route_name", ""))
    table.add_row("Provider:", result.get("provider", ""))
    table.add_row("Model:", result.get("model", ""))
    table.add_row("Reason:", result.get("reason", ""))

    # Plugins
    table.add_row("", "")
    if result.get("blocked"):
        table.add_row("Status:", f"[red]BLOCKED — {result.get('block_reason')}[/red]")
    else:
        table.add_row("PII:", "[green]clean ✓[/green]")
        table.add_row("Jailbreak:", "[green]clean ✓[/green]")

    if result.get("latency_ms"):
        table.add_row("Latency:", f"{result['latency_ms']}ms")

    console.print(Panel(table, title="Routing Result", border_style="cyan"))


def print_server_banner(config: dict):
    """Print the startup banner."""
    model_name = config.get("model", {}).get("name", "MyModel")
    port = config.get("server_port", 8000)

    console.print(Panel(
        f"[bold cyan]🤖 MyModel: {model_name}[/bold cyan]",
        style="cyan",
        expand=False,
    ))

    providers = list(config.get("providers", {}).keys())
    routes = config.get("text_routes", [])

    table = Table(show_header=False, box=None)
    table.add_column(style="bold")
    table.add_column()
    table.add_row("Providers:", f"{len(providers)} ({', '.join(providers)})")
    table.add_row("Routes:", f"{len(routes)}")

    plugins = config.get("plugins", {})
    plugin_status = []
    for name, conf in plugins.items():
        short = name.split("_")[0].upper()
        if conf.get("enabled"):
            plugin_status.append(f"{short} ✓")
        else:
            plugin_status.append(f"{short} ✗")
    table.add_row("Plugins:", "  ".join(plugin_status))

    console.print(Panel(table, title="Configuration", border_style="dim"))

    console.print(f"\n  [green]✓[/green] Server listening on [bold]http://0.0.0.0:{port}[/bold]")
    console.print(f'\n  Try it:')
    console.print(f'    curl http://localhost:{port}/v1/chat/completions \\')
    console.print(f'      -H "Content-Type: application/json" \\')
    console.print(f'      -d \'{{"model":"{model_name}","messages":[{{"role":"user","content":"hello"}}]}}\'')
    console.print(f'\n  Press Ctrl+C to stop.\n')
```

---

## PYPROJECT.TOML

```toml
[project]
name = "mymodel"
version = "0.1.0"
description = "Create your personal AI model from multiple LLMs"
readme = "README.md"
license = { text = "Apache-2.0" }
requires-python = ">=3.10"
dependencies = [
    "click>=8.0",
    "rich>=13.0",
    "questionary>=2.0",
    "pyyaml>=6.0",
    "docker>=7.0",
    "pydantic>=2.0",
]

[project.scripts]
mymodel = "mymodel.cli.main:main"

[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.backends._legacy:_Backend"
```

---

## EXECUTION ORDER FOR CLAUDE CODE

```
1.  Rename src/vllm-sr/ → src/mymodel-cli/
2.  Update pyproject.toml with new name and dependencies
3.  Create cli/main.py with all Click commands
4.  Create cli/ui.py with Rich helpers
5.  Create cli/init_wizard.py (the main wizard)
6.  Create cli/add_commands.py (add provider/route/modality)
7.  Create cli/remove_commands.py
8.  Create cli/config_commands.py (show/validate)
9.  Create cli/route_test.py (calls the Go binary for classification)
10. Create cli/serve.py (starts the Go binary or Docker container)
11. Create config/schema.py (Pydantic validation)
12. Create config/loader.py (YAML load/save with env var resolution)
13. Test: pip install -e . && mymodel init
14. Test: mymodel config show
15. Test: mymodel route "write python code"
```

## CRITICAL NOTES FOR CLAUDE CODE

- **`questionary` is the interactive prompt library.** It supports: text, select, checkbox, confirm, password. Use `questionary` for all interactive inputs, `rich` for all display/formatting.

- **The wizard must generate a VALID config.yaml** that the Go router can read. The YAML structure must match exactly what `config.go` expects. Test by running `mymodel config validate` after generation.

- **Environment variable syntax** in config is `${VAR_NAME}`. The CLI should offer this as default for API keys and also generate a `.env.example` file.

- **`mymodel serve`** under the hood: either starts the Go binary directly (if compiled locally) or runs `docker compose up` with the correct config mounted. Detect which mode based on whether the Go binary exists at a known path.

- **`mymodel route "query"`** needs to call the Go binary with a special flag (e.g., `mymodel-router --route-test "query" --config config.yaml`) that runs classification without starting the HTTP server. This requires a corresponding CLI flag in the Go main.go (already in the fork plan as a feature to add).

- **All output should be Rich-formatted** with consistent styling: green checkmarks for success, red for errors, cyan for highlights, dim for secondary info. Use Panels for grouped info, Tables for structured data.

- **The wizard should work in non-interactive mode too** for CI/CD. Add `--non-interactive` flag that reads from a JSON/YAML input file instead of prompting.