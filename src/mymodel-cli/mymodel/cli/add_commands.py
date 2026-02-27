"""Interactive commands for `mymodel add provider/route/modality`.

Each command launches a single-screen Textual app.
"""

from typing import Optional

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Input,
    Label,
    RadioSet,
    SelectionList,
    Static,
)

from mymodel.cli.ui import (
    ACCENT,
    LabeledInput,
    LabeledRadioSet,
    LabeledSelectionList,
    ModelPickerDialog,
    MyModelApp,
    console,
    print_err,
    print_ok,
    require_tty,
)
from mymodel.config.loader import (
    ModalityRoute,
    MyModelConfig,
    ProviderEntry,
    TextRoute,
    TextRouteSignals,
)
from mymodel.cli.init_wizard import DOMAIN_CATEGORIES, PROVIDER_PRESETS


# ═══════════════════════════════════════════════════════════════════════
# Add Provider
# ═══════════════════════════════════════════════════════════════════════

class AddProviderScreen(Screen):
    """Single-screen form for adding a provider."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def compose(self) -> ComposeResult:
        yield Static(
            f"[bold]Add Provider[/bold]\n",
            classes="section-header",
        )

        preset_options = [(name, name) for name in PROVIDER_PRESETS.keys()]
        yield LabeledRadioSet(
            "Provider preset:",
            options=preset_options,
            radio_set_id="preset-radio",
        )

        yield LabeledInput(
            "Provider name:",
            input_id="prov-name",
            placeholder="my-provider",
        )
        yield LabeledInput(
            "Base URL:",
            input_id="prov-url",
            placeholder="https://api.example.com/v1",
        )
        yield LabeledInput(
            "API key (or ${ENV_VAR}):",
            input_id="prov-key",
            placeholder="${MY_API_KEY}",
        )

        with Horizontal(classes="nav-bar"):
            yield Button("Save", variant="primary", id="btn-save")
            yield Button("Cancel", variant="default", id="btn-cancel")

        yield Footer()

    def on_radio_set_changed(self, event: RadioSet.Changed) -> None:
        if event.radio_set.id == "preset-radio":
            self._update_fields()

    def _update_fields(self) -> None:
        radio = self.query_one("#preset-radio", RadioSet)
        idx = radio.pressed_index
        if idx < 0:
            return
        preset_name = list(PROVIDER_PRESETS.keys())[idx]
        preset = PROVIDER_PRESETS[preset_name]

        name_input = self.query_one("#prov-name", Input)
        url_input = self.query_one("#prov-url", Input)
        key_input = self.query_one("#prov-key", Input)

        if preset is None:
            name_input.value = ""
            url_input.value = ""
            key_input.value = ""
        else:
            auto_name = preset_name.lower().replace(".", "").replace(" ", "-").split("(")[0].strip("-")
            if auto_name == "local-vllm-instance":
                auto_name = "local-vllm"
            name_input.value = auto_name
            url_input.value = preset["base_url"]
            env_var = preset.get("env_var")
            key_input.value = f"${{{env_var}}}" if env_var else ""

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save":
            self._save()
        elif event.button.id == "btn-cancel":
            self.app.exit(None)

    def _save(self) -> None:
        name = self.query_one("#prov-name", Input).value.strip()
        url = self.query_one("#prov-url", Input).value.strip()
        key = self.query_one("#prov-key", Input).value.strip()

        if not name:
            self.notify("Provider name is required", severity="warning")
            return
        if not url:
            self.notify("Base URL is required", severity="warning")
            return

        radio = self.query_one("#preset-radio", RadioSet)
        idx = radio.pressed_index
        prov_type = "openai-compatible"
        if idx >= 0:
            preset_name = list(PROVIDER_PRESETS.keys())[idx]
            preset = PROVIDER_PRESETS[preset_name]
            if preset:
                prov_type = preset.get("type", "openai-compatible")

        self.app.exit({
            "name": name,
            "type": prov_type,
            "base_url": url,
            "api_key": key,
        })

    def action_cancel(self) -> None:
        self.app.exit(None)


class AddProviderApp(MyModelApp):
    CSS_PATH = "styles/wizard.tcss"

    def on_mount(self) -> None:
        self.push_screen(AddProviderScreen())


# ═══════════════════════════════════════════════════════════════════════
# Add Route
# ═══════════════════════════════════════════════════════════════════════

class AddRouteScreen(Screen):
    """Single-screen form for adding a text route."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, provider_names: list[str], providers_data: dict, **kwargs):
        super().__init__(**kwargs)
        self._provider_names = provider_names
        self._providers_data = providers_data

    def compose(self) -> ComposeResult:
        yield Static(
            f"[bold]Add Text Route[/bold]\n",
            classes="section-header",
        )

        yield LabeledInput(
            "Route name:",
            input_id="route-name",
            placeholder="code-route",
        )

        provider_options = [(p, p) for p in self._provider_names]
        yield LabeledRadioSet(
            "Provider:",
            options=provider_options,
            radio_set_id="route-provider",
        )

        yield LabeledInput(
            "Model:",
            input_id="route-model",
            placeholder="gpt-4o",
        )
        yield Button("Pick Model...", variant="default", id="btn-pick-model")

        yield LabeledInput(
            "Priority (0-100):",
            input_id="route-priority",
            placeholder="50",
            value="50",
        )

        yield LabeledInput(
            "Keywords (comma-separated):",
            input_id="route-keywords",
            placeholder="code, debug, programming",
        )

        yield LabeledSelectionList(
            "Domain triggers:",
            items=[(d, d) for d in DOMAIN_CATEGORIES],
            selection_list_id="route-domains",
        )

        operator_options = [
            ("OR  — any signal matches", "OR"),
            ("AND — all signals must match", "AND"),
        ]
        yield LabeledRadioSet(
            "Signal operator:",
            options=operator_options,
            radio_set_id="route-operator",
        )

        with Horizontal(classes="nav-bar"):
            yield Button("Save", variant="primary", id="btn-save")
            yield Button("Cancel", variant="default", id="btn-cancel")

        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save":
            self._save()
        elif event.button.id == "btn-cancel":
            self.app.exit(None)
        elif event.button.id == "btn-pick-model":
            self._pick_model()

    def _pick_model(self) -> None:
        radio = self.query_one("#route-provider", RadioSet)
        idx = radio.pressed_index
        if idx < 0 or idx >= len(self._provider_names):
            self.notify("Select a provider first", severity="warning")
            return

        provider = self._provider_names[idx]
        prov_data = self._providers_data[provider]

        def on_picked(model: Optional[str]) -> None:
            if model:
                self.query_one("#route-model", Input).value = model

        self.app.push_screen(
            ModelPickerDialog(
                provider_name=provider,
                base_url=prov_data["base_url"],
                api_key=prov_data.get("api_key", ""),
                provider_type=prov_data.get("type", "openai-compatible"),
            ),
            callback=on_picked,
        )

    def _save(self) -> None:
        name = self.query_one("#route-name", Input).value.strip()
        model = self.query_one("#route-model", Input).value.strip()

        radio = self.query_one("#route-provider", RadioSet)
        idx = radio.pressed_index
        if idx < 0 or idx >= len(self._provider_names):
            self.notify("Select a provider", severity="warning")
            return
        provider = self._provider_names[idx]

        if not name:
            self.notify("Route name is required", severity="warning")
            return
        if not model:
            self.notify("Model is required", severity="warning")
            return

        priority_str = self.query_one("#route-priority", Input).value.strip()
        try:
            priority = int(priority_str) if priority_str else 50
        except ValueError:
            priority = 50

        kw_input = self.query_one("#route-keywords", Input).value.strip()
        keywords = [k.strip() for k in kw_input.split(",") if k.strip()] if kw_input else []

        domains_widget = self.query_one("#route-domains", SelectionList)
        domains = list(domains_widget.selected)

        op_radio = self.query_one("#route-operator", RadioSet)
        op_idx = op_radio.pressed_index
        operator = "AND" if op_idx == 1 else "OR"

        self.app.exit({
            "name": name,
            "provider": provider,
            "model": model,
            "priority": priority,
            "keywords": keywords,
            "domains": domains,
            "operator": operator,
        })

    def action_cancel(self) -> None:
        self.app.exit(None)


class AddRouteApp(MyModelApp):
    CSS_PATH = "styles/wizard.tcss"

    def __init__(self, provider_names: list[str], providers_data: dict, **kwargs):
        super().__init__(**kwargs)
        self._provider_names = provider_names
        self._providers_data = providers_data

    def on_mount(self) -> None:
        self.push_screen(AddRouteScreen(self._provider_names, self._providers_data))


# ═══════════════════════════════════════════════════════════════════════
# Add Modality
# ═══════════════════════════════════════════════════════════════════════

class AddModalityScreen(Screen):
    """Single-screen form for adding a modality route."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, provider_names: list[str], providers_data: dict, **kwargs):
        super().__init__(**kwargs)
        self._provider_names = provider_names
        self._providers_data = providers_data

    def compose(self) -> ComposeResult:
        yield Static(
            f"[bold]Add Modality Route[/bold]\n",
            classes="section-header",
        )

        modality_options = [
            ("Audio", "audio"),
            ("Image", "image"),
            ("Multimodal", "multimodal"),
            ("Video", "video"),
        ]
        yield LabeledRadioSet(
            "Modality:",
            options=modality_options,
            radio_set_id="modality-type",
        )

        provider_options = [(p, p) for p in self._provider_names]
        yield LabeledRadioSet(
            "Provider:",
            options=provider_options,
            radio_set_id="mod-provider",
        )

        yield LabeledInput(
            "Model:",
            input_id="mod-model",
            placeholder="gpt-4o",
        )
        yield Button("Pick Model...", variant="default", id="btn-pick-model")

        with Horizontal(classes="nav-bar"):
            yield Button("Save", variant="primary", id="btn-save")
            yield Button("Cancel", variant="default", id="btn-cancel")

        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save":
            self._save()
        elif event.button.id == "btn-cancel":
            self.app.exit(None)
        elif event.button.id == "btn-pick-model":
            self._pick_model()

    def _pick_model(self) -> None:
        radio = self.query_one("#mod-provider", RadioSet)
        idx = radio.pressed_index
        if idx < 0 or idx >= len(self._provider_names):
            self.notify("Select a provider first", severity="warning")
            return

        provider = self._provider_names[idx]
        prov_data = self._providers_data[provider]

        def on_picked(model: Optional[str]) -> None:
            if model:
                self.query_one("#mod-model", Input).value = model

        self.app.push_screen(
            ModelPickerDialog(
                provider_name=provider,
                base_url=prov_data["base_url"],
                api_key=prov_data.get("api_key", ""),
                provider_type=prov_data.get("type", "openai-compatible"),
            ),
            callback=on_picked,
        )

    def _save(self) -> None:
        # Modality
        mod_radio = self.query_one("#modality-type", RadioSet)
        mod_idx = mod_radio.pressed_index
        modality_map = ["audio", "image", "multimodal", "video"]
        if mod_idx < 0 or mod_idx >= len(modality_map):
            self.notify("Select a modality", severity="warning")
            return
        modality = modality_map[mod_idx]

        # Provider
        prov_radio = self.query_one("#mod-provider", RadioSet)
        prov_idx = prov_radio.pressed_index
        if prov_idx < 0 or prov_idx >= len(self._provider_names):
            self.notify("Select a provider", severity="warning")
            return
        provider = self._provider_names[prov_idx]

        model = self.query_one("#mod-model", Input).value.strip()
        if not model:
            self.notify("Model is required", severity="warning")
            return

        self.app.exit({
            "modality": modality,
            "provider": provider,
            "model": model,
        })

    def action_cancel(self) -> None:
        self.app.exit(None)


class AddModalityApp(MyModelApp):
    CSS_PATH = "styles/wizard.tcss"

    def __init__(self, provider_names: list[str], providers_data: dict, **kwargs):
        super().__init__(**kwargs)
        self._provider_names = provider_names
        self._providers_data = providers_data

    def on_mount(self) -> None:
        self.push_screen(AddModalityScreen(self._provider_names, self._providers_data))


# ═══════════════════════════════════════════════════════════════════════
# Entry Points (called by Click commands in main.py)
# ═══════════════════════════════════════════════════════════════════════

def add_provider_interactive(config_path: str):
    """Interactively add a provider to an existing config."""
    require_tty()

    try:
        config = MyModelConfig.load(config_path)
    except FileNotFoundError:
        print_err(f"Config file not found: {config_path}")
        console.print("  Run [bold]mymodel init[/bold] first.")
        return
    except Exception as e:
        print_err(f"Error loading config: {e}")
        return

    app = AddProviderApp()
    result = app.run()

    if result is None:
        console.print("  Cancelled.")
        return

    config.providers[result["name"]] = ProviderEntry(
        type=result["type"],
        base_url=result["base_url"],
        api_key=result.get("api_key", ""),
    )
    config.save(config_path)
    print_ok(f"Provider [bold]'{result['name']}'[/bold] added to {config_path}")


def add_route_interactive(config_path: str):
    """Interactively add a text route to an existing config."""
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
        print_err("No providers configured. Run [bold]mymodel add provider[/bold] first.")
        return

    # Build providers_data dict for model picker
    providers_data = {}
    for name, prov in config.providers.items():
        providers_data[name] = {
            "type": prov.type,
            "base_url": prov.base_url,
            "api_key": prov.api_key,
        }

    app = AddRouteApp(provider_names, providers_data)
    result = app.run()

    if result is None:
        console.print("  Cancelled.")
        return

    config.text_routes.append(TextRoute(
        name=result["name"],
        priority=result["priority"],
        signals=TextRouteSignals(
            keywords=result.get("keywords", []),
            domains=result.get("domains", []),
        ),
        operator=result.get("operator", "OR"),
        provider=result["provider"],
        model=result["model"],
    ))
    config.save(config_path)
    print_ok(
        f"Route [bold]'{result['name']}'[/bold] → "
        f"{result['provider']}/{result['model']} (priority {result['priority']})"
    )
    console.print(f"    Added to {config_path}")


def add_modality_interactive(config_path: str):
    """Interactively add a modality route."""
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
        print_err("No providers configured. Run [bold]mymodel add provider[/bold] first.")
        return

    providers_data = {}
    for name, prov in config.providers.items():
        providers_data[name] = {
            "type": prov.type,
            "base_url": prov.base_url,
            "api_key": prov.api_key,
        }

    app = AddModalityApp(provider_names, providers_data)
    result = app.run()

    if result is None:
        console.print("  Cancelled.")
        return

    config.modality_routes[result["modality"]] = ModalityRoute(
        provider=result["provider"],
        model=result["model"],
    )
    config.save(config_path)
    print_ok(f"{result['modality'].title()} → {result['provider']}/{result['model']}")
    console.print(f"    Added to {config_path}")
