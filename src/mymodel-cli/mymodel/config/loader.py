"""MyModel configuration loader — load, save, validate config.yaml."""

import copy
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from pydantic import BaseModel, ConfigDict, field_validator


# ── Helpers ───────────────────────────────────────────────────────────

_ENV_VAR_RE = re.compile(r"\$\{([^}]+)\}")


def resolve_env_vars(s: str) -> str:
    """Replace ${VAR} with environment value; leave unresolved if not set."""
    def _replace(m):
        var = m.group(1)
        return os.environ.get(var, m.group(0))
    return _ENV_VAR_RE.sub(_replace, s)


def mask_secret(s: str) -> str:
    """Mask a secret string, showing only the last 4 chars."""
    if not s or len(s) <= 4 or s.startswith("${"):
        return s
    return "****" + s[-4:]


# ── Pydantic Models ──────────────────────────────────────────────────

class ModelIdentity(BaseModel):
    """Virtual model identity exposed to clients."""
    name: str = "MyModel"
    description: str = ""


class ProviderEntry(BaseModel):
    """An LLM provider backend."""
    type: str = "openai-compatible"
    base_url: str = ""
    api_key: str = ""


class ModalityRoute(BaseModel):
    """Routes a modality (image/audio/video) to a provider + model."""
    provider: str
    model: str


class TextRouteSignals(BaseModel):
    """Signals for a text route — keywords and/or domains."""
    model_config = ConfigDict(extra="allow")
    keywords: List[str] = []
    domains: List[str] = []


class TextRoute(BaseModel):
    """A text routing rule."""
    name: str
    priority: int = 50
    signals: TextRouteSignals = TextRouteSignals()
    operator: str = "OR"
    provider: str = ""
    model: str = ""


class PluginConfig(BaseModel):
    """Generic plugin configuration."""
    model_config = ConfigDict(extra="allow")
    enabled: bool = False
    action: str = ""


class ServerConfig(BaseModel):
    """Server settings."""
    port: int = 8000
    cors: str = ""

    @field_validator("cors", mode="before")
    @classmethod
    def _coerce_cors(cls, v):
        if v is True:
            return "*"
        if v is False:
            return ""
        return v


class ClassifierConfig(BaseModel):
    """Classifier configuration (pass-through to Go router)."""
    model_config = ConfigDict(extra="allow")


class MyModelConfig(BaseModel):
    """
    Root configuration for the MyModel proxy layer.

    Silently ignores vLLM SR-specific keys (decisions, categories, etc.)
    so that both layers can share a single config.yaml.
    """
    model_config = ConfigDict(extra="ignore")

    model: ModelIdentity = ModelIdentity()
    providers: Dict[str, ProviderEntry] = {}
    modality_routes: Dict[str, ModalityRoute] = {}
    text_routes: List[TextRoute] = []
    server: ServerConfig = ServerConfig()
    plugins: Dict[str, PluginConfig] = {}
    classifier: ClassifierConfig = ClassifierConfig()

    # ── Load / Save ──────────────────────────────────────────────

    @classmethod
    def load(cls, path: str | Path) -> "MyModelConfig":
        """Load config from a YAML file."""
        path = Path(path)
        with open(path) as f:
            raw = yaml.safe_load(f) or {}
        normalized = _from_raw(raw)
        return cls.model_validate(normalized)

    def save(self, path: str | Path) -> None:
        """Save config to a YAML file."""
        path = Path(path)
        data = self.model_dump(exclude_none=True)
        # Flatten server.port back to server_port for Go compatibility
        server = data.pop("server", {})
        if server.get("port") and server["port"] != 8000:
            data["server_port"] = server["port"]
        elif server.get("port"):
            data["server_port"] = server["port"]
        # Remove empty classifier
        if not data.get("classifier"):
            data.pop("classifier", None)
        # Convert text_routes signals back to dicts
        for route in data.get("text_routes", []):
            signals = route.get("signals", {})
            # Remove empty signal lists
            if not signals.get("keywords"):
                signals.pop("keywords", None)
            if not signals.get("domains"):
                signals.pop("domains", None)
            if not signals:
                route.pop("signals", None)
        with open(path, "w") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

    # ── Helpers ──────────────────────────────────────────────────

    def resolve_secrets(self) -> "MyModelConfig":
        """Return a deep copy with all ${VAR} in api_keys resolved."""
        cfg = copy.deepcopy(self)
        for provider in cfg.providers.values():
            provider.api_key = resolve_env_vars(provider.api_key)
        return cfg

    def masked_dict(self) -> dict:
        """Return model_dump with api_keys masked for display."""
        data = self.model_dump(exclude_none=True)
        for prov in data.get("providers", {}).values():
            if prov.get("api_key"):
                prov["api_key"] = mask_secret(prov["api_key"])
        return data

    def validate_providers_in_routes(self) -> List[str]:
        """Check that all providers referenced in routes actually exist."""
        errors = []
        provider_names = set(self.providers.keys())

        for route in self.text_routes:
            if route.provider and route.provider not in provider_names:
                errors.append(
                    f"Text route '{route.name}' references unknown provider '{route.provider}'"
                )

        for modality, mod_route in self.modality_routes.items():
            if mod_route.provider not in provider_names:
                errors.append(
                    f"Modality route '{modality}' references unknown provider '{mod_route.provider}'"
                )

        return errors

    def get_routes_for_provider(self, provider_name: str) -> List[str]:
        """Return route names that use a given provider."""
        routes = []
        for route in self.text_routes:
            if route.provider == provider_name:
                routes.append(route.name)
        for modality, mod_route in self.modality_routes.items():
            if mod_route.provider == provider_name:
                routes.append(f"modality:{modality}")
        return routes


def _from_raw(raw: dict) -> dict:
    """Normalize raw YAML dict into the shape MyModelConfig expects."""
    data = dict(raw)

    # server_port (flat) → server.port (nested)
    if "server_port" in data and "server" not in data:
        data["server"] = {"port": data.pop("server_port")}
    elif "server_port" in data:
        data.setdefault("server", {})["port"] = data.pop("server_port")

    # Ensure signals in text_routes are dicts
    for route in data.get("text_routes", []):
        if isinstance(route.get("signals"), str):
            route["signals"] = {}

    return data
