"""MyModel CLI — Create your personal AI model from multiple LLMs.

Entry point for the `mymodel` command. Uses Click for CLI structure,
delegates to wizard/interactive modules that use Textual TUI for
interactive screens and Rich for one-shot display output.
"""

import atexit
import os
import shutil
import sys
import tempfile
import yaml
from pathlib import Path

import click

from mymodel import __version__

# Track temp directories for cleanup
_temp_dirs = []


def _cleanup_temp_dirs():
    for temp_dir in _temp_dirs:
        try:
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)
        except Exception:
            pass


atexit.register(_cleanup_temp_dirs)


# ── Root CLI group ───────────────────────────────────────────────────

@click.group(invoke_without_command=True)
@click.version_option(version=__version__, prog_name="mymodel")
@click.pass_context
def cli(ctx):
    """MyModel — Create your personal AI model from multiple LLMs."""
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


# ── init ─────────────────────────────────────────────────────────────

@cli.command()
@click.option("--config", "-c", default="config.yaml", help="Output config path")
def init(config):
    """Interactive wizard to create your MyModel configuration."""
    from mymodel.cli.init_wizard import run_wizard
    run_wizard(config)


# ── add (group) ──────────────────────────────────────────────────────

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


# ── remove (group) ───────────────────────────────────────────────────

@cli.group()
def remove():
    """Remove a provider or route from your config."""
    pass


@remove.command("provider")
@click.option("--config", "-c", default="config.yaml")
def remove_provider(config):
    """Remove a provider from your config."""
    from mymodel.cli.remove_commands import remove_provider_interactive
    remove_provider_interactive(config)


@remove.command("route")
@click.option("--config", "-c", default="config.yaml")
def remove_route(config):
    """Remove a text route from your config."""
    from mymodel.cli.remove_commands import remove_route_interactive
    remove_route_interactive(config)


# ── config (group) ───────────────────────────────────────────────────

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


# ── route (test) ─────────────────────────────────────────────────────

@cli.command()
@click.argument("query")
@click.option("--config", "-c", default="config.yaml")
def route(query, config):
    """Test routing for a query without starting the server."""
    from mymodel.cli.route_test import test_route
    test_route(query, config)


# ── serve ────────────────────────────────────────────────────────────

# Valid algorithm types for model selection (legacy vLLM SR support)
ALGORITHM_TYPES = [
    "static", "elo", "router_dc", "automix", "hybrid",
    "thompson", "gmtrouter", "router_r1",
]


def _inject_algorithm_into_config(config_path: Path, algorithm: str) -> Path:
    """Inject algorithm type into all decisions in the config file."""
    with open(config_path, "r") as f:
        cfg = yaml.safe_load(f)

    for decision in cfg.get("decisions", []):
        if "algorithm" not in decision:
            decision["algorithm"] = {}
        decision["algorithm"]["type"] = algorithm

    temp_dir = tempfile.mkdtemp(prefix="mymodel-")
    _temp_dirs.append(temp_dir)
    temp_path = Path(temp_dir) / "config-with-algorithm.yaml"
    with open(temp_path, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False, sort_keys=False)

    return temp_path


@cli.command()
@click.option("--config", "-c", default="config.yaml", help="Path to config file")
@click.option("--port", "-p", default=8000, help="Server port")
@click.option("--image", default=None, help="Docker image to use")
@click.option(
    "--algorithm",
    type=click.Choice(ALGORITHM_TYPES, case_sensitive=False),
    default=None,
    help="Model selection algorithm override",
)
@click.option("--minimal", is_flag=True, default=False, help="No dashboard or observability")
@click.option("--readonly", is_flag=True, default=False, help="Dashboard read-only mode")
def serve(config, port, image, algorithm, minimal, readonly):
    """Start the MyModel server."""
    from mymodel.cli.serve import start_server
    from mymodel.cli.ui import console

    config_path = Path(config)
    if not config_path.exists():
        console.print(f"[red]Config file not found: {config}[/red]")
        console.print("Run [bold]mymodel init[/bold] to create a config file.")
        sys.exit(1)

    # Algorithm injection (legacy vLLM SR support)
    effective_path = config_path
    if algorithm:
        effective_path = _inject_algorithm_into_config(config_path, algorithm.lower())

    start_server(str(effective_path), port)


# ── status / stop / dashboard ────────────────────────────────────────

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


# ── Legacy commands (kept for backwards compatibility) ───────────────

@cli.command("generate", hidden=True)
@click.argument("config_type", type=click.Choice(["envoy", "router"]))
@click.option("--config", default="config.yaml")
def generate(config_type, config):
    """[Legacy] Generate envoy or router config."""
    from mymodel.cli.commands.config import config_command
    config_command(config_type, config)


@cli.command("logs", hidden=True)
@click.argument("service", type=click.Choice(["envoy", "router", "dashboard"]))
@click.option("--follow", "-f", is_flag=True)
def logs(service, follow):
    """[Legacy] Show logs from a service."""
    from mymodel.cli.core import show_logs
    try:
        show_logs(service, follow=follow)
    except KeyboardInterrupt:
        pass


# ── Entry point ──────────────────────────────────────────────────────

def main():
    cli()


if __name__ == "__main__":
    main()
