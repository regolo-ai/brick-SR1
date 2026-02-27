"""Interactive commands for `mymodel remove provider/route`.

Each command launches a single-screen Textual app.
"""

from typing import Optional

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import (
    Button,
    Footer,
    Label,
    OptionList,
    Static,
)
from textual.widgets.option_list import Option

from mymodel.cli.ui import (
    ConfirmDialog,
    MyModelApp,
    console,
    print_err,
    print_ok,
    print_warn,
    require_tty,
)
from mymodel.config.loader import MyModelConfig


# ═══════════════════════════════════════════════════════════════════════
# Remove Provider
# ═══════════════════════════════════════════════════════════════════════

class RemoveProviderScreen(Screen):
    """Single-screen for selecting and removing a provider."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, provider_names: list[str], orphan_info: dict[str, list[str]], **kwargs):
        super().__init__(**kwargs)
        self._provider_names = provider_names
        self._orphan_info = orphan_info  # provider_name -> list of route names

    def compose(self) -> ComposeResult:
        yield Static(
            "[bold]Remove Provider[/bold]\n\n"
            "Select a provider to remove:\n",
            classes="section-header",
        )

        yield OptionList(
            *[Option(name, id=name) for name in self._provider_names],
            id="provider-list",
        )

        yield Static("", id="orphan-warning")

        with Horizontal(classes="nav-bar"):
            yield Button("Remove", variant="error", id="btn-remove")
            yield Button("Cancel", variant="default", id="btn-cancel")

        yield Footer()

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        if event.option and event.option.id:
            name = str(event.option.id)
            orphans = self._orphan_info.get(name, [])
            warning = self.query_one("#orphan-warning", Static)
            if orphans:
                routes_str = ", ".join(orphans)
                warning.update(
                    f"[bold yellow]Warning:[/bold yellow] Routes using this provider: {routes_str}\n"
                    "These routes will become orphaned."
                )
            else:
                warning.update("")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-remove":
            self._try_remove()
        elif event.button.id == "btn-cancel":
            self.app.exit(None)

    def _try_remove(self) -> None:
        option_list = self.query_one("#provider-list", OptionList)
        idx = option_list.highlighted
        if idx is None or idx < 0 or idx >= len(self._provider_names):
            self.notify("Select a provider", severity="warning")
            return

        selected = self._provider_names[idx]
        orphans = self._orphan_info.get(selected, [])

        if orphans:
            def on_confirmed(confirmed: bool) -> None:
                if confirmed:
                    self.app.exit(selected)

            self.app.push_screen(
                ConfirmDialog(
                    f"Remove provider '{selected}'?\n"
                    f"Routes {', '.join(orphans)} will become orphaned."
                ),
                callback=on_confirmed,
            )
        else:
            self.app.exit(selected)

    def action_cancel(self) -> None:
        self.app.exit(None)


class RemoveProviderApp(MyModelApp):
    CSS_PATH = "styles/wizard.tcss"

    def __init__(self, provider_names: list[str], orphan_info: dict[str, list[str]], **kwargs):
        super().__init__(**kwargs)
        self._provider_names = provider_names
        self._orphan_info = orphan_info

    def on_mount(self) -> None:
        self.push_screen(RemoveProviderScreen(self._provider_names, self._orphan_info))


# ═══════════════════════════════════════════════════════════════════════
# Remove Route
# ═══════════════════════════════════════════════════════════════════════

class RemoveRouteScreen(Screen):
    """Single-screen for selecting and removing a text route."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, route_display: list[tuple[str, str]], **kwargs):
        """route_display: list of (display_text, route_name)."""
        super().__init__(**kwargs)
        self._route_display = route_display

    def compose(self) -> ComposeResult:
        yield Static(
            "[bold]Remove Text Route[/bold]\n\n"
            "Select a route to remove:\n",
            classes="section-header",
        )

        yield OptionList(
            *[Option(display, id=name) for display, name in self._route_display],
            id="route-list",
        )

        with Horizontal(classes="nav-bar"):
            yield Button("Remove", variant="error", id="btn-remove")
            yield Button("Cancel", variant="default", id="btn-cancel")

        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-remove":
            self._try_remove()
        elif event.button.id == "btn-cancel":
            self.app.exit(None)

    def _try_remove(self) -> None:
        option_list = self.query_one("#route-list", OptionList)
        idx = option_list.highlighted
        if idx is None or idx < 0 or idx >= len(self._route_display):
            self.notify("Select a route", severity="warning")
            return

        _, route_name = self._route_display[idx]

        def on_confirmed(confirmed: bool) -> None:
            if confirmed:
                self.app.exit(route_name)

        self.app.push_screen(
            ConfirmDialog(f"Remove route '{route_name}'?"),
            callback=on_confirmed,
        )

    def action_cancel(self) -> None:
        self.app.exit(None)


class RemoveRouteApp(MyModelApp):
    CSS_PATH = "styles/wizard.tcss"

    def __init__(self, route_display: list[tuple[str, str]], **kwargs):
        super().__init__(**kwargs)
        self._route_display = route_display

    def on_mount(self) -> None:
        self.push_screen(RemoveRouteScreen(self._route_display))


# ═══════════════════════════════════════════════════════════════════════
# Entry Points
# ═══════════════════════════════════════════════════════════════════════

def remove_provider_interactive(config_path: str):
    """Interactively remove a provider from the config."""
    require_tty()

    try:
        config = MyModelConfig.load(config_path)
    except FileNotFoundError:
        print_err(f"Config file not found: {config_path}")
        return
    except Exception as e:
        print_err(f"Error loading config: {e}")
        return

    provider_names = list(config.providers.keys())
    if not provider_names:
        console.print("  [dim]No providers configured.[/dim]")
        return

    # Build orphan info
    orphan_info = {}
    for name in provider_names:
        routes = config.get_routes_for_provider(name)
        if routes:
            orphan_info[name] = routes

    app = RemoveProviderApp(provider_names, orphan_info)
    result = app.run()

    if result is None:
        console.print("  Cancelled.")
        return

    del config.providers[result]
    config.save(config_path)
    print_ok(f"Provider [bold]'{result}'[/bold] removed from {config_path}")


def remove_route_interactive(config_path: str):
    """Interactively remove a text route from the config."""
    require_tty()

    try:
        config = MyModelConfig.load(config_path)
    except FileNotFoundError:
        print_err(f"Config file not found: {config_path}")
        return
    except Exception as e:
        print_err(f"Error loading config: {e}")
        return

    if not config.text_routes:
        console.print("  [dim]No text routes configured.[/dim]")
        return

    route_display = [
        (
            f"{r.name} → {r.provider}/{r.model} (P{r.priority})",
            r.name,
        )
        for r in config.text_routes
    ]

    app = RemoveRouteApp(route_display)
    result = app.run()

    if result is None:
        console.print("  Cancelled.")
        return

    config.text_routes = [r for r in config.text_routes if r.name != result]
    config.save(config_path)
    print_ok(f"Route [bold]'{result}'[/bold] removed from {config_path}")
