"""Interactive wizard for `mymodel init` — creates config.yaml from scratch.

Uses a multi-screen Textual app (WizardApp) with 7 screens:
  Welcome → Model Identity → Providers → Text Routes → Modality → Plugins → Summary
"""

from pathlib import Path
from typing import Optional

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import (
    Button,
    Collapsible,
    DataTable,
    Footer,
    Input,
    Label,
    RadioButton,
    RadioSet,
    Select,
    SelectionList,
    Static,
    Switch,
)

from mymodel.cli.ui import (
    ACCENT,
    ConfirmDialog,
    LabeledInput,
    LabeledRadioSet,
    LabeledSelectionList,
    ModelPickerDialog,
    MyModelApp,
    WizardScreen,
    console,
    print_ok,
    require_tty,
)
from mymodel.config.loader import (
    ModalityRoute,
    ModelIdentity,
    MyModelConfig,
    PluginConfig,
    ProviderEntry,
    ServerConfig,
    TextRoute,
    TextRouteSignals,
)

# ── Constants ────────────────────────────────────────────────────────

DOMAIN_CATEGORIES = [
    "computer_science", "mathematics", "physics", "biology", "chemistry",
    "business", "economics", "philosophy", "law", "history",
    "psychology", "health", "engineering", "other",
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

TOTAL_STEPS = 7


# ═══════════════════════════════════════════════════════════════════════
# Screen 1: Welcome
# ═══════════════════════════════════════════════════════════════════════

class WelcomeScreen(WizardScreen):
    step = 1
    total_steps = TOTAL_STEPS
    step_title = "Welcome"

    def compose_body(self) -> ComposeResult:
        yield Static(
            "\n\n  MyModel Setup Wizard\n",
            classes="welcome-banner",
        )
        yield Static(
            "Create your personal AI model by combining multiple LLM providers.\n\n"
            "This wizard will guide you through:\n"
            "  ● Model identity (name & description)\n"
            "  ● Backend providers (Regolo, OpenAI, Anthropic, ...)\n"
            "  ● Text routing rules (keywords, domains, priorities)\n"
            "  ● Multimodal routing (audio, image, video)\n"
            "  ● Security plugins (PII, jailbreak, cache)\n\n"
            "Press [bold]Next[/bold] to begin, or [bold]Escape[/bold] to quit.",
            classes="welcome-subtitle",
        )

    def go_next(self) -> None:
        self.app.push_screen(ModelIdentityScreen())


# ═══════════════════════════════════════════════════════════════════════
# Screen 2: Model Identity
# ═══════════════════════════════════════════════════════════════════════

class ModelIdentityScreen(WizardScreen):
    step = 2
    total_steps = TOTAL_STEPS
    step_title = "Model Identity"

    def compose_body(self) -> ComposeResult:
        data = self.app.wizard_data
        yield Static("What should your virtual model be called?\n", classes="section-desc")
        yield LabeledInput(
            "Model name:",
            input_id="model-name",
            placeholder="MyModel",
            value=data.get("model_name", "MyModel"),
        )
        yield LabeledInput(
            "Description (optional):",
            input_id="model-desc",
            placeholder="A personal AI model combining multiple LLMs",
            value=data.get("model_desc", ""),
        )

    def save_data(self) -> None:
        self.app.wizard_data["model_name"] = (
            self.query_one("#model-name", Input).value or "MyModel"
        )
        self.app.wizard_data["model_desc"] = (
            self.query_one("#model-desc", Input).value
        )

    def go_next(self) -> None:
        self.app.push_screen(ProvidersScreen())


# ═══════════════════════════════════════════════════════════════════════
# Screen 3: Providers
# ═══════════════════════════════════════════════════════════════════════

class ProvidersScreen(WizardScreen):
    step = 3
    total_steps = TOTAL_STEPS
    step_title = "Backend Providers"

    def compose_body(self) -> ComposeResult:
        yield Static(
            "Add one or more LLM providers. These are the backends your model routes to.\n",
            classes="section-desc",
        )

        # Table of already-added providers
        yield Static("Added providers:", classes="section-header")
        table = DataTable(id="providers-table")
        table.add_columns("Name", "Type", "Base URL")
        yield table

        yield Static("")  # spacer

        # Add provider form
        yield Static("Add a provider:", classes="section-header")
        preset_options = [(name, name) for name in PROVIDER_PRESETS.keys()]
        yield LabeledRadioSet(
            "Provider preset:",
            options=preset_options,
            radio_set_id="preset-radio",
        )

        # Custom fields (shown for all — user fills what's needed)
        yield LabeledInput(
            "Provider name (for custom):",
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

        with Horizontal():
            yield Button("Add Provider", variant="primary", id="btn-add-provider")
            yield Button("Remove Last", variant="warning", id="btn-remove-provider")

    def on_mount(self) -> None:
        self._refresh_table()
        self._update_fields_for_preset()

    def _refresh_table(self) -> None:
        providers = self.app.wizard_data.get("providers", {})
        table = self.query_one("#providers-table", DataTable)
        table.clear()
        for name, prov in providers.items():
            table.add_row(name, prov["type"], prov["base_url"])

    def on_radio_set_changed(self, event: RadioSet.Changed) -> None:
        if event.radio_set.id == "preset-radio":
            self._update_fields_for_preset()

    def _update_fields_for_preset(self) -> None:
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
            # Custom endpoint
            name_input.value = ""
            url_input.value = ""
            key_input.value = ""
            name_input.placeholder = "my-provider"
        else:
            # Auto-fill from preset
            auto_name = preset_name.lower().replace(".", "").replace(" ", "-").split("(")[0].strip("-")
            if auto_name == "local-vllm-instance":
                auto_name = "local-vllm"
            name_input.value = auto_name
            url_input.value = preset["base_url"]
            env_var = preset.get("env_var")
            key_input.value = f"${{{env_var}}}" if env_var else ""

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-add-provider":
            self._add_provider()
        elif event.button.id == "btn-remove-provider":
            self._remove_last_provider()
        else:
            super().on_button_pressed(event)

    def _add_provider(self) -> None:
        name = self.query_one("#prov-name", Input).value.strip()
        url = self.query_one("#prov-url", Input).value.strip()
        key = self.query_one("#prov-key", Input).value.strip()

        if not name:
            self.notify("Provider name is required", severity="warning")
            return
        if not url:
            self.notify("Base URL is required", severity="warning")
            return

        # Determine type from preset
        radio = self.query_one("#preset-radio", RadioSet)
        idx = radio.pressed_index
        prov_type = "openai-compatible"
        if idx >= 0:
            preset_name = list(PROVIDER_PRESETS.keys())[idx]
            preset = PROVIDER_PRESETS[preset_name]
            if preset:
                prov_type = preset.get("type", "openai-compatible")

        providers = self.app.wizard_data.setdefault("providers", {})
        providers[name] = {
            "type": prov_type,
            "base_url": url,
            "api_key": key,
        }

        # Track env vars
        if key.startswith("${") and key.endswith("}"):
            env_vars = self.app.wizard_data.setdefault("env_vars", {})
            env_vars[key[2:-1]] = ""

        self.notify(f"Provider '{name}' added", severity="information")
        self._refresh_table()

        # Clear form for next entry
        self.query_one("#prov-name", Input).value = ""
        self.query_one("#prov-url", Input).value = ""
        self.query_one("#prov-key", Input).value = ""

    def _remove_last_provider(self) -> None:
        providers = self.app.wizard_data.get("providers", {})
        if providers:
            last_key = list(providers.keys())[-1]
            del providers[last_key]
            self.notify(f"Provider '{last_key}' removed", severity="information")
            self._refresh_table()

    def save_data(self) -> None:
        pass  # providers are already in wizard_data

    def go_next(self) -> None:
        providers = self.app.wizard_data.get("providers", {})
        if not providers:
            self.notify("Add at least one provider before continuing", severity="error")
            return
        self.app.push_screen(TextRoutesScreen())


# ═══════════════════════════════════════════════════════════════════════
# Screen 4: Text Routes
# ═══════════════════════════════════════════════════════════════════════

class TextRoutesScreen(WizardScreen):
    step = 4
    total_steps = TOTAL_STEPS
    step_title = "Text Routing"

    def compose_body(self) -> ComposeResult:
        yield Static(
            "Define how text queries get routed to different models.\n"
            "Add routing rules based on keywords, domains, and priorities.\n",
            classes="section-desc",
        )

        # Existing routes table
        yield Static("Configured routes:", classes="section-header")
        table = DataTable(id="routes-table")
        table.add_columns("Name", "Provider", "Model", "Priority", "Signals")
        yield table

        yield Static("")

        # Add route form
        yield Static("Add a text route:", classes="section-header")
        yield LabeledInput(
            "Route name:",
            input_id="route-name",
            placeholder="code-route",
        )

        # Provider selection
        provider_names = list(self.app.wizard_data.get("providers", {}).keys())
        provider_options = [(p, p) for p in provider_names]
        yield LabeledRadioSet(
            "Provider:",
            options=provider_options,
            radio_set_id="route-provider",
        )

        yield LabeledInput(
            "Model (or use model picker button):",
            input_id="route-model",
            placeholder="gpt-4o",
        )
        yield Button("Pick Model...", variant="default", id="btn-pick-model")

        yield LabeledInput(
            "Priority (0=lowest, 100=highest):",
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
            "Domain triggers (select with space):",
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

        with Horizontal():
            yield Button("Add Route", variant="primary", id="btn-add-route")
            yield Button("Remove Last", variant="warning", id="btn-remove-route")

        yield Static("")
        yield Static("Default route (when no signals match):", classes="section-header")

        yield LabeledRadioSet(
            "Default provider:",
            options=provider_options,
            radio_set_id="default-provider",
        )
        yield LabeledInput(
            "Default model:",
            input_id="default-model",
            placeholder="gpt-4o-mini",
        )
        yield Button("Pick Default Model...", variant="default", id="btn-pick-default-model")

    def on_mount(self) -> None:
        self._refresh_table()
        # Restore default model if previously set
        data = self.app.wizard_data
        if data.get("default_model"):
            self.query_one("#default-model", Input).value = data["default_model"]

    def _refresh_table(self) -> None:
        routes = self.app.wizard_data.get("text_routes", [])
        table = self.query_one("#routes-table", DataTable)
        table.clear()
        for r in routes:
            signals = []
            kw = r.get("keywords", [])
            dm = r.get("domains", [])
            if kw:
                signals.append(f"kw: {', '.join(kw[:3])}")
            if dm:
                signals.append(f"dom: {', '.join(dm[:3])}")
            table.add_row(
                r["name"],
                r["provider"],
                r["model"],
                str(r["priority"]),
                "; ".join(signals) if signals else "—",
            )

    def _get_selected_provider(self, radio_id: str) -> Optional[str]:
        radio = self.query_one(f"#{radio_id}", RadioSet)
        idx = radio.pressed_index
        provider_names = list(self.app.wizard_data.get("providers", {}).keys())
        if 0 <= idx < len(provider_names):
            return provider_names[idx]
        return None

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-add-route":
            self._add_route()
        elif event.button.id == "btn-remove-route":
            self._remove_last_route()
        elif event.button.id == "btn-pick-model":
            self._pick_model("route-model", "route-provider")
        elif event.button.id == "btn-pick-default-model":
            self._pick_model("default-model", "default-provider")
        else:
            super().on_button_pressed(event)

    def _pick_model(self, model_input_id: str, provider_radio_id: str) -> None:
        provider = self._get_selected_provider(provider_radio_id)
        if not provider:
            self.notify("Select a provider first", severity="warning")
            return
        prov_data = self.app.wizard_data["providers"][provider]

        def on_model_picked(model: Optional[str]) -> None:
            if model:
                self.query_one(f"#{model_input_id}", Input).value = model

        self.app.push_screen(
            ModelPickerDialog(
                provider_name=provider,
                base_url=prov_data["base_url"],
                api_key=prov_data.get("api_key", ""),
                provider_type=prov_data.get("type", "openai-compatible"),
            ),
            callback=on_model_picked,
        )

    def _add_route(self) -> None:
        name = self.query_one("#route-name", Input).value.strip()
        model = self.query_one("#route-model", Input).value.strip()
        provider = self._get_selected_provider("route-provider")

        if not name:
            self.notify("Route name is required", severity="warning")
            return
        if not provider:
            self.notify("Select a provider", severity="warning")
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

        # Operator
        op_radio = self.query_one("#route-operator", RadioSet)
        op_idx = op_radio.pressed_index
        operator = "OR"
        if op_idx == 1:
            operator = "AND"

        routes = self.app.wizard_data.setdefault("text_routes", [])
        routes.append({
            "name": name,
            "provider": provider,
            "model": model,
            "priority": priority,
            "keywords": keywords,
            "domains": domains,
            "operator": operator,
        })

        self.notify(f"Route '{name}' added", severity="information")
        self._refresh_table()

        # Clear form
        self.query_one("#route-name", Input).value = ""
        self.query_one("#route-model", Input).value = ""
        self.query_one("#route-priority", Input).value = "50"
        self.query_one("#route-keywords", Input).value = ""

    def _remove_last_route(self) -> None:
        routes = self.app.wizard_data.get("text_routes", [])
        if routes:
            removed = routes.pop()
            self.notify(f"Route '{removed['name']}' removed", severity="information")
            self._refresh_table()

    def save_data(self) -> None:
        # Save default route
        provider = self._get_selected_provider("default-provider")
        model = self.query_one("#default-model", Input).value.strip()
        self.app.wizard_data["default_provider"] = provider
        self.app.wizard_data["default_model"] = model

    def go_next(self) -> None:
        if not self.app.wizard_data.get("default_provider"):
            self.notify("Select a default provider", severity="error")
            return
        if not self.app.wizard_data.get("default_model"):
            self.notify("Enter a default model", severity="error")
            return
        self.app.push_screen(ModalityScreen())


# ═══════════════════════════════════════════════════════════════════════
# Screen 5: Modality Routes
# ═══════════════════════════════════════════════════════════════════════

class ModalityScreen(WizardScreen):
    step = 5
    total_steps = TOTAL_STEPS
    step_title = "Multimodal Routing"

    def compose_body(self) -> ComposeResult:
        yield Static(
            "Configure routing for non-text modalities (optional).\n"
            "Toggle on to enable, then select provider and model.\n",
            classes="section-desc",
        )

        provider_names = list(self.app.wizard_data.get("providers", {}).keys())
        provider_options = [(p, p) for p in provider_names]

        for modality in ["audio", "image", "multimodal"]:
            with Vertical(classes="form-group"):
                with Horizontal(classes="switch-row"):
                    yield Label(f"{modality.title()} routing")
                    yield Switch(value=False, id=f"sw-{modality}")
                with Collapsible(
                    title=f"{modality.title()} settings",
                    collapsed=True,
                    id=f"coll-{modality}",
                ):
                    yield LabeledRadioSet(
                        f"{modality.title()} provider:",
                        options=provider_options,
                        radio_set_id=f"mod-prov-{modality}",
                    )
                    yield LabeledInput(
                        f"{modality.title()} model:",
                        input_id=f"mod-model-{modality}",
                        placeholder=f"model-for-{modality}",
                    )
                    yield Button(
                        f"Pick {modality.title()} Model...",
                        variant="default",
                        id=f"btn-pick-mod-{modality}",
                    )

    def on_switch_changed(self, event: Switch.Changed) -> None:
        switch_id = event.switch.id
        if switch_id and switch_id.startswith("sw-"):
            modality = switch_id[3:]
            coll = self.query_one(f"#coll-{modality}", Collapsible)
            coll.collapsed = not event.value

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn_id = event.button.id or ""
        if btn_id.startswith("btn-pick-mod-"):
            modality = btn_id[len("btn-pick-mod-"):]
            self._pick_modality_model(modality)
        else:
            super().on_button_pressed(event)

    def _pick_modality_model(self, modality: str) -> None:
        provider_names = list(self.app.wizard_data.get("providers", {}).keys())
        radio = self.query_one(f"#mod-prov-{modality}", RadioSet)
        idx = radio.pressed_index
        if idx < 0 or idx >= len(provider_names):
            self.notify("Select a provider first", severity="warning")
            return

        provider = provider_names[idx]
        prov_data = self.app.wizard_data["providers"][provider]

        def on_picked(model: Optional[str]) -> None:
            if model:
                self.query_one(f"#mod-model-{modality}", Input).value = model

        self.app.push_screen(
            ModelPickerDialog(
                provider_name=provider,
                base_url=prov_data["base_url"],
                api_key=prov_data.get("api_key", ""),
                provider_type=prov_data.get("type", "openai-compatible"),
            ),
            callback=on_picked,
        )

    def save_data(self) -> None:
        provider_names = list(self.app.wizard_data.get("providers", {}).keys())
        modality_routes = {}

        for modality in ["audio", "image", "multimodal"]:
            sw = self.query_one(f"#sw-{modality}", Switch)
            if sw.value:
                radio = self.query_one(f"#mod-prov-{modality}", RadioSet)
                idx = radio.pressed_index
                model = self.query_one(f"#mod-model-{modality}", Input).value.strip()
                if 0 <= idx < len(provider_names) and model:
                    modality_routes[modality] = {
                        "provider": provider_names[idx],
                        "model": model,
                    }

        self.app.wizard_data["modality_routes"] = modality_routes

    def go_next(self) -> None:
        self.app.push_screen(PluginsScreen())


# ═══════════════════════════════════════════════════════════════════════
# Screen 6: Plugins
# ═══════════════════════════════════════════════════════════════════════

class PluginsScreen(WizardScreen):
    step = 6
    total_steps = TOTAL_STEPS
    step_title = "Security & Plugins"

    def compose_body(self) -> ComposeResult:
        yield Static(
            "Configure security and performance plugins (optional).\n",
            classes="section-desc",
        )

        # PII Detection
        with Vertical(classes="form-group"):
            with Horizontal(classes="switch-row"):
                yield Label("PII Detection")
                yield Switch(value=False, id="sw-pii")
            with Collapsible(
                title="PII Detection settings",
                collapsed=True,
                id="coll-pii",
            ):
                yield LabeledRadioSet(
                    "Action when PII detected:",
                    options=[
                        ("redact — remove PII from query", "redact"),
                        ("mask — replace with ***", "mask"),
                        ("block — reject request", "block"),
                    ],
                    radio_set_id="pii-action",
                )

        # Jailbreak Guard
        with Vertical(classes="form-group"):
            with Horizontal(classes="switch-row"):
                yield Label("Jailbreak Guard")
                yield Switch(value=False, id="sw-jailbreak")

        # Semantic Cache
        with Vertical(classes="form-group"):
            with Horizontal(classes="switch-row"):
                yield Label("Semantic Cache")
                yield Switch(value=False, id="sw-cache")

    def on_switch_changed(self, event: Switch.Changed) -> None:
        if event.switch.id == "sw-pii":
            self.query_one("#coll-pii", Collapsible).collapsed = not event.value

    def save_data(self) -> None:
        plugins = {}

        # PII
        pii_enabled = self.query_one("#sw-pii", Switch).value
        pii_action = "redact"
        if pii_enabled:
            radio = self.query_one("#pii-action", RadioSet)
            idx = radio.pressed_index
            action_map = ["redact", "mask", "block"]
            if 0 <= idx < len(action_map):
                pii_action = action_map[idx]
        plugins["pii_detection"] = {"enabled": pii_enabled, "action": pii_action}

        # Jailbreak
        jb_enabled = self.query_one("#sw-jailbreak", Switch).value
        plugins["jailbreak_guard"] = {"enabled": jb_enabled, "action": "block"}

        # Cache
        cache_enabled = self.query_one("#sw-cache", Switch).value
        plugins["semantic_cache"] = {"enabled": cache_enabled, "action": ""}

        self.app.wizard_data["plugins"] = plugins

    def go_next(self) -> None:
        self.app.push_screen(SummaryScreen())


# ═══════════════════════════════════════════════════════════════════════
# Screen 7: Summary
# ═══════════════════════════════════════════════════════════════════════

class SummaryScreen(WizardScreen):
    step = 7
    total_steps = TOTAL_STEPS
    step_title = "Review & Save"

    BINDINGS = [
        Binding("escape", "go_back", "Back"),
    ]

    def compose_body(self) -> ComposeResult:
        yield Static("Review your configuration:\n", classes="section-desc")

        data = self.app.wizard_data

        # Model Identity
        with Vertical(classes="summary-section"):
            yield Static("Model Identity", classes="section-header")
            yield Static(f"  Name:        {data.get('model_name', 'MyModel')}")
            yield Static(f"  Description: {data.get('model_desc', '') or '(none)'}")

        # Providers
        with Vertical(classes="summary-section"):
            yield Static("Providers", classes="section-header")
            providers_table = DataTable(id="summary-providers")
            providers_table.add_columns("Name", "Type", "Base URL")
            yield providers_table

        # Text Routes
        with Vertical(classes="summary-section"):
            yield Static("Text Routes", classes="section-header")
            routes_table = DataTable(id="summary-routes")
            routes_table.add_columns("Priority", "Name", "Target", "Signals")
            yield routes_table

        # Default Route
        with Vertical(classes="summary-section"):
            yield Static("Default Route", classes="section-header")
            dp = data.get("default_provider", "")
            dm = data.get("default_model", "")
            yield Static(f"  {dp}/{dm}")

        # Modality Routes
        mod_routes = data.get("modality_routes", {})
        if mod_routes:
            with Vertical(classes="summary-section"):
                yield Static("Modality Routes", classes="section-header")
                for mod, info in mod_routes.items():
                    yield Static(f"  {mod.title()} → {info['provider']}/{info['model']}")

        # Plugins
        with Vertical(classes="summary-section"):
            yield Static("Plugins", classes="section-header")
            plugins = data.get("plugins", {})
            for name, conf in plugins.items():
                display = name.replace("_", " ").title()
                status = "ON" if conf.get("enabled") else "OFF"
                action = f" ({conf.get('action')})" if conf.get("enabled") and conf.get("action") else ""
                marker = "●" if conf.get("enabled") else "○"
                yield Static(f"  {marker} {display}: {status}{action}")

    def compose_nav(self) -> ComposeResult:
        yield Button("← Back", variant="default", id="btn-back")
        yield Button("Save Configuration", variant="primary", id="btn-save")
        yield Button("Cancel", variant="error", id="btn-cancel")

    def on_mount(self) -> None:
        data = self.app.wizard_data

        # Populate providers table
        providers = data.get("providers", {})
        table = self.query_one("#summary-providers", DataTable)
        table.clear()
        for name, prov in providers.items():
            table.add_row(name, prov["type"], prov["base_url"])

        # Populate routes table
        routes = data.get("text_routes", [])
        rtable = self.query_one("#summary-routes", DataTable)
        rtable.clear()
        for r in sorted(routes, key=lambda x: x["priority"], reverse=True):
            signals = []
            kw = r.get("keywords", [])
            dm = r.get("domains", [])
            if kw:
                signals.append(f"kw: {', '.join(kw[:3])}")
            if dm:
                signals.append(f"dom: {', '.join(dm[:3])}")
            rtable.add_row(
                str(r["priority"]),
                r["name"],
                f"{r['provider']}/{r['model']}",
                "; ".join(signals) if signals else "—",
            )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save":
            self.app.wizard_data["_save"] = True
            self.app.exit()
        elif event.button.id == "btn-cancel":
            self.app.wizard_data["_save"] = False
            self.app.exit()
        elif event.button.id == "btn-back":
            self.action_go_back()

    def save_data(self) -> None:
        pass

    def go_next(self) -> None:
        pass


# ═══════════════════════════════════════════════════════════════════════
# WizardApp
# ═══════════════════════════════════════════════════════════════════════

class WizardApp(MyModelApp):
    """Multi-screen setup wizard for `mymodel init`."""

    CSS_PATH = "styles/wizard.tcss"

    BINDINGS = [
        Binding("q", "quit", "Quit", show=True),
    ]

    def __init__(self, output_path: str, **kwargs):
        super().__init__(**kwargs)
        self.output_path = output_path
        self.wizard_data: dict = {
            "providers": {},
            "text_routes": [],
            "modality_routes": {},
            "plugins": {},
            "env_vars": {},
        }

    def on_mount(self) -> None:
        self.push_screen(WelcomeScreen())


# ═══════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════

def _build_config(data: dict) -> MyModelConfig:
    """Build a MyModelConfig from wizard_data dict."""
    providers = {}
    for name, prov in data.get("providers", {}).items():
        providers[name] = ProviderEntry(
            type=prov["type"],
            base_url=prov["base_url"],
            api_key=prov.get("api_key", ""),
        )

    text_routes = []
    for r in data.get("text_routes", []):
        text_routes.append(TextRoute(
            name=r["name"],
            priority=r["priority"],
            signals=TextRouteSignals(
                keywords=r.get("keywords", []),
                domains=r.get("domains", []),
            ),
            operator=r.get("operator", "OR"),
            provider=r["provider"],
            model=r["model"],
        ))

    # Add default route
    if data.get("default_provider") and data.get("default_model"):
        text_routes.append(TextRoute(
            name="default",
            priority=0,
            signals=TextRouteSignals(),
            operator="OR",
            provider=data["default_provider"],
            model=data["default_model"],
        ))

    modality_routes = {}
    for mod, info in data.get("modality_routes", {}).items():
        modality_routes[mod] = ModalityRoute(
            provider=info["provider"],
            model=info["model"],
        )

    plugins = {}
    for name, conf in data.get("plugins", {}).items():
        plugins[name] = PluginConfig(
            enabled=conf.get("enabled", False),
            action=conf.get("action", ""),
        )

    return MyModelConfig(
        model=ModelIdentity(
            name=data.get("model_name", "MyModel"),
            description=data.get("model_desc", ""),
        ),
        providers=providers,
        modality_routes=modality_routes,
        text_routes=text_routes,
        server=ServerConfig(port=8000),
        plugins=plugins,
    )


def run_wizard(output_path: str):
    """Run the interactive setup wizard."""
    require_tty()

    app = WizardApp(output_path=output_path)
    app.run()

    data = app.wizard_data

    if not data.get("_save"):
        console.print("\n  Wizard cancelled.")
        return

    config = _build_config(data)

    # Validate
    errors = config.validate_providers_in_routes()
    if errors:
        for err in errors:
            from mymodel.cli.ui import print_warn
            print_warn(err)
    else:
        print_ok("Configuration validated")

    print_summary(config)

    # Save
    config.save(output_path)
    print_ok(f"Config saved to [bold]{output_path}[/bold]")

    env_vars = data.get("env_vars", {})
    if env_vars:
        env_path = Path(output_path).parent / ".env.example"
        with open(env_path, "w") as f:
            for var in env_vars:
                f.write(f"{var}=your-key-here\n")
        print_ok(f".env template saved to [bold]{env_path}[/bold]")

    console.print(f"\n  To start your model:")
    console.print(f"    [bold {ACCENT}]mymodel serve[/bold {ACCENT}]")
    console.print(f"\n  To test routing:")
    console.print(f'    [bold {ACCENT}]mymodel route "your query here"[/bold {ACCENT}]')


def print_summary(config: MyModelConfig):
    """Print a Rich-formatted summary of the configuration."""
    console.print(f"\n[bold {ACCENT}]Configuration Summary[/bold {ACCENT}]")
    console.print(f"[{ACCENT}]{'─' * 30}[/{ACCENT}]")
    console.print(f"  Model:      [bold]{config.model.name}[/bold]")
    console.print(f"  Port:       {config.server.port}")
    console.print(f"  Providers:  [{ACCENT}]{', '.join(config.providers.keys())}[/{ACCENT}]")

    console.print(f"\n  [{ACCENT}]Text Routes:[/{ACCENT}]")
    for route in sorted(config.text_routes, key=lambda r: r.priority, reverse=True):
        kw = route.signals.keywords
        dm = route.signals.domains
        details = []
        if kw:
            details.append(f"keywords: {', '.join(kw[:4])}")
        if dm:
            details.append(f"domains: {', '.join(dm[:3])}")
        detail_str = f" [dim]({'; '.join(details)})[/dim]" if details else ""
        console.print(
            f"    [{ACCENT}]◉[/{ACCENT}] P{route.priority:<3} {route.name:<15} → "
            f"{route.provider}/{route.model}{detail_str}"
        )

    if config.modality_routes:
        console.print(f"\n  [{ACCENT}]Modality Routes:[/{ACCENT}]")
        for mod, route in config.modality_routes.items():
            console.print(
                f"    [{ACCENT}]◉[/{ACCENT}] {mod.title():<12} → {route.provider}/{route.model}"
            )

    console.print(f"\n  [{ACCENT}]Plugins:[/{ACCENT}]")
    for name, conf in config.plugins.items():
        display_name = name.replace("_", " ").title()
        if conf.enabled:
            action = f" ({conf.action})" if conf.action else ""
            console.print(f"    [{ACCENT}]◉[/{ACCENT}] {display_name:<20} ON{action}")
        else:
            console.print(f"    [dim]○ {display_name:<20} OFF[/dim]")
