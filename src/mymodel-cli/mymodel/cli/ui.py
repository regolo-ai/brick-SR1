"""Shared UI layer for MyModel CLI — brand colors, Textual base classes, Rich helpers."""

import sys
import requests
from typing import List, Optional

from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table
from rich.theme import Theme as RichTheme

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen, Screen
from textual.theme import Theme
from textual.widget import Widget
from textual.widgets import (
    Button,
    Footer,
    Input,
    Label,
    LoadingIndicator,
    OptionList,
    RadioButton,
    RadioSet,
    Select,
    SelectionList,
    Static,
)
from textual import work

# ── Brand Colors ─────────────────────────────────────────────────────

ACCENT = "#00d4aa"       # bright green-aqua — main brand color
ACCENT_DIM = "#009977"   # dimmed accent for secondary elements
TEXT_LIGHT = "#e0e0e0"   # light text
TEXT_DIM = "#888888"      # dimmed text
SUCCESS = "#00d4aa"       # same as accent for checkmarks
ERROR = "#ff5555"         # red for errors
WARN = "#ffaa00"          # amber for warnings

# ── Textual Theme ────────────────────────────────────────────────────

MYMODEL_THEME = Theme(
    name="mymodel",
    primary="#00d4aa",
    secondary="#009977",
    accent="#00d4aa",
    success="#00d4aa",
    warning="#ffaa00",
    error="#ff5555",
    background="#1a1a2e",
    surface="#16213e",
    panel="#0f3460",
    foreground="#e0e0e0",
    dark=True,
)

# ── Rich Console (for one-shot output commands) ─────────────────────

mymodel_theme = RichTheme({
    "accent": f"bold {ACCENT}",
    "accent.dim": ACCENT_DIM,
    "success": f"bold {SUCCESS}",
    "error": f"bold {ERROR}",
    "warn": f"bold {WARN}",
    "info": TEXT_LIGHT,
    "dim": TEXT_DIM,
})

console = Console(theme=mymodel_theme)


# ── Rich Helpers (kept for one-shot commands) ────────────────────────

def make_progress() -> Progress:
    """Create a branded progress bar."""
    return Progress(
        SpinnerColumn(spinner_name="dots", style=ACCENT),
        TextColumn(f"[bold {ACCENT}]{{task.description}}"),
        BarColumn(
            bar_width=40,
            style="dim",
            complete_style=ACCENT,
            finished_style=f"bold {ACCENT}",
        ),
        TimeElapsedColumn(),
        console=console,
    )


def spinner(message: str):
    """Context manager for a branded spinner."""
    return console.status(
        f"[bold {ACCENT}]{message}",
        spinner="dots",
        spinner_style=ACCENT,
    )


def print_step(step: int, total: int, title: str):
    """Print a wizard step header."""
    console.print(f"\n[bold {ACCENT}]Step {step}/{total} — {title}[/bold {ACCENT}]")
    console.print(f"[{ACCENT}]{'─' * 40}[/{ACCENT}]")


def print_ok(message: str):
    """Print a success message with ◉ bullet."""
    console.print(f"  [{SUCCESS}]◉[/{SUCCESS}] {message}")


def print_err(message: str):
    """Print an error message."""
    console.print(f"  [{ERROR}]✗[/{ERROR}] {message}")


def print_warn(message: str):
    """Print a warning message."""
    console.print(f"  [{WARN}]![/{WARN}] {message}")


# ── TTY Check ────────────────────────────────────────────────────────

def require_tty():
    """Exit with an error if stdin is not a TTY (non-interactive)."""
    if not sys.stdin.isatty():
        print_err("Interactive terminal required. Cannot run in non-interactive mode.")
        sys.exit(1)


# ── Model Fetching ───────────────────────────────────────────────────

def fetch_provider_models(
    base_url: str,
    api_key: str = "",
    provider_type: str = "openai-compatible",
    timeout: float = 8.0,
) -> List[str]:
    """Fetch available models from a provider's /v1/models endpoint."""
    if api_key.startswith("${") and api_key.endswith("}"):
        import os
        var_name = api_key[2:-1]
        api_key = os.environ.get(var_name, "")

    url = base_url.rstrip("/")

    try:
        if provider_type == "anthropic":
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            }
            resp = requests.get(f"{url}/models", headers=headers, timeout=timeout)
            resp.raise_for_status()
            data = resp.json()
            models = [m.get("id", "") for m in data.get("data", [])]
            return sorted(models)
        else:
            headers = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            resp = requests.get(f"{url}/models", headers=headers, timeout=timeout)
            resp.raise_for_status()
            data = resp.json()
            models = [m.get("id", "") for m in data.get("data", [])]
            return sorted(models)
    except Exception:
        return []


# ── Rich Display Helpers ─────────────────────────────────────────────

def print_routing_result(result: dict):
    """Pretty-print a routing test result."""
    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column(style="bold")
    table.add_column()

    table.add_row("Query:", result.get("query", ""))
    table.add_row("Modality:", result.get("modality", "text"))
    table.add_row("", "")

    signals = result.get("signals", [])
    if signals:
        table.add_row("Signals:", "")
        for s in signals:
            table.add_row("", f"[{SUCCESS}]◉[/{SUCCESS}] {s}")
    else:
        table.add_row("Signals:", "[dim]none[/dim]")

    table.add_row("", "")
    table.add_row("Route:", f"[{ACCENT}]{result.get('route_name', '')}[/{ACCENT}]")
    table.add_row("Provider:", result.get("provider", ""))
    table.add_row("Model:", result.get("model", ""))
    table.add_row("Reason:", f"[dim]{result.get('reason', '')}[/dim]")

    table.add_row("", "")
    if result.get("blocked"):
        table.add_row("Status:", f"[{ERROR}]BLOCKED — {result.get('block_reason')}[/{ERROR}]")
    else:
        table.add_row("PII:", f"[{SUCCESS}]clean ◉[/{SUCCESS}]")
        table.add_row("Jailbreak:", f"[{SUCCESS}]clean ◉[/{SUCCESS}]")

    if result.get("latency_ms"):
        table.add_row("Latency:", f"[{ACCENT}]{result['latency_ms']}ms[/{ACCENT}]")

    console.print(Panel(table, title="Routing Result", border_style=ACCENT))


def print_server_banner(config: dict):
    """Print the startup banner."""
    model_name = config.get("model", {}).get("name", "MyModel")
    port = config.get("server_port", config.get("server", {}).get("port", 8000))

    console.print(Panel(
        f"[bold {ACCENT}]MyModel: {model_name}[/bold {ACCENT}]",
        style=ACCENT,
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
        if isinstance(conf, dict) and conf.get("enabled"):
            plugin_status.append(f"[{SUCCESS}]{short} ◉[/{SUCCESS}]")
        else:
            plugin_status.append(f"[dim]{short} ○[/dim]")
    if plugin_status:
        table.add_row("Plugins:", "  ".join(plugin_status))

    console.print(Panel(table, title="Configuration", border_style="dim"))

    console.print(
        f"\n  [{SUCCESS}]◉[/{SUCCESS}] Server listening on "
        f"[bold {ACCENT}]http://0.0.0.0:{port}[/bold {ACCENT}]"
    )
    console.print(f"\n  Try it:")
    console.print(f"    curl http://localhost:{port}/v1/chat/completions \\")
    console.print(f'      -H "Content-Type: application/json" \\')
    console.print(
        f"      -d '{{\"model\":\"{model_name}\",\"messages\":"
        f"[{{\"role\":\"user\",\"content\":\"hello\"}}]}}'"
    )
    console.print(f"\n  Press Ctrl+C to stop.\n")


# ═══════════════════════════════════════════════════════════════════════
# Textual Base Classes and Compound Widgets
# ═══════════════════════════════════════════════════════════════════════


class MyModelApp(App):
    """Base Textual app with MyModel theme pre-registered."""

    ENABLE_COMMAND_PALETTE = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.register_theme(MYMODEL_THEME)
        self.theme = "mymodel"


# ── Compound Widgets ─────────────────────────────────────────────────

class LabeledInput(Vertical):
    """Compound widget: Label + Input."""

    DEFAULT_CSS = """
    LabeledInput {
        height: auto;
        margin-bottom: 1;
    }
    LabeledInput Label {
        margin-bottom: 0;
        color: $text;
    }
    LabeledInput Input {
        margin-top: 0;
    }
    """

    def __init__(
        self,
        label: str,
        input_id: str,
        placeholder: str = "",
        value: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._label_text = label
        self._input_id = input_id
        self._placeholder = placeholder
        self._value = value

    def compose(self) -> ComposeResult:
        yield Label(self._label_text)
        yield Input(
            placeholder=self._placeholder,
            value=self._value,
            id=self._input_id,
        )

    @property
    def input(self) -> Input:
        return self.query_one(f"#{self._input_id}", Input)

    @property
    def value(self) -> str:
        return self.input.value


class LabeledRadioSet(Vertical):
    """Compound widget: Label + RadioSet with ●/○ circles."""

    DEFAULT_CSS = """
    LabeledRadioSet {
        height: auto;
        margin-bottom: 1;
    }
    LabeledRadioSet Label {
        margin-bottom: 0;
        color: $text;
    }
    """

    def __init__(
        self,
        label: str,
        options: list[tuple[str, str]],
        radio_set_id: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._label_text = label
        self._options = options  # list of (display_text, value)
        self._radio_set_id = radio_set_id

    def compose(self) -> ComposeResult:
        yield Label(self._label_text)
        rs = RadioSet(
            *[RadioButton(text) for text, _ in self._options],
            id=self._radio_set_id or None,
        )
        yield rs

    @property
    def radio_set(self) -> RadioSet:
        return self.query_one(RadioSet)

    @property
    def selected_value(self) -> Optional[str]:
        rs = self.radio_set
        idx = rs.pressed_index
        if idx < 0 or idx >= len(self._options):
            return None
        return self._options[idx][1]

    @property
    def selected_label(self) -> Optional[str]:
        rs = self.radio_set
        idx = rs.pressed_index
        if idx < 0 or idx >= len(self._options):
            return None
        return self._options[idx][0]


class LabeledSelectionList(Vertical):
    """Compound widget: Label + SelectionList (multi-select)."""

    DEFAULT_CSS = """
    LabeledSelectionList {
        height: auto;
        margin-bottom: 1;
    }
    LabeledSelectionList Label {
        margin-bottom: 0;
        color: $text;
    }
    LabeledSelectionList SelectionList {
        height: auto;
        max-height: 16;
    }
    """

    def __init__(
        self,
        label: str,
        items: list[tuple[str, str]],
        selection_list_id: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._label_text = label
        self._items = items  # list of (display_text, value)
        self._sl_id = selection_list_id

    def compose(self) -> ComposeResult:
        yield Label(self._label_text)
        yield SelectionList(
            *[(text, val) for text, val in self._items],
            id=self._sl_id or None,
        )

    @property
    def selection_list(self) -> SelectionList:
        return self.query_one(SelectionList)

    @property
    def selected_values(self) -> list[str]:
        return list(self.selection_list.selected)


# ── Wizard Screen Base ───────────────────────────────────────────────

class WizardScreen(Screen):
    """Base screen for multi-step wizard with step indicator and navigation."""

    BINDINGS = [
        Binding("escape", "go_back", "Back"),
        Binding("enter", "go_next", "Next", show=True),
    ]

    step: int = 0
    total_steps: int = 0
    step_title: str = ""

    DEFAULT_CSS = """
    WizardScreen {
        layout: vertical;
    }
    WizardScreen .step-indicator {
        dock: top;
        height: 3;
        content-align: center middle;
        background: $surface;
        color: $text;
        padding: 0 2;
    }
    WizardScreen .step-indicator .step-title {
        text-style: bold;
        color: $primary;
    }
    WizardScreen .body {
        height: 1fr;
        padding: 1 2;
        overflow-y: auto;
    }
    WizardScreen .nav-bar {
        dock: bottom;
        height: 3;
        layout: horizontal;
        content-align: center middle;
        padding: 0 2;
        background: $surface;
    }
    WizardScreen .nav-bar Button {
        margin: 0 1;
    }
    """

    def compose(self) -> ComposeResult:
        with Horizontal(classes="step-indicator"):
            dots = ""
            for i in range(1, self.total_steps + 1):
                if i == self.step:
                    dots += f"[bold {ACCENT}]●[/bold {ACCENT}] "
                elif i < self.step:
                    dots += f"[bold {SUCCESS}]●[/bold {SUCCESS}] "
                else:
                    dots += "○ "
            yield Static(
                f"{dots}  Step {self.step}/{self.total_steps} — {self.step_title}",
                classes="step-title",
            )
        with Vertical(classes="body"):
            yield from self.compose_body()
        with Horizontal(classes="nav-bar"):
            yield from self.compose_nav()
        yield Footer()

    def compose_body(self) -> ComposeResult:
        """Override in subclasses to provide screen content."""
        yield Static("Override compose_body()")

    def compose_nav(self) -> ComposeResult:
        """Navigation buttons. Override to customize."""
        if self.step > 1:
            yield Button("← Back", variant="default", id="btn-back")
        yield Button("Next →", variant="primary", id="btn-next")

    def action_go_back(self) -> None:
        if self.step > 1:
            self.app.pop_screen()

    def action_go_next(self) -> None:
        self.save_data()
        self.go_next()

    def save_data(self) -> None:
        """Override to save screen data to app.wizard_data before navigating."""
        pass

    def go_next(self) -> None:
        """Override to push the next screen."""
        pass

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-back":
            self.action_go_back()
        elif event.button.id == "btn-next":
            self.action_go_next()


# ── Confirm Dialog ───────────────────────────────────────────────────

class ConfirmDialog(ModalScreen[bool]):
    """Reusable Yes/No confirmation modal."""

    DEFAULT_CSS = """
    ConfirmDialog {
        align: center middle;
    }
    ConfirmDialog #dialog {
        width: 60;
        height: auto;
        border: thick $accent;
        background: $surface;
        padding: 1 2;
    }
    ConfirmDialog #dialog Static {
        width: 100%;
        content-align: center middle;
        margin-bottom: 1;
    }
    ConfirmDialog #dialog .buttons {
        layout: horizontal;
        content-align: center middle;
        height: 3;
    }
    ConfirmDialog #dialog .buttons Button {
        margin: 0 1;
    }
    """

    BINDINGS = [
        Binding("y", "confirm", "Yes"),
        Binding("n", "cancel", "No"),
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, message: str, **kwargs):
        super().__init__(**kwargs)
        self._message = message

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Static(self._message)
            with Horizontal(classes="buttons"):
                yield Button("Yes", variant="primary", id="yes")
                yield Button("No", variant="default", id="no")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "yes")

    def action_confirm(self) -> None:
        self.dismiss(True)

    def action_cancel(self) -> None:
        self.dismiss(False)


# ── Model Picker Dialog ─────────────────────────────────────────────

class ModelPickerDialog(ModalScreen[Optional[str]]):
    """Async model fetch + selection modal.

    Uses @work(thread=True) to fetch models in background.
    Shows LoadingIndicator while fetching, then Select or fallback Input.
    """

    DEFAULT_CSS = """
    ModelPickerDialog {
        align: center middle;
    }
    ModelPickerDialog #picker {
        width: 70;
        height: auto;
        max-height: 30;
        border: thick $accent;
        background: $surface;
        padding: 1 2;
    }
    ModelPickerDialog #picker .title-label {
        text-style: bold;
        color: $primary;
        margin-bottom: 1;
    }
    ModelPickerDialog #picker LoadingIndicator {
        height: 3;
    }
    ModelPickerDialog #picker #model-select {
        width: 100%;
        margin-bottom: 1;
    }
    ModelPickerDialog #picker #manual-input {
        width: 100%;
        margin-bottom: 1;
    }
    ModelPickerDialog #picker .buttons {
        layout: horizontal;
        content-align: center middle;
        height: 3;
    }
    ModelPickerDialog #picker .buttons Button {
        margin: 0 1;
    }
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(
        self,
        provider_name: str,
        base_url: str,
        api_key: str = "",
        provider_type: str = "openai-compatible",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._provider_name = provider_name
        self._base_url = base_url
        self._api_key = api_key
        self._provider_type = provider_type
        self._models: list[str] = []
        self._fetched = False

    def compose(self) -> ComposeResult:
        with Vertical(id="picker"):
            yield Label(
                f"Select model from {self._provider_name}",
                classes="title-label",
            )
            yield LoadingIndicator(id="loader")
            yield Select(
                [],
                prompt="Select a model...",
                id="model-select",
            )
            yield Input(
                placeholder="Enter model name manually",
                id="manual-input",
            )
            with Horizontal(classes="buttons"):
                yield Button("OK", variant="primary", id="ok")
                yield Button("Cancel", variant="default", id="cancel")

    def on_mount(self) -> None:
        self.query_one("#model-select", Select).display = False
        self.query_one("#manual-input", Input).display = False
        self._fetch_models()

    @work(thread=True)
    def _fetch_models(self) -> None:
        models = fetch_provider_models(
            self._base_url,
            self._api_key,
            self._provider_type,
        )
        self.app.call_from_thread(self._on_models_fetched, models)

    def _on_models_fetched(self, models: list[str]) -> None:
        self._models = models
        self._fetched = True
        self.query_one("#loader", LoadingIndicator).display = False

        if models:
            select = self.query_one("#model-select", Select)
            options = [(m, m) for m in models] + [("(enter manually)", "__manual__")]
            select.set_options(options)
            select.display = True
            select.focus()
        else:
            manual = self.query_one("#manual-input", Input)
            manual.display = True
            manual.focus()

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.value == "__manual__":
            self.query_one("#model-select", Select).display = False
            manual = self.query_one("#manual-input", Input)
            manual.display = True
            manual.focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "ok":
            self._submit()
        elif event.button.id == "cancel":
            self.dismiss(None)

    def _submit(self) -> None:
        manual = self.query_one("#manual-input", Input)
        if manual.display and manual.value.strip():
            self.dismiss(manual.value.strip())
            return
        select = self.query_one("#model-select", Select)
        if select.display and select.value and select.value != Select.BLANK:
            if select.value == "__manual__":
                # Switch to manual
                select.display = False
                manual.display = True
                manual.focus()
                return
            self.dismiss(str(select.value))
            return
        # Nothing selected yet
        self.notify("Please select or enter a model name", severity="warning")

    def action_cancel(self) -> None:
        self.dismiss(None)
