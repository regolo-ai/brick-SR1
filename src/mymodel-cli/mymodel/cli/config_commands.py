"""Commands for `mymodel config show` and `mymodel config validate`.

show_config() → Interactive Textual TabbedContent viewer.
validate_config() → Rich one-shot output (unchanged).
"""

import os
import re
import sys
from urllib.parse import urlparse

from textual.app import ComposeResult
from textual.widgets import (
    DataTable,
    Footer,
    Static,
    TabbedContent,
    TabPane,
)

from mymodel.cli.ui import (
    ACCENT,
    ERROR,
    SUCCESS,
    MyModelApp,
    console,
    print_err,
    print_ok,
    require_tty,
    spinner,
)
from mymodel.config.loader import MyModelConfig, mask_secret


# ═══════════════════════════════════════════════════════════════════════
# Config Viewer (Textual TabbedContent)
# ═══════════════════════════════════════════════════════════════════════

def show_config(config_path: str):
    """Pretty-print current configuration in an interactive tabbed viewer."""
    try:
        config = MyModelConfig.load(config_path)
    except FileNotFoundError:
        print_err(f"Config file not found: {config_path}")
        console.print("  Run [bold]mymodel init[/bold] to create a configuration.")
        sys.exit(1)
    except Exception as e:
        print_err(f"Error loading config: {e}")
        sys.exit(1)

    require_tty()

    app = ConfigViewerApp(config)
    app.run()


class ConfigViewerApp(MyModelApp):
    """Tabbed config viewer: Overview, Providers, Routes, Modalities, Plugins."""

    CSS_PATH = "styles/wizard.tcss"

    BINDINGS = [
        ("q", "quit", "Quit"),
    ]

    def __init__(self, config: MyModelConfig, **kwargs):
        super().__init__(**kwargs)
        self._config = config

    def compose(self) -> ComposeResult:
        with TabbedContent():
            # ── Overview Tab ──
            with TabPane("Overview", id="tab-overview"):
                desc = f'  "{self._config.model.description}"' if self._config.model.description else ""
                yield Static(
                    f"[bold]MyModel: {self._config.model.name}[/bold]\n"
                    f"{desc}\n\n"
                    f"  Server: http://0.0.0.0:{self._config.server.port}\n"
                    f"  Providers: {len(self._config.providers)}\n"
                    f"  Text Routes: {len(self._config.text_routes)}\n"
                    f"  Modality Routes: {len(self._config.modality_routes)}\n"
                    f"  Plugins: {sum(1 for p in self._config.plugins.values() if p.enabled)}"
                    f" active / {len(self._config.plugins)} total"
                )

            # ── Providers Tab ──
            with TabPane("Providers", id="tab-providers"):
                prov_table = DataTable(id="prov-table")
                prov_table.add_columns("Name", "Type", "Base URL", "API Key")
                yield prov_table

            # ── Routes Tab ──
            with TabPane("Routes", id="tab-routes"):
                route_table = DataTable(id="route-table")
                route_table.add_columns("Priority", "Name", "Target", "Operator", "Signals")
                yield route_table

            # ── Modalities Tab ──
            with TabPane("Modalities", id="tab-modalities"):
                if self._config.modality_routes:
                    mod_table = DataTable(id="mod-table")
                    mod_table.add_columns("Modality", "Provider", "Model")
                    yield mod_table
                else:
                    yield Static("  No modality routes configured.")

            # ── Plugins Tab ──
            with TabPane("Plugins", id="tab-plugins"):
                plugin_table = DataTable(id="plugin-table")
                plugin_table.add_columns("Plugin", "Status", "Action")
                yield plugin_table

        yield Footer()

    def on_mount(self) -> None:
        # Populate Providers table
        prov_table = self.query_one("#prov-table", DataTable)
        for name, prov in self._config.providers.items():
            host = urlparse(prov.base_url).hostname or prov.base_url
            prov_table.add_row(
                name,
                prov.type,
                host,
                mask_secret(prov.api_key) if prov.api_key else "(none)",
            )

        # Populate Routes table
        route_table = self.query_one("#route-table", DataTable)
        for route in sorted(self._config.text_routes, key=lambda r: r.priority, reverse=True):
            signals_parts = []
            if route.signals.keywords:
                signals_parts.append(f"kw: {', '.join(route.signals.keywords[:4])}")
            if route.signals.domains:
                signals_parts.append(f"dom: {', '.join(route.signals.domains[:3])}")
            signals_str = "; ".join(signals_parts) if signals_parts else "—"

            route_table.add_row(
                f"P{route.priority}",
                route.name,
                f"{route.provider}/{route.model}",
                route.operator,
                signals_str,
            )

        # Populate Modalities table
        if self._config.modality_routes:
            mod_table = self.query_one("#mod-table", DataTable)
            for mod, route in self._config.modality_routes.items():
                mod_table.add_row(mod.title(), route.provider, route.model)

        # Populate Plugins table
        plugin_table = self.query_one("#plugin-table", DataTable)
        for name, conf in self._config.plugins.items():
            display_name = name.replace("_", " ").title()
            status = "ON" if conf.enabled else "OFF"
            action = conf.action if conf.enabled and conf.action else "—"
            plugin_table.add_row(display_name, status, action)


# ═══════════════════════════════════════════════════════════════════════
# Validate Config (Rich one-shot — unchanged)
# ═══════════════════════════════════════════════════════════════════════

def validate_config(config_path: str):
    """Validate the configuration file."""
    with spinner("Validating configuration..."):
        try:
            config = MyModelConfig.load(config_path)
        except FileNotFoundError:
            print_err(f"Config file not found: {config_path}")
            sys.exit(1)
        except Exception as e:
            print_err(f"Config parsing error: {e}")
            sys.exit(1)

        errors = []

        # Check providers in routes
        errors.extend(config.validate_providers_in_routes())

        # Check we have at least one provider
        if not config.providers:
            errors.append("No providers configured")

        # Check env vars are resolvable
        env_re = re.compile(r"\$\{([^}]+)\}")
        for pname, prov in config.providers.items():
            if prov.api_key:
                for m in env_re.finditer(prov.api_key):
                    var = m.group(1)
                    if var not in os.environ:
                        errors.append(
                            f"Provider '{pname}': env var ${{{var}}} is not set"
                        )

    if errors:
        console.print(f"\n[{ERROR}]◉ Validation failed ({len(errors)} error(s)):[/{ERROR}]\n")
        for err in errors:
            console.print(f"  [{ERROR}]○[/{ERROR}] {err}")
        sys.exit(1)
    else:
        print_ok("Configuration is valid")
        console.print(f"  Model:     [{ACCENT}]{config.model.name}[/{ACCENT}]")
        console.print(f"  Providers: {len(config.providers)}")
        console.print(f"  Routes:    {len(config.text_routes)}")
        if config.modality_routes:
            console.print(f"  Modalities: [{ACCENT}]{', '.join(config.modality_routes.keys())}[/{ACCENT}]")
