"""Commands for `mymodel serve`, `mymodel status`, `mymodel stop`, `mymodel dashboard`."""

import os
import sys
import webbrowser

from mymodel.cli.ui import console, print_server_banner
from mymodel.config.loader import MyModelConfig


def start_server(config_path: str, port: int):
    """Start the MyModel server with a Rich startup banner."""
    try:
        config = MyModelConfig.load(config_path)
    except FileNotFoundError:
        console.print(f"[red]Config file not found: {config_path}[/red]")
        console.print("Run [bold]mymodel init[/bold] to create a configuration.")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error loading config: {e}[/red]")
        sys.exit(1)

    # Override port if specified
    if port and port != config.server.port:
        config.server.port = port

    # Print Rich startup banner
    banner_data = config.model_dump(exclude_none=True)
    # Flatten for banner display
    banner_data["server_port"] = config.server.port
    print_server_banner(banner_data)

    # Try to delegate to the existing vLLM SR core
    try:
        from mymodel.cli.core import start_vllm_sr
        from pathlib import Path

        config_abs = str(Path(config_path).absolute())

        # Collect env vars
        env_vars = {}
        api_key_vars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "REGOLO_API_KEY", "GOOGLE_API_KEY"]
        hf_vars = ["HF_ENDPOINT", "HF_TOKEN", "HF_HOME", "HF_HUB_CACHE"]
        for var in api_key_vars + hf_vars:
            if var in os.environ:
                env_vars[var] = os.environ[var]

        start_vllm_sr(
            config_file=config_abs,
            env_vars=env_vars,
        )
    except KeyboardInterrupt:
        console.print("\n[dim]Server stopped.[/dim]")
    except ImportError:
        console.print("[yellow]Docker service management not available.[/yellow]")
        console.print(
            "To run the server directly, use the Go binary:\n"
            f"  semantic-router --config {config_path}"
        )
    except Exception as e:
        console.print(f"[red]Error starting server: {e}[/red]")
        sys.exit(1)


def show_status():
    """Show status of MyModel services."""
    try:
        from mymodel.cli.core import show_status as _show_status
        _show_status("all")
    except ImportError:
        console.print("[yellow]Docker status not available.[/yellow]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")


def stop_services():
    """Stop MyModel services."""
    try:
        from mymodel.cli.core import stop_vllm_sr
        stop_vllm_sr()
        console.print("[green]✓[/green] Services stopped.")
    except ImportError:
        console.print("[yellow]Docker service management not available.[/yellow]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")


def start_dashboard(port: int):
    """Launch the web dashboard."""
    try:
        from mymodel.cli.docker_cli import docker_container_status
        from mymodel.cli.consts import VLLM_SR_DOCKER_NAME

        status = docker_container_status(VLLM_SR_DOCKER_NAME)
        if status != "running":
            console.print("[red]MyModel is not running.[/red]")
            console.print("Start it with: [bold]mymodel serve[/bold]")
            return

        url = f"http://localhost:{port}"
        console.print(f"  Opening dashboard: {url}")
        webbrowser.open(url)
        console.print("[green]✓[/green] Dashboard opened in browser.")
    except ImportError:
        console.print("[yellow]Docker service management not available.[/yellow]")
        console.print(f"  Dashboard URL: http://localhost:{port}")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
